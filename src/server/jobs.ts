import { randomUUID } from "node:crypto";
import type { Capture, Job, QuestionResult, StoreState } from "../lib/types";
import { deepseekAI } from "./ai";
import { AppError, config } from "./config";
import { gradeAnswer, rebuildReviewTasks } from "./learning";
import { getSample, samples } from "./samples";
import { readImage, readState, updateState } from "./store";
import { samplePractice } from "./sample-practice";
import { tagName } from "../lib/tags";

export const newJob = (userId: string, kind: Job["kind"], targetId: string, payload?: Job["payload"]): Job => ({ id: randomUUID(), userId, kind, targetId, payload, status: "queued", attempts: 0, updatedAt: new Date().toISOString() });
const sameText = (a: string, b: string) => a.normalize("NFKC").replace(/\s/g, "") === b.normalize("NFKC").replace(/\s/g, "");
export async function matchSample(capture: Capture) {
  const all = await samples();
  return all.find(sample => sameText(sample.passage, capture.passage) && sample.questions.length === capture.questions.length && sample.questions.every(question => capture.questions.some(item => item.number === question.number && sameText(item.cue, question.cue))));
}
function target(state: StoreState, job: Job) {
  if (job.kind === "recognize") return state.captures.find(item => item.id === job.targetId);
  if (job.kind === "practice") return state.sessions.find(item => item.id === job.targetId);
  return state.submissions.find(item => item.id === job.targetId);
}
export async function processJob(userId: string, jobId: string) {
  const lease = new Date().toISOString();
  const claimed = await updateState(userId, state => {
    const job = state.jobs.find(item => item.id === jobId);
    if (!job || job.status === "completed" || job.status === "failed") return null;
    if (job.status === "processing" && Date.now() - Date.parse(job.updatedAt) < 300000) return null;
    if (Number(job.payload?.retryAt || 0) > Date.now()) return null;
    job.status = "processing"; job.updatedAt = lease; job.attempts++;
    const item = target(state, job);
    if (item && job.kind !== "explain") { item.status = "processing"; item.error = undefined; }
    if (item && "stage" in item && job.kind !== "explain") item.stage = job.kind === "recognize" ? "正在识别题目与作答" : "正在生成逐题诊断与讲解";
    return structuredClone(job);
  });
  if (!claimed) return;
  const commit = async (mutate: (state: StoreState) => void) => updateState(userId, state => {
    const job = state.jobs.find(item => item.id === jobId);
    if (!job || job.status !== "processing" || job.updatedAt !== lease) return;
    mutate(state); job.status = "completed"; job.updatedAt = new Date().toISOString();
  });
  try {
    const state = await readState(userId);
    if (claimed.kind === "recognize") {
      const capture = state.captures.find(item => item.id === claimed.targetId);
      if (!capture) throw new AppError("采集草稿不存在", 404);
      const recognized = await deepseekAI.recognize(await readImage(capture.imagePath!), { userId, targetId: capture.id });
      await commit(current => {
        const item = current.captures.find(item => item.id === capture.id)!;
        Object.assign(item, recognized, { status: "completed", stage: "请核对识别结果", version: item.version + 1 });
      });
    } else if (claimed.kind === "diagnose") {
      const submission = state.submissions.find(item => item.id === claimed.targetId);
      const capture = state.captures.find(item => item.id === submission?.captureId);
      if (!submission || !capture) throw new AppError("题目草稿不存在", 404);
      const sample = await matchSample({ ...capture, passage: submission.passage, questions: submission.questions, version: submission.inputVersion });
      if (submission.mode === "sample" && !sample) throw new AppError("题面已变更，样例回放无法处理新题目。请恢复原题，或配置 DeepSeek 后使用实时诊断。", 422);
      const references = sample ? Object.fromEntries(sample.questions.map(question => [question.number, question.answers])) : undefined;
      const diagnosed = submission.mode === "sample" ? null : await deepseekAI.diagnose({ passage: submission.passage, questions: submission.questions, references }, { userId, targetId: submission.id });
      const results: QuestionResult[] = submission.questions.map(input => {
        const fromSample = sample?.questions.find(question => question.number === input.number);
        const fromAI = diagnosed?.questions.find(question => question.number === input.number);
        const referenceAnswers = fromSample?.answers || fromAI?.referenceAnswers || [];
        const uncertain = (!fromSample && Boolean(fromAI?.uncertain)) || input.studentAnswer.includes("无法辨认");
        const gradeStatus = gradeAnswer(input.studentAnswer, referenceAnswers, uncertain);
        const maxScore = sample?.maxScorePerQuestion ?? null;
        return {
          ...input, referenceAnswers, answerSource: sample ? (sample.verification.status === "reviewed" ? "reviewed" : "published_reference") : "ai",
          gradeStatus, maxScore, score: gradeStatus === "uncertain" || maxScore === null ? null : gradeStatus === "correct" ? maxScore : 0,
          tagId: fromAI?.tagId || fromSample?.tagId || "unclassified", errorPattern: gradeStatus === "correct" ? "与参考答案一致" : fromAI?.errorPattern || (!input.studentAnswer.trim() ? "未作答" : "与参考答案不同"),
          possibleCause: gradeStatus === "correct" ? "本题作答与参考答案一致。" : fromAI?.possibleCause || "可能尚未熟练区分该语境中的结构或词形；需要结合后续练习确认。",
          explanation: fromAI?.explanation || fromSample!.explanation, diagnosisVersion: 1, explanationStatus: "ready", disputed: false,
        };
      });
      await commit(current => {
        const item = current.submissions.find(entry => entry.id === submission.id)!;
        if (item.inputVersion !== submission.inputVersion) return;
        item.questions = results; item.status = "completed"; item.stage = "诊断已完成"; item.completedAt = new Date().toISOString(); item.error = undefined;
        rebuildReviewTasks(current, userId);
      });
    } else if (claimed.kind === "practice") {
      const session = state.sessions.find(item => item.id === claimed.targetId);
      if (!session) throw new AppError("练习不存在", 404);
      const items = session.mode === "sample" ? samplePractice(session.tagId) : await deepseekAI.generatePractice(session.tagId, { userId, targetId: session.id });
      await commit(current => {
        const item = current.sessions.find(entry => entry.id === session.id)!;
        item.items = items; item.status = "completed"; item.error = undefined;
      });
    } else if (claimed.kind === "explain") {
      const submission = state.submissions.find(item => item.id === claimed.targetId);
      const question = submission?.questions.find(item => item.id === claimed.payload?.questionId);
      if (!submission || !question) throw new AppError("题目不存在", 404);
      let explanation = question.explanation;
      if (submission.mode === "live") {
        const result = await deepseekAI.diagnose({ passage: submission.passage, questions: [question], references: { [question.number]: question.referenceAnswers }, preferredTags: { [question.number]: question.tagId } }, { userId, targetId: submission.id });
        explanation = result.questions[0].explanation;
      } else {
        const sample = await getSample(submission.sampleId!);
        const original = sample.questions.find(item => item.number === question.number)!;
        explanation = { ...original.explanation, rule: original.tagId === question.tagId ? original.explanation.rule : `你将个人复习分类调整为「${tagName(question.tagId)}」。原题规则：${original.explanation.rule}` };
      }
      await commit(current => {
        const item = current.submissions.find(entry => entry.id === submission.id)?.questions.find(entry => entry.id === question.id);
        if (item && item.diagnosisVersion === claimed.payload?.version) { item.explanation = explanation; item.explanationStatus = "ready"; }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "处理失败，请重试";
    const retryable = error instanceof AppError && error.code === "MODEL_RETRYABLE" && claimed.attempts < 3;
    await updateState(userId, state => {
      const job = state.jobs.find(item => item.id === jobId);
      if (!job || job.updatedAt !== lease) return;
      job.status = retryable ? "queued" : "failed"; job.error = message; job.updatedAt = new Date().toISOString();
      if (retryable) job.payload = { ...job.payload, retryAt: Date.now() + (claimed.attempts === 1 ? 5000 : 20000) };
      const item = target(state, job);
      if (item && job.kind !== "explain") { item.status = retryable ? "queued" : "failed"; item.error = message; if ("stage" in item) item.stage = retryable ? "服务暂忙，等待自动重试" : "处理未完成"; }
      if (job.kind === "explain") {
        const submission = state.submissions.find(entry => entry.id === job.targetId);
        if (submission) submission.error = "标签已保存，更新讲解暂未完成，可点击重试。";
      }
    });
  }
}

let bossPromise: Promise<import("pg-boss").PgBoss> | undefined;
export const queueName = process.env.WORKER_QUEUE_NAME || "grammar-loop";
export async function getBoss() {
  if (!process.env.DATABASE_URL || config().storage !== "supabase") return null;
  if (!bossPromise) bossPromise = (async () => {
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
    boss.on("error", error => console.error("queue_error", error.message));
    await boss.start(); await boss.createQueue(queueName); return boss;
  })().catch(error => { bossPromise = undefined; throw error; });
  return bossPromise;
}
export async function notifyJob(job: Job) {
  try { const boss = await getBoss(); await boss?.send(queueName, { userId: job.userId, jobId: job.id }, { singletonKey: job.id }); }
  catch { console.error("queue_notification_failed; durable job will be recovered by worker"); }
}
