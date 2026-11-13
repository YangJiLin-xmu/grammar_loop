import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const directory = await mkdtemp(path.join(os.tmpdir(), "grammar-loop-test-"));
process.env.LOCAL_DATA_DIR = directory;
process.env.STORAGE_MODE = "local";
process.env.ENABLE_SAMPLE_MODE = "true";
process.env.SESSION_SECRET = "test-only-secret-no-external-service";
delete process.env.DEEPSEEK_API_KEY;
const { handleApi } = await import("../src/server/api");
const { processJob } = await import("../src/server/jobs");
const { readState, listUserIds } = await import("../src/server/store");
const { gradeAnswer, fixedScheduler } = await import("../src/server/learning");
const { samples } = await import("../src/server/samples");
const { TAGS } = await import("../src/lib/tags");

test.after(async () => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("grammar-loop-test-"));
  await rm(directory, { recursive: true, force: true });
});

test("grading preserves meaningful word forms and does not mark unreadable answers wrong", () => {
  assert.equal(gradeAnswer("  to   present ", ["to present"]), "correct");
  assert.equal(gradeAnswer("what", ["which"]), "incorrect");
  assert.equal(gradeAnswer("Which", ["which"]), "incorrect");
  assert.equal(gradeAnswer("[无法辨认]", ["which"]), "uncertain");
  assert.equal(gradeAnswer("anything", [], true), "uncertain");
  assert.equal(gradeAnswer("", ["which"]), "incorrect");
});

test("review schedule advances 1/3/7 days and resets on a mistake", () => {
  const now = new Date("2026-11-12T08:00:00Z");
  assert.deepEqual(fixedScheduler.nextDue(0, false, now), { level: 0, dueAt: "2026-11-13T08:00:00.000Z" });
  assert.deepEqual(fixedScheduler.nextDue(0, true, now), { level: 1, dueAt: "2026-11-15T08:00:00.000Z" });
  assert.deepEqual(fixedScheduler.nextDue(1, true, now), { level: 2, dueAt: "2026-11-19T08:00:00.000Z" });
  assert.equal(fixedScheduler.nextDue(2, true, now).level, 2);
});

test("corpus has exactly 30 traceable questions with intact passage grouping", async () => {
  const data = await samples();
  assert.equal(data.length, 3);
  assert.equal(data.flatMap(item => item.questions).length, 30);
  assert.equal(data.filter(item => item.split === "development").flatMap(item => item.questions).length, 10);
  for (const sample of data) {
    assert.equal(sample.questions.length, 10);
    assert.ok(sample.sources.some(source => source.role === "question"));
    assert.ok(sample.sources.some(source => source.role === "answer"));
    assert.ok(sample.verification.status !== "pending");
    for (const question of sample.questions) {
      assert.ok(sample.passage.includes(`{{${question.number}}}`));
      assert.ok(question.answers.length);
      assert.ok(TAGS.some(tag => tag.id === question.tagId));
    }
  }
  assert.deepEqual(data.find(item => item.year === 2024)!.questions.find(item => item.number === "64")!.answers.toSorted(), ["that", "which"]);
});

test("full sample flow persists, isolates users, handles retries and hides practice answers", async () => {
  let cookie = "";
  async function api(route: string, method = "GET", payload?: unknown, expected = 200) {
    const response = await handleApi(new Request(`http://localhost/api/${route}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { "Content-Type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }));
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  const initial = await api("me/overview"); assert.equal(initial.submissions.length, 0);
  const sample = initial.samples.find((item: { split: string }) => item.split === "development");
  assert.ok(!JSON.stringify(initial.samples).includes("studentAnswer"));
  const key = randomUUID();
  const capture = await api("captures", "POST", { sampleId: sample.id, clientRequestId: key }, 201);
  const duplicateCapture = await api("captures", "POST", { sampleId: sample.id, clientRequestId: key }); assert.equal(duplicateCapture.id, capture.id);
  const modified = await api(`captures/${capture.id}`, "PATCH", { title: capture.title, passage: capture.passage, questions: capture.questions, expectedVersion: capture.version });
  await api(`captures/${capture.id}`, "PATCH", { title: capture.title, passage: capture.passage, questions: capture.questions, expectedVersion: capture.version }, 409);
  const submissionKey = randomUUID();
  const submission = await api("submissions", "POST", { captureId: capture.id, inputVersion: modified.version, clientRequestId: submissionKey }, 202);
  const userId = (await listUserIds())[0];
  const job = (await readState(userId)).jobs.find(item => item.targetId === submission.id)!;
  await Promise.all([processJob(userId, job.id), processJob(userId, job.id)]);
  const result = await api(`submissions/${submission.id}`); assert.equal(result.status, "completed"); assert.equal(result.questions.length, 10);
  assert.equal(result.questions.reduce((total: number, item: { score: number }) => total + item.score, 0), 4.5);
  assert.equal((await api("submissions", "POST", { captureId: capture.id, inputVersion: modified.version, clientRequestId: submissionKey })).id, result.id);
  const bad = result.questions.find((item: { gradeStatus: string }) => item.gradeStatus === "incorrect");
  const newTag = bad.tagId === "noun" ? "article" : "noun";
  const corrected = await api(`questions/${bad.id}/diagnosis`, "PATCH", { tagId: newTag, expectedVersion: bad.diagnosisVersion, note: "integration test" });
  assert.equal(corrected.questions.find((item: { id: string }) => item.id === bad.id).tagId, newTag);
  await api(`questions/${bad.id}/diagnosis`, "PATCH", { tagId: newTag, expectedVersion: bad.diagnosisVersion }, 409);
  const explain = (await readState(userId)).jobs.find(item => item.kind === "explain" && item.status === "queued")!;
  await processJob(userId, explain.id);
  const refreshed = await api(`submissions/${submission.id}`); assert.equal(refreshed.questions.find((item: { id: string }) => item.id === bad.id).explanationStatus, "ready");
  const overview = await api("me/overview"); assert.ok(overview.reviewTasks.some((item: { tagId: string }) => item.tagId === newTag));
  const review = overview.reviewTasks.find((item: { tagId: string }) => item.tagId === newTag);
  const session = await api("review/sessions", "POST", { reviewTaskId: review.id, mode: "sample", clientRequestId: randomUUID() }, 202);
  const practiceJob = (await readState(userId)).jobs.find(item => item.targetId === session.id)!;
  await processJob(userId, practiceJob.id);
  const exercise = await api(`review/sessions/${session.id}`); assert.equal(exercise.items.length, 3);
  for (const item of exercise.items) { assert.equal(item.answers, undefined); assert.equal(item.explanation, undefined); }
  const internal = (await readState(userId)).sessions.find(item => item.id === session.id)!;
  const answers = internal.items.map(item => ({ itemId: item.id, response: item.answers[0] }));
  const attemptKey = randomUUID();
  const completed = await api(`review/sessions/${session.id}/attempts`, "POST", { responses: answers, clientRequestId: attemptKey });
  assert.equal(completed.results.filter((item: { correct: boolean }) => item.correct).length, 3); assert.ok(completed.nextDueAt);
  await api(`review/sessions/${session.id}/attempts`, "POST", { responses: answers, clientRequestId: attemptKey });
  assert.equal((await api("me/overview")).stats.practiced, 3);
  const other = await handleApi(new Request(`http://localhost/api/submissions/${submission.id}`)); assert.equal(other.status, 404);
  const csrf = await handleApi(new Request("http://localhost/api/captures", { method: "POST", headers: { Origin: "https://unrelated.example", "Content-Type": "application/json" }, body: "{}" })); assert.equal(csrf.status, 403);
});

test("real-upload pipeline sends image and structured DeepSeek requests (provider mocked)", async () => {
  const originalFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-provider-only";
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).startsWith("https://api.deepseek.com/chat/completions"));
    const request = JSON.parse(init!.body as string); calls.push(request);
    assert.deepEqual(request.response_format, { type: "json_object" });
    const system = request.messages[0].content as string;
    let result;
    if (system.includes("转写助手")) {
      assert.ok(request.messages[1].content[1].image_url.url.startsWith("data:image/jpeg;base64,"));
      result = { title: "测试上传 · 非真题", passage: "Every morning, Lily {{1}} (walk) to school. Her friends {{2}} (be) kind. She carries {{3}} umbrella on rainy days.", questions: [{ number: "1", cue: "walk", studentAnswer: "walk" }, { number: "2", cue: "be", studentAnswer: "are" }, { number: "3", cue: "", studentAnswer: "a" }], warnings: [] };
    } else if (system.includes("出题助手")) {
      result = { items: [1, 2, 3].map(index => ({ prompt: `Example ${index}: The boy ____ every morning.`, cue: "walk", answers: ["walks"], explanation: "一般现在时主谓一致。" })) };
    } else {
      const supplied = JSON.parse(request.messages[1].content);
      const answers: Record<string, string[]> = { "1": ["walks"], "2": ["are"], "3": ["an"] };
      result = { questions: supplied.questions.map((question: { number: string }) => ({ number: question.number, referenceAnswers: answers[question.number], tagId: question.number === "3" ? "article" : "subject-agreement", errorPattern: "词形或选词差异", possibleCause: "可能需要再看语法结构。", uncertain: false, explanation: { rule: "结合主语和语境判断。", evidence: "Every morning", why: "按规则选择形式。", example: "He walks to school." } })) };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 180 } });
  };
  try {
    let cookie = "";
    async function call(route: string, method = "GET", payload?: unknown, status = 200) {
      const multipart = payload instanceof FormData;
      const response = await handleApi(new Request(`http://localhost/api/${route}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(payload && !multipart ? { "Content-Type": "application/json" } : {}) }, ...(payload ? { body: multipart ? payload : JSON.stringify(payload) } : {}) }));
      if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
    }
    await call("me/overview");
    const sharp = (await import("sharp")).default;
    const image = await sharp({ create: { width: 320, height: 240, channels: 3, background: "white" } }).png().toBuffer();
    const invalid = new FormData(); invalid.set("image", new File(["not an image"], "fake.png", { type: "image/png" })); invalid.set("clientRequestId", randomUUID());
    await call("captures", "POST", invalid, 422);
    const form = new FormData(); form.set("image", new File([new Uint8Array(image)], "test.png", { type: "image/png" })); form.set("clientRequestId", randomUUID());
    const capture = await call("captures", "POST", form, 202);
    const users = await listUserIds();
    const userId = (await Promise.all(users.map(async id => ({ id, state: await readState(id) })))).find(item => item.state.captures.some(value => value.id === capture.id))!.id;
    const run = async (target: string, kind?: string) => {
      const job = (await readState(userId)).jobs.find(item => item.targetId === target && item.status === "queued" && (!kind || item.kind === kind))!;
      assert.ok(job); await processJob(userId, job.id);
    };
    await run(capture.id);
    const recognized = await call(`captures/${capture.id}`); assert.equal(recognized.status, "completed"); assert.equal(recognized.questions.length, 3);
    const saved = await call(`captures/${capture.id}`, "PATCH", { title: recognized.title, passage: recognized.passage, questions: recognized.questions, expectedVersion: recognized.version });
    const submitKey = randomUUID();
    const submission = await call("submissions", "POST", { captureId: saved.id, inputVersion: saved.version, clientRequestId: submitKey }, 202);
    await run(submission.id);
    const result = await call(`submissions/${submission.id}`); assert.equal(result.status, "completed"); assert.equal(result.questions[0].answerSource, "ai"); assert.equal(result.questions[0].score, null);
    assert.equal(result.questions.filter((item: { gradeStatus: string }) => item.gradeStatus === "incorrect").length, 2);
    assert.ok(result.questions[0].id !== saved.questions[0].id, "result IDs must not collide across capture revisions");
    await call(`captures/${capture.id}`, "PATCH", { title: saved.title, passage: saved.passage, questions: [null], expectedVersion: saved.version }, 400);
    const revised = await call(`captures/${capture.id}`, "PATCH", { title: saved.title, passage: saved.passage, questions: saved.questions, expectedVersion: saved.version });
    assert.equal((await call("submissions", "POST", { captureId: saved.id, inputVersion: saved.version, clientRequestId: submitKey })).id, submission.id, "idempotent replay survives later draft edits");
    assert.ok(revised.version > saved.version);
    const question = result.questions[0];
    const modified = await call(`questions/${question.id}/diagnosis`, "PATCH", { tagId: "verb-tense", expectedVersion: question.diagnosisVersion });
    const v2 = modified.questions.find((item: { id: string }) => item.id === question.id);
    await call(`questions/${question.id}/diagnosis`, "PATCH", { tagId: "verb-tense", disputed: true, expectedVersion: v2.diagnosisVersion });
    for (const job of (await readState(userId)).jobs.filter(item => item.kind === "explain" && item.status === "queued")) await processJob(userId, job.id);
    const afterDispute = await call(`submissions/${submission.id}`); assert.equal(afterDispute.questions.find((item: { id: string }) => item.id === question.id).explanationStatus, "ready");
    const session = await call("review/sessions", "POST", { tagId: "article", sourceQuestionId: result.questions[2].id, sourceSubmissionId: submission.id, clientRequestId: randomUUID() }, 202);
    await run(session.id);
    const exercise = await call(`review/sessions/${session.id}`); assert.equal(exercise.mode, "live"); assert.equal(exercise.items.length, 3); assert.ok(exercise.items.every((item: { answers?: string[] }) => !item.answers));
    const key = randomUUID();
    const completed = await call(`review/sessions/${session.id}/attempts`, "POST", { responses: exercise.items.map((item: { id: string }) => ({ itemId: item.id, response: "walks" })), clientRequestId: key });
    assert.equal(completed.results.length, 3); assert.ok(completed.nextDueAt);
    const later = await call("review/sessions", "POST", { tagId: "article", sourceQuestionId: result.questions[2].id, sourceSubmissionId: submission.id, clientRequestId: randomUUID() }, 202);
    await run(later.id);
    const laterItems = await call(`review/sessions/${later.id}`);
    await call(`review/sessions/${later.id}/attempts`, "POST", { responses: exercise.items.map((item: { id: string }) => ({ itemId: item.id, response: "walks" })), clientRequestId: key }, 409);
    await call(`questions/${result.questions[2].id}/diagnosis`, "PATCH", { tagId: "preposition", expectedVersion: result.questions[2].diagnosisVersion });
    const obsolete = await call(`review/sessions/${later.id}/attempts`, "POST", { responses: laterItems.items.map((item: { id: string }) => ({ itemId: item.id, response: "walks" })), clientRequestId: randomUUID() });
    assert.equal(obsolete.nextDueAt, undefined, "old sessions must not resurrect an obsolete review category");
    assert.ok(!(await readState(userId)).reviewTasks.some(task => task.tagId === "article" && task.status === "pending"));
    assert.ok(calls.length >= 4); assert.ok((await readState(userId)).modelLogs.every(log => log.inputTokens === 120));
  } finally { globalThis.fetch = originalFetch; delete process.env.DEEPSEEK_API_KEY; }
});

test("both held-out passages complete the functional grading pipeline", async () => {
  const data = (await samples()).filter(sample => sample.split === "test");
  for (const sample of data) {
    const first = await handleApi(new Request("http://localhost/api/me/overview"));
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    const call = async (route: string, payload?: unknown) => {
      const response = await handleApi(new Request(`http://localhost/api/${route}`, { method: payload ? "POST" : "GET", headers: { Cookie: cookie, Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}) }));
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    const capture = await call("captures", { sampleId: sample.id, clientRequestId: randomUUID() });
    const submission = await call("submissions", { captureId: capture.id, inputVersion: capture.version, clientRequestId: randomUUID() });
    const owners = await Promise.all((await listUserIds()).map(async id => ({ id, state: await readState(id) })));
    const owner = owners.find(item => item.state.submissions.some(entry => entry.id === submission.id))!;
    const job = owner.state.jobs.find(item => item.targetId === submission.id)!;
    await processJob(owner.id, job.id);
    const result = await call(`submissions/${submission.id}`);
    assert.equal(result.status, "completed"); assert.equal(result.questions.length, 10);
    assert.ok(result.questions.every((question: { answerSource: string; referenceAnswers: string[]; score: number | null }) => question.answerSource === "published_reference" && question.referenceAnswers.length && question.score !== null));
    assert.equal(result.questions.reduce((total: number, question: { maxScore: number }) => total + question.maxScore, 0), 15);
  }
});
