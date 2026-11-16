import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Capture, InputQuestion, PracticeSession } from "../src/lib/types";

// Do not load .env.local. This process must never reach any real provider.
const directory = await mkdtemp(path.join(os.tmpdir(), "grammar-loop-blank-"));
process.env.LOCAL_DATA_DIR = directory;
process.env.STORAGE_MODE = "local";
process.env.ENABLE_SAMPLE_MODE = "true";
process.env.SESSION_SECRET = "blank-answer-regression-isolated-session";
process.env.DEEPSEEK_BASE_URL = "https://blank-provider.invalid";
for (const key of ["DEEPSEEK_API_KEY", "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_ORIGIN"]) delete process.env[key];
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Unexpected network request in blank-answer tests"); };

const { deepseekAI } = await import("../src/server/ai");
const { handleApi } = await import("../src/server/api");
const { processJob, newJob } = await import("../src/server/jobs");
const { readState, updateState } = await import("../src/server/store");
const { gradeAnswer } = await import("../src/server/learning");
const { preserveStudentAnswer, studentAnswerStatus, isBlankAnswer } = await import("../src/lib/answers");
const { samples } = await import("../src/server/samples");

test.after(async () => {
  globalThis.fetch = originalFetch;
  assert.equal(networkAttempts, 0, "No unmocked network calls are allowed");
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("grammar-loop-blank-"));
  await rm(directory, { recursive: true, force: true });
});

type Provider = (request: { messages: { role: string; content: unknown }[] }) => unknown | Response;
async function withProvider<T>(provider: Provider, action: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "blank-regression-dummy";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://blank-provider.invalid/chat/completions");
    const payload = JSON.parse(init!.body as string);
    const output = provider(payload);
    return output instanceof Response ? output : Response.json({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  try { return await action(); }
  finally { globalThis.fetch = saved; delete process.env.DEEPSEEK_API_KEY; }
}
const context = () => ({ userId: randomUUID(), targetId: randomUUID() });
const explanation = { rule: "主语和动词形式要一致。", evidence: "She", why: "学生写了 goes。", example: "She goes to school." };
function diagnosisFor(input: { questions: { number: string }[] }) {
  return { questions: input.questions.map(question => ({ number: question.number, studentAnswer: "goes", referenceAnswers: ["goes"], tagId: "subject-agreement", errorPattern: "模型猜测的词形错误", possibleCause: "模型擅自判断规则未掌握", uncertain: false, explanation })) };
}
function fixtureQuestion(overrides: Partial<InputQuestion> = {}): InputQuestion {
  return { id: randomUUID(), number: "56", cue: "go", studentAnswer: "", ...overrides };
}
async function apiClient() {
  const first = await handleApi(new Request("http://localhost/api/me/overview"));
  assert.equal(first.status, 200);
  const cookie = first.headers.get("set-cookie")!.split(";")[0];
  const userId = cookie.slice("gl_session=".length).split(".")[0];
  const call = async (route: string, method = "GET", input?: unknown, status = 200) => {
    const response = await handleApi(new Request(`http://localhost/api/${route}`, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }));
    const output = await response.json();
    assert.equal(response.status, status, JSON.stringify(output));
    return output;
  };
  const runQueued = async (targetId: string, kind?: string) => {
    const queued = (await readState(userId)).jobs.filter(job => job.targetId === targetId && job.status === "queued" && (!kind || job.kind === kind));
    assert.ok(queued.length);
    for (const job of queued) await processJob(userId, job.id);
  };
  return { userId, call, runQueued };
}

test("blank markers and legacy records keep their meaning without inventing answers", () => {
  for (const value of ["", " \t\n", "　", "____", "— —", "未作答", "未填写"]) {
    assert.equal(isBlankAnswer(value), true);
    const normalized = preserveStudentAnswer(fixtureQuestion({ studentAnswer: value }));
    assert.equal(normalized.studentAnswer, "");
    assert.equal(normalized.answerStatus, "blank");
    assert.equal(gradeAnswer(value, ["goes"]), "incorrect");
  }
  const legacyAnswer = preserveStudentAnswer(fixtureQuestion({ studentAnswer: "go" }));
  assert.equal(legacyAnswer.studentAnswer, "go", "A real answer equal to the cue is not discarded");
  assert.equal(legacyAnswer.answerStatus, "answered");
  const unknown = preserveStudentAnswer(fixtureQuestion({ studentAnswer: "[无法辨认]" }));
  assert.equal(unknown.studentAnswer, "");
  assert.equal(studentAnswerStatus(unknown), "uncertain", "Unreadable is not an omission");
  assert.equal(gradeAnswer("", [""], false), "uncertain", "Empty answer keys cannot make an empty response correct");
});

test("OCR rejects generated words for blank, unsupported or contradictory observations", async () => {
  const input = { title: "混合识别", passage: "She {{56}} (go). He {{57}} (walk). We {{58}} (be). They {{59}} (go). It {{60}} (be). {{61}} {{62}} {{63}}", hasStudentAnswers: true, warnings: [], questions: [
    { number: "56", cue: "go", studentAnswer: "goes", answerStatus: "blank", answerEvidence: "goes" },
    { number: "57", cue: "walk", studentAnswer: "walks", answerStatus: "answered", answerEvidence: "" },
    { number: "58", cue: "be", studentAnswer: "is", answerStatus: "answered", answerEvidence: "are" },
    { number: "59", cue: "go", studentAnswer: "go", answerStatus: "answered", answerEvidence: "go" },
    { number: "60", cue: "be", studentAnswer: "is", answerStatus: "uncertain", answerEvidence: "is" },
    { number: "61", cue: "", studentAnswer: "" },
    { number: "62", cue: "", studentAnswer: "the" },
    { number: "63", cue: "", studentAnswer: null, answerStatus: "blank", answerEvidence: null },
  ] };
  await withProvider(request => {
    assert.ok(Array.isArray(request.messages[1].content), "Recognition uses the image content array");
    return input;
  }, async () => {
    const result = await deepseekAI.recognize(Buffer.from("mock image"), context());
    assert.equal(result.questions.length, 8, "Blank questions must not be omitted");
    assert.deepEqual(result.questions.map(question => question.studentAnswer), ["", "", "", "go", "", "", "", ""]);
    assert.deepEqual(result.questions.map(question => question.answerStatus), ["blank", "uncertain", "uncertain", "answered", "uncertain", "blank", "uncertain", "blank"]);
    assert.ok(result.warnings.some(warning => warning.includes("56")));
    assert.ok(result.warnings.some(warning => warning.includes("57")));
  });
});

test("an explicitly unanswered page overrides apparently solved per-question output", async () => {
  await withProvider(() => ({ title: "未答试卷", passage: "She {{56}} (go) to school every day.", hasStudentAnswers: false, questions: [{ number: "56", cue: "go", studentAnswer: "goes", answerStatus: "answered", answerEvidence: "goes" }], warnings: [] }), async () => {
    const result = await deepseekAI.recognize(Buffer.from("mock image"), context());
    assert.equal(result.questions[0].studentAnswer, "");
    assert.equal(result.questions[0].answerEvidence, "");
    assert.equal(result.questions[0].answerStatus, "blank");
    assert.ok(result.warnings.length);
  });
});

test("diagnosis cannot replace an omitted answer or invent an omission's cognitive cause", async () => {
  const input = { passage: "She {{56}} (go) to school every day.", questions: [fixtureQuestion({ studentAnswer: "goes", answerStatus: "blank" })] };
  await withProvider(request => {
    const sent = JSON.parse(request.messages[1].content as string);
    assert.equal(sent.questions[0].studentAnswer, "");
    assert.equal(sent.questions[0].answerStatus, "blank");
    return diagnosisFor(sent);
  }, async () => {
    const result = await deepseekAI.diagnose(input, context());
    assert.equal("studentAnswer" in result.questions[0], false, "Extra model output must not become a student answer");
    assert.deepEqual(result.questions[0].referenceAnswers, ["goes"], "Reference learning is allowed separately");
    assert.equal(result.questions[0].errorPattern, "未作答");
    assert.match(result.questions[0].possibleCause, /无法仅凭空白/);
    assert.match(result.questions[0].explanation.why, /不代表你已填写/);
  });
});

test("manual clearing survives save, sample grading, tag changes and retry", async () => {
  const api = await apiClient();
  const sample = (await samples()).find(item => item.split === "development")!;
  const capture = await api.call("captures", "POST", { sampleId: sample.id, clientRequestId: randomUUID() }, 201);
  const edited = capture.questions.map((question: InputQuestion, index: number) => index === 0 ? { ...question, studentAnswer: "", answerStatus: "blank", answerOrigin: "manual" } : question);
  const saved = await api.call(`captures/${capture.id}`, "PATCH", { title: capture.title, passage: capture.passage, questions: edited, expectedVersion: capture.version });
  assert.equal(saved.questions[0].studentAnswer, "");
  assert.equal(saved.questions[0].answerStatus, "blank");
  const created = await api.call("submissions", "POST", { captureId: saved.id, inputVersion: saved.version, clientRequestId: randomUUID() }, 202);
  await api.runQueued(created.id, "diagnose");
  const result = await api.call(`submissions/${created.id}`);
  const omitted = result.questions[0];
  assert.equal(omitted.studentAnswer, ""); assert.equal(omitted.gradeStatus, "incorrect"); assert.equal(omitted.score, 0);
  assert.equal(omitted.errorPattern, "未作答"); assert.match(omitted.possibleCause, /无法仅凭空白/);
  const updated = await api.call(`questions/${omitted.id}/diagnosis`, "PATCH", { tagId: "noun-clause", expectedVersion: omitted.diagnosisVersion });
  await api.runQueued(created.id, "explain");
  assert.equal(updated.questions[0].studentAnswer, "");
  assert.match((await api.call(`submissions/${created.id}`)).questions[0].explanation.why, /未作答/);
  await updateState(api.userId, state => { const item = state.submissions.find(entry => entry.id === created.id)!; item.status = "failed"; item.error = "simulated restart"; });
  await api.call(`submissions/${created.id}/retry`, "POST", {}, 202);
  await api.runQueued(created.id, "diagnose");
  const retried = await api.call(`submissions/${created.id}`);
  assert.equal(retried.questions[0].studentAnswer, ""); assert.equal(retried.questions[0].score, 0);
  const restored = await api.call(`captures/${capture.id}`);
  const filled = restored.questions.map((question: InputQuestion, index: number) => index === 0 ? { ...question, studentAnswer: "which", answerStatus: "answered", answerOrigin: "manual" } : question);
  const manual = await api.call(`captures/${capture.id}`, "PATCH", { title: restored.title, passage: restored.passage, questions: filled, expectedVersion: restored.version });
  assert.equal(manual.questions[0].studentAnswer, "which", "A deliberate manual answer remains intact");
  assert.equal(manual.questions[0].answerOrigin, "manual");
  assert.equal(manual.questions[0].answerEvidence, undefined, "Old OCR evidence is not reused for manual text");
});

test("mixed blank, unreadable and answered input stays separate through provider failure and retry", async () => {
  const api = await apiClient();
  const capture: Capture = { id: randomUUID(), userId: api.userId, title: "隔离回归输入", passage: "She {{56}} (go) to school. He {{57}} (go) too. They {{58}} (go) together.", questions: [fixtureQuestion({ answerStatus: "blank" }), fixtureQuestion({ number: "57", answerStatus: "uncertain" }), fixtureQuestion({ number: "58", studentAnswer: "go", answerStatus: "answered", answerOrigin: "manual" })], warnings: [], status: "completed", stage: "confirmed", version: 1, mode: "live", createdAt: new Date().toISOString() };
  await updateState(api.userId, state => { state.captures.push(capture); });
  const created = await api.call("submissions", "POST", { captureId: capture.id, inputVersion: 1, clientRequestId: randomUUID() }, 202);
  let count = 0;
  await withProvider(request => {
    if (++count === 1) return new Response("temporary provider failure", { status: 503 });
    const sent = JSON.parse(request.messages[1].content as string);
    assert.deepEqual(sent.questions.map((question: InputQuestion) => question.studentAnswer), ["", "", "go"]);
    return diagnosisFor(sent);
  }, async () => {
    await api.runQueued(created.id);
    const afterFailure = await readState(api.userId);
    assert.deepEqual(afterFailure.submissions[0].questions.map(question => question.studentAnswer), ["", "", "go"]);
    const jobId = afterFailure.jobs.find(job => job.targetId === created.id)!.id;
    await updateState(api.userId, state => { const job = state.jobs.find(entry => entry.id === jobId)!; job.payload = { ...job.payload, retryAt: 0 }; });
    await processJob(api.userId, jobId);
  });
  const result = await api.call(`submissions/${created.id}`);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.questions.map((question: InputQuestion) => question.studentAnswer), ["", "", "go"]);
  assert.deepEqual(result.questions.map((question: { gradeStatus: string }) => question.gradeStatus), ["incorrect", "uncertain", "incorrect"]);
  assert.equal(result.questions[0].errorPattern, "未作答");
  assert.equal(result.questions[1].errorPattern, "作答待核对");
});

test("partially or fully blank practice submissions store omissions and reset review to tomorrow", async () => {
  for (const answers of [["", "", ""], ["goes", "   ", "walk"]]) {
    const api = await apiClient();
    const session: PracticeSession = { id: randomUUID(), userId: api.userId, tagId: "subject-agreement", status: "completed", items: [1, 2, 3].map(index => ({ id: randomUUID(), prompt: `Example ${index}: She ____ home.`, cue: "go", tagId: "subject-agreement", answers: ["goes"], explanation: "一般现在时第三人称单数。" })), results: [], createdAt: new Date().toISOString(), mode: "sample" };
    await updateState(api.userId, state => { state.sessions.push(session); });
    const publicBefore = await api.call(`review/sessions/${session.id}`);
    assert.ok(publicBefore.items.every((item: { answers?: string[] }) => item.answers === undefined));
    const started = Date.now();
    const key = randomUUID();
    const payload = { responses: session.items.map((item, index) => ({ itemId: item.id, response: answers[index] })), clientRequestId: key };
    const result = await api.call(`review/sessions/${session.id}/attempts`, "POST", payload);
    assert.deepEqual(result.results.map((item: { response: string }) => item.response), answers.map(answer => answer.trim() ? answer : ""));
    assert.equal(result.results.filter((item: { correct: boolean }) => item.correct).length, answers[0] ? 1 : 0);
    assert.ok(Date.parse(result.nextDueAt) >= started + 86400000 && Date.parse(result.nextDueAt) <= Date.now() + 86400000);
    const repeated = await api.call(`review/sessions/${session.id}/attempts`, "POST", payload);
    assert.deepEqual(repeated.results, result.results);
    const saved = await readState(api.userId);
    assert.equal(saved.sessions[0].results.length, 3);
    assert.equal(saved.reviewTasks.filter(task => task.status === "pending").length, 1);
    assert.equal(saved.reviewTasks.find(task => task.status === "pending")!.level, 0);
  }
});
