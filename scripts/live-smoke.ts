import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

// Real external calls; all credentials stay in process memory. Only the public
// exam page is sent to DeepSeek. No email is sent for the isolated test account.
process.loadEnvFile(".env.local");
const cloud = process.argv.includes("--supabase");
const runId = randomUUID();
const temporary = cloud ? undefined : await mkdtemp(path.join(os.tmpdir(), "grammar-loop-live-"));
process.env.STORAGE_MODE = cloud ? "supabase" : "local";
process.env.WORKER_QUEUE_NAME = `grammar-loop-live-smoke-${runId}`;
if (temporary) process.env.LOCAL_DATA_DIR = temporary;
const { handleApi } = await import("../src/server/api");
const { readState, listUserIds, supabaseAdmin } = await import("../src/server/store");
const { getBoss, queueName, processJob } = await import("../src/server/jobs");
const { samples } = await import("../src/server/samples");
const checks: { stage: string; ok: boolean; durationMs: number; details?: Record<string, unknown> }[] = [];
let userId = "", bearer = "", cookie = "", imageKey = "";
let boss: Awaited<ReturnType<typeof getBoss>> = null;
let createdUserId: string | undefined;
let currentStage = "configuration";
let success = false;
let safeFailure: Record<string, unknown> | undefined;
const start = Date.now();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function stage<T>(name: string, action: () => Promise<T>): Promise<T> {
  currentStage = name; console.log(JSON.stringify({ stage: name, state: "running" }));
  const started = Date.now(); const value = await action();
  checks.push({ stage: name, ok: true, durationMs: Date.now() - started });
  console.log(JSON.stringify({ stage: name, state: "passed", durationMs: Date.now() - started })); return value;
}
async function api(route: string, method = "GET", payload?: unknown) {
  const multipart = payload instanceof FormData;
  const response = await handleApi(new Request(`http://127.0.0.1:3000/api/${route}`, {
    method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(payload && !multipart ? { "Content-Type": "application/json" } : {}) },
    ...(payload ? { body: multipart ? payload : JSON.stringify(payload) } : {}),
  }));
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error("application_request_failed"), { safeCode: data.code || "HTTP_ERROR", safeStatus: response.status });
  return data;
}
async function finishJob(targetId: string, kind: string) {
  if (!cloud) {
    const state = await readState(userId);
    const job = state.jobs.find(item => item.targetId === targetId && item.kind === kind && item.status === "queued");
    assert.ok(job); await processJob(userId, job.id);
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = await readState(userId);
    const jobs = state.jobs.filter(item => item.targetId === targetId && item.kind === kind);
    const latest = jobs[jobs.length - 1];
    if (latest?.status === "completed") return;
    if (latest?.status === "failed") throw Object.assign(new Error("background_job_failed"), { safeCode: "JOB_FAILED", safeStage: kind });
    // Mirror worker.ts recovery scanning: a retryable model response leaves
    // a durable queued job even after its original queue message is complete.
    if (latest?.status === "queued" && latest.attempts > 0 && Number(latest.payload?.retryAt || 0) <= Date.now()) await processJob(userId, latest.id);
    await pause(750);
  }
  throw Object.assign(new Error("background_job_timeout"), { safeCode: "JOB_TIMEOUT" });
}

try {
  assert.ok(process.env.DEEPSEEK_API_KEY, "DeepSeek key is required");
  if (cloud) {
    await stage("supabase_auth_login", async () => {
      const admin = supabaseAdmin();
      const email = `grammar-loop-smoke-${runId}@example.invalid`;
      const password = randomBytes(24).toString("base64url") + "aA1!";
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: "grammar-loop-isolated-smoke", runId } });
      if (created.error || !created.data.user) throw Object.assign(new Error("test_user_creation_failed"), { safeCode: "AUTH_ADMIN_FAILED" });
      createdUserId = created.data.user.id; userId = createdUserId;
      const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const login = await client.auth.signInWithPassword({ email, password });
      if (login.error || !login.data.session) throw Object.assign(new Error("login_failed"), { safeCode: "AUTH_LOGIN_FAILED" });
      bearer = login.data.session.access_token;
      const denied = await client.from("gl_workspaces").select("state");
      assert.ok(denied.error, "client must not read unrevealed practice answers directly");
    });
    boss = await stage("pg_boss_worker", async () => {
      const worker = await getBoss(); assert.ok(worker, "DATABASE_URL required for cloud smoke test");
      await worker.work<{ userId: string; jobId: string }>(queueName, { pollingIntervalSeconds: 1 }, async jobs => {
        for (const job of jobs) {
          assert.equal(job.data.userId, userId, "isolated queue received an unexpected user");
          await processJob(job.data.userId, job.data.jobId);
        }
      });
      return worker;
    });
  }
  await api("me/overview");
  const capture = await stage("image_upload", async () => {
    const sharp = (await import("sharp")).default;
    const source = await readFile("data/sources/2025-question-page11.png");
    const metadata = await sharp(source).metadata();
    assert.ok(metadata.width && metadata.height);
    // The original scan has a multiple-choice section above the cloze. Use
    // only its grammar-cloze region, matching the app's single-passage input.
    const top = Math.floor(metadata.height * 0.505);
    const image = await sharp(source).extract({ left: 0, top, width: metadata.width, height: metadata.height - top }).png().toBuffer();
    const form = new FormData(); form.set("image", new File([new Uint8Array(image)], "public-gaokao-page.png", { type: "image/png" })); form.set("clientRequestId", randomUUID());
    return api("captures", "POST", form);
  });
  if (!cloud) userId = (await Promise.all((await listUserIds()).map(async id => ({ id, state: await readState(id) })))).find(item => item.state.captures.some(value => value.id === capture.id))!.id;
  imageKey = capture.imagePath;
  const recognized = await stage("deepseek_vision", async () => {
    await finishJob(capture.id, "recognize");
    const value = await api(`captures/${capture.id}`);
    assert.equal(value.status, "completed"); assert.equal(value.questions.length, 10);
    assert.deepEqual(value.questions.map((item: { number: string }) => item.number).sort(), ["56", "57", "58", "59", "60", "61", "62", "63", "64", "65"]);
    return value;
  });
  const sample = (await samples()).find(value => value.year === 2025)!;
  const confirmed = await stage("confirm_transcription", async () => api(`captures/${capture.id}`, "PATCH", {
    title: "真实 API 集成测试 · 2025 全国一卷", passage: recognized.passage,
    questions: recognized.questions.map((question: { number: string; studentAnswer: string }, index: number) => ({ ...question, studentAnswer: index % 3 === 0 ? sample.questions.find(item => item.number === question.number)?.answers[0] || "test" : "test" })),
    expectedVersion: recognized.version,
  }));
  const submission = await stage("deepseek_diagnosis", async () => {
    const created = await api("submissions", "POST", { captureId: capture.id, inputVersion: confirmed.version, clientRequestId: randomUUID() });
    await finishJob(created.id, "diagnose");
    const result = await api(`submissions/${created.id}`);
    assert.equal(result.status, "completed"); assert.equal(result.questions.length, recognized.questions.length);
    assert.ok(result.questions.every((question: { explanation: { rule: string; why: string } }) => question.explanation.rule && question.explanation.why));
    return result;
  });
  const question = submission.questions.find((item: { gradeStatus: string }) => item.gradeStatus === "incorrect") || submission.questions[0];
  const corrected = await stage("tag_correction_and_explanation", async () => {
    const tagId = question.tagId === "relative-clause" ? "fixed-expression" : "relative-clause";
    await api(`questions/${question.id}/diagnosis`, "PATCH", { tagId, expectedVersion: question.diagnosisVersion, note: "隔离集成测试：校正个人分类与讲解更新" });
    await finishJob(submission.id, "explain");
    const result = await api(`submissions/${submission.id}`); const item = result.questions.find((entry: { id: string }) => entry.id === question.id);
    assert.equal(item.tagId, tagId); assert.equal(item.explanationStatus, "ready"); return item;
  });
  const session = await stage("deepseek_practice_generation", async () => {
    const created = await api("review/sessions", "POST", { sourceSubmissionId: submission.id, sourceQuestionId: question.id, tagId: corrected.tagId, clientRequestId: randomUUID(), mode: "live" });
    await finishJob(created.id, "practice");
    const result = await api(`review/sessions/${created.id}`); assert.equal(result.items.length, 3);
    assert.ok(result.items.every((item: { answers?: string[]; explanation?: string }) => item.answers === undefined && item.explanation === undefined)); return result;
  });
  await stage("practice_submit_review_and_persistence", async () => {
    const state = await readState(userId); const internal = state.sessions.find(item => item.id === session.id)!;
    const responses = internal.items.map(item => ({ itemId: item.id, response: item.answers[0] }));
    const key = randomUUID(); const result = await api(`review/sessions/${session.id}/attempts`, "POST", { responses, clientRequestId: key });
    assert.equal(result.results.length, 3); assert.ok(result.nextDueAt);
    await api(`review/sessions/${session.id}/attempts`, "POST", { responses, clientRequestId: key });
    const overview = await api("me/overview"); assert.equal(overview.stats.practiced, 3); assert.ok(overview.reviewTasks.length);
    if (cloud) {
      const response = await handleApi(new Request(`http://127.0.0.1:3000/api/captures/${capture.id}/image`, { headers: { Authorization: `Bearer ${bearer}` } }));
      assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/jpeg");
    }
  });
  const logs = (await readState(userId)).modelLogs;
  checks.push({ stage: "real_model_usage", ok: logs.length >= 4 && logs.every(item => item.inputTokens > 0), durationMs: 0, details: { calls: logs.length, inputTokens: logs.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: logs.reduce((sum, item) => sum + item.outputTokens, 0), recognizedQuestions: recognized.questions.length } });
  assert.ok(checks[checks.length - 1].ok); success = true;
} catch (error) {
  const value = error as { name?: string; safeCode?: string; safeStatus?: number; safeStage?: string; code?: string };
  safeFailure = { stage: currentStage, name: value.name || "Error", code: value.safeCode || (/^[A-Za-z0-9_]+$/.test(value.code || "") ? value.code : "CHECK_FAILED"), ...(value.safeStatus ? { httpStatus: value.safeStatus } : {}) };
  console.log(JSON.stringify({ state: "failed", ...safeFailure }));
} finally {
  if (boss) {
    try { await boss.offWork(queueName); assert.ok(queueName.startsWith("grammar-loop-live-smoke-")); await boss.deleteQueue(queueName); await boss.stop(); } catch { console.log(JSON.stringify({ cleanup: "test_queue", ok: false })); }
  }
  if (cloud && createdUserId) {
    try {
      const admin = supabaseAdmin();
      if (imageKey) { assert.ok(imageKey.startsWith(createdUserId + "/")); const removed = await admin.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "grammar-loop").remove([imageKey]); assert.ok(!removed.error); }
      const info = await admin.auth.admin.getUserById(createdUserId);
      assert.equal(info.data.user?.user_metadata.runId, runId);
      const removed = await admin.auth.admin.deleteUser(createdUserId); assert.ok(!removed.error);
      console.log(JSON.stringify({ cleanup: "isolated_test_user_and_image", ok: true }));
    } catch { console.log(JSON.stringify({ cleanup: "isolated_test_user_and_image", ok: false })); }
  }
  if (temporary) {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("grammar-loop-live-"));
    await rm(temporary, { recursive: true, force: true });
  }
  const report = { checkedAt: new Date().toISOString(), mode: cloud ? "supabase" : "local-with-real-deepseek", success, durationMs: Date.now() - start, checks, ...(safeFailure ? { failure: safeFailure } : {}) };
  await writeFile(`docs/live-test-${cloud ? "supabase" : "deepseek"}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: success ? "passed" : "failed", mode: report.mode, checksPassed: checks.filter(item => item.ok).length, report: `docs/live-test-${cloud ? "supabase" : "deepseek"}.json` }));
  process.exitCode = success ? 0 : 1;
}
