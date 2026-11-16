import { createHash, randomUUID } from "node:crypto";
import type { Capture, InputQuestion, Job, Overview, PracticeSession, StoreState, Submission } from "../lib/types";
import { TAGS, isTag } from "../lib/tags";
import { isBlankAnswer, preserveStudentAnswer, studentAnswerStatus } from "../lib/answers";
import { authenticate, checkOrigin } from "./auth";
import { AppError, assert, config } from "./config";
import { imageNormalizer } from "./files";
import { matchSample, newJob, notifyJob } from "./jobs";
import { fixedScheduler, gradeAnswer, publicSession, rebuildReviewTasks } from "./learning";
import { getSample, sampleSummaries } from "./samples";
import { readImage, readState, saveImage, updateState } from "./store";

type Json = Record<string, unknown>;
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
async function body(request: Request): Promise<Json> {
  const text = await request.text();
  assert(text.length <= 1_000_000, "请求内容过大", 413);
  try { const value = JSON.parse(text); assert(value && typeof value === "object" && !Array.isArray(value), "请求格式无效"); return value; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError("JSON 格式无效"); }
}
function text(value: unknown, name: string, max = 200): string {
  assert(typeof value === "string" && value.length <= max, `${name}格式无效`);
  return value;
}
function requestKey(value: unknown) { const key = text(value, "请求标识", 100); assert(key.trim().length >= 8, "请求标识太短"); return key; }
function previous(state: StoreState, userId: string, key: string, kind: string, inputHash: string) {
  const entry = state.requests.find(item => item.userId === userId && item.key === key && item.kind === kind);
  if (!entry) return undefined;
  assert(entry.hash === inputHash, "相同请求标识对应不同内容，请刷新后重试。", 409, "IDEMPOTENCY_CONFLICT");
  return entry.resourceId;
}
function remember(state: StoreState, userId: string, key: string, kind: string, inputHash: string, resourceId: string) {
  state.requests.push({ userId, key, kind, hash: inputHash, resourceId });
}
function questions(value: unknown, current?: InputQuestion[]): InputQuestion[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 20, "请提供 1—20 道小题");
  const result = value.map((item: Json) => {
    assert(item && typeof item === "object" && !Array.isArray(item), "小题格式无效");
    const number = text(item.number, "题号", 10);
    assert(/^\d{1,3}$/.test(number), "题号应为数字");
    const existing = current?.find(question => question.id === item.id);
    const studentAnswer = text(item.studentAnswer ?? "", "作答", 200);
    if (item.answerStatus !== undefined) assert(["answered", "blank", "uncertain"].includes(item.answerStatus as string), "作答状态无效");
    const manuallyEdited = item.answerOrigin === "manual" || !existing || (item.answerStatus === undefined && studentAnswer !== existing.studentAnswer);
    const answerStatus = manuallyEdited ? studentAnswerStatus({ studentAnswer }) : item.answerStatus as InputQuestion["answerStatus"] ?? existing?.answerStatus;
    return preserveStudentAnswer({
      id: existing?.id || randomUUID(), number, cue: text(item.cue ?? "", "提示词", 100), studentAnswer,
      answerStatus, answerOrigin: manuallyEdited ? "manual" : existing?.answerOrigin,
      ...(!manuallyEdited && studentAnswer === existing?.studentAnswer && existing?.answerEvidence ? { answerEvidence: existing.answerEvidence } : {}),
    });
  });
  assert(new Set(result.map(item => item.number)).size === result.length, "题号不能重复");
  assert(new Set(result.map(item => item.id)).size === result.length, "小题标识不能重复");
  return result;
}
async function announce(userId: string, targetId: string) {
  const state = await readState(userId);
  for (const job of state.jobs.filter(item => item.targetId === targetId && item.status === "queued")) await notifyJob(job);
}
export async function handleApi(request: Request): Promise<Response> {
  let cookie: string | undefined;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) } });
  try {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = request.method;
    if (!["GET", "HEAD"].includes(method)) checkOrigin(request);
    if (route.join("/") === "config" && method === "GET") return json(config());
    if (route.join("/") === "samples" && method === "GET") return json(await sampleSummaries());
    const auth = await authenticate(request); cookie = auth.cookie;
    const userId = auth.userId;
    if (route.join("/") === "me/overview" && method === "GET") {
      const state = await readState(userId);
      const byTag = new Map<string, number>();
      const bySource = { sample: 0, ai: 0, published: 0 };
      let incorrect = 0;
      for (const submission of state.submissions.filter(item => item.status === "completed")) for (const question of submission.questions) if (question.gradeStatus === "incorrect" && !question.disputed) { incorrect++; byTag.set(question.tagId, (byTag.get(question.tagId) || 0) + 1); bySource[submission.mode === "sample" ? "sample" : question.answerSource === "ai" ? "ai" : "published"]++; }
      const reviewTasks = state.reviewTasks.filter(item => item.status === "pending").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      const overview: Overview = {
        submissions: state.submissions.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)), reviewTasks,
        sessions: state.sessions.map(item => ({ ...publicSession(item), items: [] })).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
        stats: { submissions: state.submissions.filter(item => item.status === "completed").length, incorrect, practiced: state.sessions.reduce((count, session) => count + session.results.length, 0), due: reviewTasks.filter(item => item.dueAt <= new Date().toISOString()).length, byTag: [...byTag].map(([tagId, count]) => ({ tagId, count })), bySource },
        config: config(), tags: TAGS, samples: await sampleSummaries(),
      };
      return json(overview);
    }
    if (route[0] === "captures") {
      if (route.length === 1 && method === "POST") {
        let capture: Capture;
        let bytes: Buffer | undefined;
        let key: string;
        let inputHash: string;
        const id = randomUUID();
        if (request.headers.get("content-type")?.includes("multipart/form-data")) {
          assert(!request.headers.get("content-length") || Number(request.headers.get("content-length")) <= 11 * 1024 * 1024, "文件不能超过 10 MB", 413);
          const data = await request.formData();
          const file = data.get("image");
          assert(file instanceof File, "请选择一张 JPG 或 PNG 图片");
          key = requestKey(data.get("clientRequestId"));
          assert(file.size <= 10 * 1024 * 1024, "文件不能超过 10 MB", 413);
          assert(config().aiConfigured, "请先在 .env.local 配置 DEEPSEEK_API_KEY 并重启；当前可体验真题样例回放。", 503, "CONFIG_REQUIRED");
          bytes = await imageNormalizer.normalize(Buffer.from(await file.arrayBuffer()), file.type);
          inputHash = hash(bytes.toString("base64"));
          capture = { id, userId, version: 1, title: "新的语法填空", passage: "", questions: [], warnings: [], status: "queued", stage: "图片已上传，等待识别", createdAt: new Date().toISOString(), mode: "live" };
        } else {
          const input = await body(request);
          assert(config().sampleMode, "样例模式未启用", 403);
          const sampleId = text(input.sampleId, "样例标识");
          key = requestKey(input.clientRequestId); inputHash = hash({ sampleId });
          const sample = await getSample(sampleId);
          capture = { id, userId, version: 1, title: sample.title, passage: sample.passage, questions: sample.questions.map(question => preserveStudentAnswer({ id: randomUUID(), number: question.number, cue: question.cue, studentAnswer: question.studentAnswer, answerOrigin: "sample" as const })), warnings: [sample.studentAnswerNote, "当前为样例回放，未调用 DeepSeek。参考答案为公开资料交叉核对，尚未教师复核。"], sampleId, status: "completed", stage: "请核对样例题面与模拟作答", createdAt: new Date().toISOString(), mode: "sample" };
        }
        const existing = previous(await readState(userId), userId, key, "capture", inputHash);
        if (existing) return json((await readState(userId)).captures.find(item => item.id === existing));
        if (bytes) capture.imagePath = await saveImage(userId, id, bytes);
        const saved = await updateState(userId, state => {
          const previousId = previous(state, userId, key, "capture", inputHash);
          if (previousId) return state.captures.find(item => item.id === previousId)!;
          state.captures.push(capture); remember(state, userId, key, "capture", inputHash, capture.id);
          if (capture.mode === "live") state.jobs.push(newJob(userId, "recognize", id));
          return capture;
        });
        await announce(userId, saved.id); return json(saved, saved.status === "queued" ? 202 : 201);
      }
      const capture = (await readState(userId)).captures.find(item => item.id === route[1]);
      assert(capture, "采集记录不存在", 404);
      if (route[2] === "image" && method === "GET") {
        assert(capture.imagePath, "此样例没有上传图片", 404);
        return new Response(new Uint8Array(await readImage(capture.imagePath)), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) } });
      }
      if (route.length === 2 && method === "GET") return json(capture);
      if (route.length === 2 && method === "PATCH") {
        const input = await body(request);
        const updated = await updateState(userId, state => {
          const item = state.captures.find(entry => entry.id === capture.id)!;
          assert(item.version === input.expectedVersion, "草稿已更新，请刷新后重试", 409, "VERSION_CONFLICT");
          assert(item.status === "completed" || item.status === "needs_input", "请等待识别完成");
          item.title = text(input.title, "标题", 200).trim() || "英语语法填空";
          item.passage = text(input.passage, "完整题面", 20000).trim(); assert(item.passage.length >= 10, "请填写完整题面");
          item.questions = questions(input.questions, item.questions); item.version++;
          return item;
        });
        return json(updated);
      }
      if (["retry", "extract"].includes(route[2]) && method === "POST") {
        await retry(userId, "recognize", capture.id); return json((await readState(userId)).captures.find(item => item.id === capture.id), 202);
      }
    }
    if (route[0] === "submissions") {
      if (route.length === 1 && method === "POST") {
        const input = await body(request); const key = requestKey(input.clientRequestId); const inputHash = hash({ captureId: input.captureId, inputVersion: input.inputVersion });
        const state = await readState(userId);
        const prior = previous(state, userId, key, "submission", inputHash);
        if (prior) return json(state.submissions.find(item => item.id === prior));
        const capture = state.captures.find(item => item.id === input.captureId);
        assert(capture, "采集草稿不存在", 404); assert(capture.status === "completed", "请先完成题面识别与确认", 422);
        assert(capture.version === input.inputVersion, "草稿已更新，请重新确认后提交", 409, "VERSION_CONFLICT");
        assert(capture.questions.length && capture.passage.length >= 10, "请补充完整题目", 422);
        const sample = await matchSample(capture);
        assert(capture.mode !== "sample" || sample, "样例回放只支持原题面与提示词；你可以修改模拟作答。新题面需要使用真实图片和 DeepSeek。", 422);
        const created = await updateState(userId, current => {
          const existing = previous(current, userId, key, "submission", inputHash);
          if (existing) return current.submissions.find(item => item.id === existing)!;
          const fresh = current.captures.find(item => item.id === capture.id);
          assert(fresh && fresh.version === input.inputVersion && fresh.status === "completed", "草稿已更新，请重新确认后提交", 409, "VERSION_CONFLICT");
          const duplicate = current.submissions.find(item => item.captureId === capture.id && item.inputVersion === capture.version);
          if (duplicate) { remember(current, userId, key, "submission", inputHash, duplicate.id); return duplicate; }
          const submission: Submission = { id: randomUUID(), userId, captureId: capture.id, inputVersion: capture.version, title: capture.title, passage: capture.passage, status: "queued", stage: "等待诊断", mode: capture.mode, sampleId: sample?.id, createdAt: new Date().toISOString(), questions: capture.questions.map(question => ({ ...question, id: randomUUID(), referenceAnswers: [], answerSource: "ai", gradeStatus: "uncertain", maxScore: null, score: null, tagId: "unclassified", errorPattern: "", possibleCause: "", explanation: { rule: "", evidence: "", why: "", example: "" }, diagnosisVersion: 1, explanationStatus: "pending", disputed: false })) };
          current.submissions.push(submission); current.jobs.push(newJob(userId, "diagnose", submission.id)); remember(current, userId, key, "submission", inputHash, submission.id); return submission;
        });
        await announce(userId, created.id); return json(created, created.status === "completed" ? 200 : 202);
      }
      const submission = (await readState(userId)).submissions.find(item => item.id === route[1]); assert(submission, "诊断记录不存在", 404);
      if (route.length === 2 && method === "GET") return json(submission);
      if (route[2] === "retry" && method === "POST") {
        const failedExplanations = (await readState(userId)).jobs.filter(job => job.targetId === submission.id && job.kind === "explain" && job.status === "failed");
        if (failedExplanations.length && submission.status === "completed") {
          await updateState(userId, state => { for (const job of state.jobs) if (failedExplanations.some(item => item.id === job.id)) { job.status = "queued"; job.attempts = 0; job.updatedAt = new Date().toISOString(); } });
          await announce(userId, submission.id);
        } else await retry(userId, "diagnose", submission.id);
        return json((await readState(userId)).submissions.find(item => item.id === submission.id), 202);
      }
    }
    if (route[0] === "questions" && route[2] === "diagnosis" && method === "PATCH") {
      const input = await body(request);
      if (input.tagId !== undefined) assert(typeof input.tagId === "string" && isTag(input.tagId), "请选择有效的语法标签");
      if (input.disputed !== undefined) assert(typeof input.disputed === "boolean", "争议状态无效");
      const updated = await updateState(userId, state => {
        const submission = state.submissions.find(item => item.questions.some(question => question.id === route[1])); assert(submission, "题目不存在", 404);
        const question = submission.questions.find(item => item.id === route[1])!;
        assert(submission.status === "completed", "请等待诊断完成"); assert(question.diagnosisVersion === input.expectedVersion, "诊断已更新，请刷新后重试", 409, "VERSION_CONFLICT");
        const oldTag = question.tagId;
        const changedTag = input.tagId !== undefined && input.tagId !== oldTag;
        if (input.tagId !== undefined) question.tagId = input.tagId as string;
        if (input.disputed !== undefined) question.disputed = input.disputed as boolean;
        question.diagnosisVersion++;
        state.tagEvents.push({ id: randomUUID(), userId, questionId: question.id, submissionId: submission.id, previousTagId: oldTag, tagId: question.tagId, version: question.diagnosisVersion, note: text(input.note ?? "", "说明", 1000), createdAt: new Date().toISOString() });
        if (changedTag || question.explanationStatus === "pending") {
          question.explanationStatus = "pending";
          state.jobs.push(newJob(userId, "explain", submission.id, { questionId: question.id, version: question.diagnosisVersion }));
        }
        rebuildReviewTasks(state, userId); return submission;
      });
      await announce(userId, updated.id); return json(updated);
    }
    if (route[0] === "review" && route[1] === "sessions") {
      if (route.length === 2 && method === "POST") {
        const input = await body(request); const key = requestKey(input.clientRequestId); const inputHash = hash({ tagId: input.tagId, sourceQuestionId: input.sourceQuestionId, sourceSubmissionId: input.sourceSubmissionId, reviewTaskId: input.reviewTaskId, mode: input.mode });
        const session = await updateState(userId, state => {
          const oldId = previous(state, userId, key, "session", inputHash);
          if (oldId) return state.sessions.find(item => item.id === oldId)!;
          const task = input.reviewTaskId ? state.reviewTasks.find(item => item.id === input.reviewTaskId && item.status === "pending") : undefined;
          if (input.reviewTaskId) assert(task, "复习任务不存在或已完成", 404);
          const sourceSubmissionId = task?.sourceSubmissionId || input.sourceSubmissionId as string | undefined;
          const submission = sourceSubmissionId ? state.submissions.find(item => item.id === sourceSubmissionId) : undefined;
          if (sourceSubmissionId) assert(submission, "来源记录不存在", 404);
          const sourceQuestionId = task?.sourceQuestionId || input.sourceQuestionId as string | undefined;
          const source = sourceQuestionId ? submission?.questions.find(item => item.id === sourceQuestionId) : undefined;
          if (sourceQuestionId) assert(source, "来源错题不存在", 404);
          const tagId = task?.tagId || input.tagId as string || source?.tagId || state.reviewTasks.find(item => item.status === "pending")?.tagId || "relative-clause";
          assert(isTag(tagId), "请选择有效标签");
          const mode = submission?.mode || (input.mode === "sample" || !config().aiConfigured ? "sample" : "live");
          assert(mode !== "sample" || config().sampleMode, "请先配置 DeepSeek", 503, "CONFIG_REQUIRED");
          const active = state.sessions.find(item => item.tagId === tagId && !item.completedAt && item.status !== "failed" && item.mode === mode);
          if (active) { remember(state, userId, key, "session", inputHash, active.id); return active; }
          const created: PracticeSession = { id: randomUUID(), userId, tagId, sourceSubmissionId, sourceQuestionId, reviewTaskId: task?.id, status: "queued", items: [], results: [], createdAt: new Date().toISOString(), mode, ...(mode === "sample" ? { sampleLabel: "本地演示练习 · 非高考真题 · 非即时 AI" } : {}) };
          state.sessions.push(created); state.jobs.push(newJob(userId, "practice", created.id)); remember(state, userId, key, "session", inputHash, created.id); return created;
        });
        await announce(userId, session.id); return json(publicSession(session), 202);
      }
      const session = (await readState(userId)).sessions.find(item => item.id === route[2]); assert(session, "练习会话不存在", 404);
      if (route.length === 3 && method === "GET") return json(publicSession(session));
      if (route[3] === "retry" && method === "POST") { await retry(userId, "practice", session.id); return json(publicSession((await readState(userId)).sessions.find(item => item.id === session.id)!), 202); }
      if (route[3] === "attempts" && method === "POST") {
        const input = await body(request); const key = requestKey(input.clientRequestId); const inputHash = hash({ sessionId: session.id, responses: input.responses });
        const finished = await updateState(userId, state => {
          const item = state.sessions.find(entry => entry.id === session.id)!;
          const oldId = previous(state, userId, key, "attempt", inputHash);
          if (oldId) return item;
          assert(item.status === "completed" && item.items.length === 3, "请等待练习生成完成", 422);
          if (item.completedAt) return item;
          assert(Array.isArray(input.responses) && input.responses.length === item.items.length, "请提交全部题目的作答记录，未作答的题可留空。", 422);
          const responses = input.responses as Json[];
          assert(new Set(responses.map(value => value.itemId)).size === item.items.length && responses.every(value => item.items.some(question => question.id === value.itemId)), "练习题号不完整", 422);
          item.results = item.items.map(question => {
            const supplied = text(responses.find(value => value.itemId === question.id)!.response, "作答", 200);
            const response = isBlankAnswer(supplied) ? "" : supplied;
            return { itemId: question.id, response, correct: gradeAnswer(response, question.answers) === "correct", answers: question.answers, explanation: question.explanation };
          });
          item.completedAt = new Date().toISOString();
          const currentSource = item.sourceQuestionId ? state.submissions.find(value => value.id === item.sourceSubmissionId)?.questions.find(value => value.id === item.sourceQuestionId) : undefined;
          const eligible = !item.sourceQuestionId || (currentSource && !currentSource.disputed && currentSource.tagId === item.tagId);
          if (eligible) {
            const task = state.reviewTasks.find(value => value.tagId === item.tagId && value.status === "pending") || state.reviewTasks.find(value => value.id === item.reviewTaskId);
            const schedule = fixedScheduler.nextDue(task?.level || 0, item.results.every(value => value.correct));
            if (task) task.status = "completed";
            for (const duplicate of state.reviewTasks.filter(value => value.tagId === item.tagId && value.status === "pending")) duplicate.status = "completed";
            state.reviewTasks.push({ id: randomUUID(), userId, tagId: item.tagId, sourceQuestionId: item.sourceQuestionId || task?.sourceQuestionId || "", sourceSubmissionId: item.sourceSubmissionId || task?.sourceSubmissionId || "", status: "pending", tentative: true, ...schedule });
            item.nextDueAt = schedule.dueAt;
          }
          remember(state, userId, key, "attempt", inputHash, item.id); return item;
        });
        return json(publicSession(finished));
      }
    }
    throw new AppError("接口不存在", 404, "NOT_FOUND");
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message, code: error.code }, error.status);
    console.error("api_error", error instanceof Error ? error.message : "unknown");
    return json({ error: "服务暂时未能完成请求，请稍后重试。", code: "INTERNAL_ERROR" }, 500);
  }
}
async function retry(userId: string, kind: Job["kind"], targetId: string) {
  await updateState(userId, state => {
    const resource = kind === "recognize" ? state.captures.find(item => item.id === targetId) : kind === "practice" ? state.sessions.find(item => item.id === targetId) : state.submissions.find(item => item.id === targetId);
    assert(resource, "记录不存在", 404);
    if (resource.status === "queued" || resource.status === "processing") return;
    assert(resource.status === "failed", "该记录无需重试", 422);
    resource.status = "queued"; resource.error = undefined;
    state.jobs.push(newJob(userId, kind, targetId));
  });
  await announce(userId, targetId);
}
