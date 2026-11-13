import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

// True HTTP black-box exercise. No application internals are imported. Every
// child receives empty external credentials, and all mutable state is isolated.
const project = process.cwd();
const reportDir = path.join(project, "docs", "report");
await mkdir(reportDir, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "grammar-loop-blackbox-"));
const port = 3107;
const origin = `http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  SystemRoot: process.env.SystemRoot || "C:\\Windows",
  WINDIR: process.env.WINDIR || "C:\\Windows",
  ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
  NODE_ENV: "development",
  STORAGE_MODE: "local",
  LOCAL_DATA_DIR: temporary,
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  DATABASE_URL: "",
  SESSION_SECRET: `blackbox-only-${randomUUID()}`,
  APP_ORIGIN: "",
  ENABLE_SAMPLE_MODE: "true",
  NEXT_TELEMETRY_DISABLED: "1",
};
const processes: { role: string; child: ChildProcess }[] = [];
const serverLogs: string[] = [];
const caseLogs: string[] = [];
type Result = { httpStatus: number; data: any; headers: Headers; durationMs: number };
type CaseRecord = {
  id: string; title: string; category: string; preconditions: string[];
  input: Record<string, unknown>; steps: string[]; expected: Record<string, unknown>;
  actual: Record<string, unknown>; status: "PASS" | "FAIL" | "BLOCKED";
  durationMs: number; evidence: string;
};
const cases: CaseRecord[] = [];
let healthy = false;
let cleaned = false;
let capture: any, submission: any, question: any, practice: any, practice2: any;
let originalCapture: any;
const clientA = { cookie: "" }, clientB = { cookie: "" };
const captureKey = randomUUID(), submissionKey = randomUUID(), practiceKey = randomUUID(), attemptKey = randomUUID();
const startedAt = new Date();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function launch(role: string, args: string[]) {
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  processes.push({ role, child });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data: Buffer) => serverLogs.push(`[${role}] ${String(data)}`));
  return child;
}
async function http(route: string, method = "GET", payload?: unknown, client = clientA, extraHeaders: Record<string, string> = {}): Promise<Result> {
  const started = performance.now();
  const multipart = payload instanceof FormData;
  const raw = typeof payload === "string";
  const response = await fetch(origin + route, {
    method,
    headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(payload !== undefined && !multipart ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    ...(payload !== undefined ? { body: multipart ? payload : raw ? payload as string : JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const cookie = response.headers.get("set-cookie");
  if (cookie) client.cookie = cookie.split(";")[0];
  const body = await response.text();
  let data: any;
  try { data = JSON.parse(body); } catch { data = { textLength: body.length, hasGrammarLoopTitle: body.includes("Grammar Loop"), contentType: response.headers.get("content-type") }; }
  return { httpStatus: response.status, data, headers: response.headers, durationMs: Math.round(performance.now() - started) };
}
function summary(result: Result, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { httpStatus: result.httpStatus, ...(result.data?.error ? { error: result.data.error, code: result.data.code } : {}), ...details };
}
function requireValue(value: unknown, name: string): asserts value {
  if (!value) throw Object.assign(new Error(`前置步骤没有产生 ${name}`), { blocked: true });
}
async function record(id: string, title: string, category: string, preconditions: string[], input: Record<string, unknown>, steps: string[], expected: Record<string, unknown>, action: () => Promise<Record<string, unknown>>) {
  const before = performance.now();
  const item: CaseRecord = { id, title, category, preconditions, input, steps, expected, actual: {}, status: "PASS", durationMs: 0, evidence: `docs/report/blackbox-http-run.log#${id}` };
  try { item.actual = await action(); }
  catch (error) {
    const value = error as { message?: string; blocked?: boolean; actual?: unknown; expected?: unknown; actualResult?: Record<string, unknown> };
    item.status = value.blocked ? "BLOCKED" : "FAIL";
    item.actual = { ...item.actual, ...value.actualResult, failure: value.message || "检查失败", ...(value.actual !== undefined ? { observed: value.actual } : {}), ...(value.expected !== undefined ? { assertedExpected: value.expected } : {}) };
  }
  item.durationMs = Math.round(performance.now() - before);
  cases.push(item);
  const line = JSON.stringify({ id, status: item.status, durationMs: item.durationMs, actual: item.actual });
  caseLogs.push(line); console.log(line);
}
function expectStatus(result: Result, expected: number | number[]) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(allowed.includes(result.httpStatus), `HTTP状态预期 ${allowed.join("/")}，实际 ${result.httpStatus}；${result.data?.code || ""}`);
}
async function poll(route: string, predicate: (data: any) => boolean, timeout = 20000): Promise<Result> {
  const deadline = Date.now() + timeout;
  let latest: Result;
  do {
    latest = await http(route);
    expectStatus(latest, 200);
    if (predicate(latest.data)) return latest;
    if (latest.data.status === "failed") throw new Error(`后台任务失败：${latest.data.error || "unknown"}`);
    await pause(300);
  } while (Date.now() < deadline);
  throw new Error("等待后台状态超时");
}
function draftPayload(overrides: Record<string, unknown> = {}) {
  requireValue(capture, "采集草稿");
  return { title: capture.title, passage: capture.passage, questions: capture.questions, expectedVersion: capture.version, ...overrides };
}
function responsesFor(session: any, values = ["apples", "children", "teachers"]) {
  return session.items.map((item: any, index: number) => ({ itemId: item.id, response: values[index] || "wrong" }));
}

try {
  launch("web", [path.resolve("node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)]);
  launch("worker", [path.resolve("node_modules/tsx/dist/cli.mjs"), "src/worker.ts"]);
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const result = await http("/api/config");
      if (result.httpStatus === 200) {
        assert.equal(result.data.storage, "local"); assert.equal(result.data.aiConfigured, false); assert.equal(result.data.authConfigured, false);
        healthy = true; break;
      }
    } catch {}
    await pause(500);
  }
  assert.ok(healthy, "隔离HTTP服务未启动或未正确隔离凭据");

  await record("BB-001", "首页HTTP渲染", "页面", ["Next服务已启动"], { method: "GET", path: "/" }, ["请求首页HTML"], { httpStatus: 200, title: "Grammar Loop" }, async () => {
    const r = await http("/"); expectStatus(r, 200); assert.equal(r.data.hasGrammarLoopTitle, true); return summary(r, { hasGrammarLoopTitle: true, contentType: r.data.contentType });
  });
  await record("BB-002", "运行配置脱敏且隔离", "配置", ["外部凭据在子进程强制为空"], { method: "GET", path: "/api/config" }, ["读取公开配置"], { storage: "local", aiConfigured: false, authConfigured: false, secretsAbsent: true }, async () => {
    const r = await http("/api/config"); expectStatus(r, 200); assert.equal(r.data.storage, "local"); assert.equal(r.data.aiConfigured, false); assert.equal(r.data.authConfigured, false); assert.ok(!Object.keys(r.data).some(key => /key|password|token|databaseurl/i.test(key))); return summary(r, r.data);
  });
  await record("BB-003", "样本元数据30题且不泄露答案", "数据公开边界", [], { method: "GET", path: "/api/samples" }, ["读取样本摘要", "检查字段与题数"], { samples: 3, questions: 30, answerFieldsAbsent: true }, async () => {
    const r = await http("/api/samples"); expectStatus(r, 200); assert.equal(r.data.length, 3); assert.equal(r.data.reduce((n: number, item: any) => n + item.questionCount, 0), 30); assert.ok(r.data.every((item: any) => !item.questions && !item.answers && !item.passage)); return summary(r, { samples: 3, questions: 30, answerFieldsAbsent: true });
  });
  await record("BB-004", "首次访问空状态与会话Cookie", "会话", [], { method: "GET", path: "/api/me/overview" }, ["创建匿名本地会话A", "检查空记录和Cookie属性"], { submissions: 0, HttpOnly: true, SameSiteLax: true }, async () => {
    const r = await http("/api/me/overview"); expectStatus(r, 200); assert.equal(r.data.submissions.length, 0); const cookie = r.headers.get("set-cookie") || ""; assert.ok(cookie.includes("HttpOnly")); assert.ok(cookie.includes("SameSite=Lax")); return summary(r, { submissions: 0, cookieIssued: Boolean(cookie), httpOnly: true, sameSiteLax: true });
  });
  await record("BB-005", "非法JSON拒绝", "输入校验", [], { method: "POST", path: "/api/captures", body: "{" }, ["发送无法解析的JSON"], { httpStatus: 400, code: "INVALID_INPUT" }, async () => { const r = await http("/api/captures", "POST", "{"); expectStatus(r, 400); assert.equal(r.data.code, "INVALID_INPUT"); return summary(r); });
  await record("BB-006", "顶层数组JSON拒绝", "输入校验", [], { method: "POST", path: "/api/captures", body: [] }, ["发送数组作为请求体"], { httpStatus: 400 }, async () => { const r = await http("/api/captures", "POST", []); expectStatus(r, 400); return summary(r); });
  await record("BB-007", "缺少样例标识拒绝", "输入校验", [], { method: "POST", path: "/api/captures", body: { clientRequestId: "有效UUID" } }, ["不提供sampleId"], { httpStatus: 400 }, async () => { const r = await http("/api/captures", "POST", { clientRequestId: randomUUID() }); expectStatus(r, 400); return summary(r); });
  await record("BB-008", "短幂等键拒绝", "输入校验", [], { method: "POST", path: "/api/captures", body: { sampleId: "gaokao-2025-national-i", clientRequestId: "short" } }, ["提交少于8字符的请求标识"], { httpStatus: 400 }, async () => { const r = await http("/api/captures", "POST", { sampleId: "gaokao-2025-national-i", clientRequestId: "short" }); expectStatus(r, 400); return summary(r); });
  await record("BB-009", "未知样例返回404", "输入校验", [], { method: "POST", path: "/api/captures", body: { sampleId: "not-a-sample", clientRequestId: "有效UUID" } }, ["引用不存在样例"], { httpStatus: 404 }, async () => { const r = await http("/api/captures", "POST", { sampleId: "not-a-sample", clientRequestId: randomUUID() }); expectStatus(r, 404); return summary(r); });
  await record("BB-010", "跨域Origin写请求拒绝", "来源保护", [], { method: "POST", path: "/api/captures", origin: "https://unrelated.example" }, ["发送非本站Origin"], { httpStatus: 403, code: "FORBIDDEN" }, async () => { const r = await http("/api/captures", "POST", { sampleId: "gaokao-2025-national-i", clientRequestId: randomUUID() }, clientA, { Origin: "https://unrelated.example" }); expectStatus(r, 403); assert.equal(r.data.code, "FORBIDDEN"); return summary(r); });
  await record("BB-011", "导入2025真题样例", "主流程", [], { method: "POST", path: "/api/captures", body: { sampleId: "gaokao-2025-national-i", clientRequestId: "固定测试UUID-A" } }, ["同源请求导入样例", "检查完整篇章和十小题"], { httpStatus: 201, mode: "sample", questions: 10, sourceDisclosure: true }, async () => {
    const r = await http("/api/captures", "POST", { sampleId: "gaokao-2025-national-i", clientRequestId: captureKey }, clientA, { Origin: origin }); expectStatus(r, 201); capture = r.data; originalCapture = structuredClone(capture); assert.equal(capture.mode, "sample"); assert.equal(capture.questions.length, 10); assert.ok(capture.passage.includes("{{56}}")); assert.ok(capture.warnings.some((item: string) => item.includes("未调用 DeepSeek"))); return summary(r, { mode: capture.mode, status: capture.status, questionCount: 10, version: capture.version, warningsPresent: capture.warnings.length });
  });
  await record("BB-012", "重复导入同幂等键复用草稿", "幂等", ["BB-011成功"], { method: "POST", path: "/api/captures", body: "与BB-011相同" }, ["重放相同请求"], { httpStatus: 200, sameCapture: true }, async () => { requireValue(capture, "采集草稿"); const r = await http("/api/captures", "POST", { sampleId: "gaokao-2025-national-i", clientRequestId: captureKey }); expectStatus(r, 200); assert.equal(r.data.id, capture.id); return summary(r, { sameCapture: true }); });
  await record("BB-013", "相同幂等键不同内容拒绝", "幂等", ["BB-011成功"], { method: "POST", path: "/api/captures", body: { sampleId: "gaokao-2023-new-standard-i", clientRequestId: "固定测试UUID-A" } }, ["更换样例但复用请求标识"], { httpStatus: 409, code: "IDEMPOTENCY_CONFLICT" }, async () => { const r = await http("/api/captures", "POST", { sampleId: "gaokao-2023-new-standard-i", clientRequestId: captureKey }); expectStatus(r, 409); assert.equal(r.data.code, "IDEMPOTENCY_CONFLICT"); return summary(r); });
  await record("BB-014", "读取草稿与页面刷新入口", "恢复", ["BB-011成功"], { method: "GET", path: "/api/captures/{captureId}" }, ["使用稳定ID再次读取", "请求/capture?id=同一ID页面"], { apiStatus: 200, pageStatus: 200, sameCapture: true }, async () => { requireValue(capture, "草稿"); const r = await http(`/api/captures/${capture.id}`); expectStatus(r, 200); assert.equal(r.data.id, capture.id); const page = await http(`/capture?id=${capture.id}`); expectStatus(page, 200); return summary(r, { pageStatus: page.httpStatus, sameCapture: true }); });
  await record("BB-015", "跨本地会话读取草稿拒绝", "隔离", ["BB-011成功", "会话B没有A的Cookie"], { method: "GET", path: "/api/captures/{A.captureId}", client: "B" }, ["创建会话B读取A草稿"], { httpStatus: 404 }, async () => { requireValue(capture, "草稿"); const r = await http(`/api/captures/${capture.id}`, "GET", undefined, clientB); expectStatus(r, 404); return summary(r); });
  await record("BB-016", "样例无原图返回404", "图片读取", ["BB-011成功"], { method: "GET", path: "/api/captures/{captureId}/image" }, ["请求仅文本回放样例的图片"], { httpStatus: 404 }, async () => { requireValue(capture, "草稿"); const r = await http(`/api/captures/${capture.id}/image`); expectStatus(r, 404); return summary(r); });
  await record("BB-017", "草稿小题null拒绝", "输入边界", ["BB-011成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: { questions: [null], expectedVersion: "当前版本" } }, ["小题数组包含null"], { httpStatus: 400 }, async () => { const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ questions: [null] })); expectStatus(r, 400); return summary(r); });
  await record("BB-018", "重复题号拒绝", "输入边界", ["BB-011成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: "两道小题拥有相同number" }, ["保留不同id但使题号重复"], { httpStatus: 400 }, async () => { const q = capture.questions.slice(0, 2).map((item: any) => ({ ...item })); q[1].number = q[0].number; const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ questions: q })); expectStatus(r, 400); return summary(r); });
  await record("BB-019", "重复已有题目ID拒绝", "输入边界", ["BB-011成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: "不同题号复用同一已有id" }, ["复制已有id到另一题"], { httpStatus: 400 }, async () => { const q = capture.questions.slice(0, 2).map((item: any) => ({ ...item })); q[1].id = q[0].id; const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ questions: q })); expectStatus(r, 400); return summary(r); });
  await record("BB-020", "非数字题号拒绝", "输入边界", ["BB-011成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: "number=abc" }, ["将第一题题号改为abc"], { httpStatus: 400 }, async () => { const q = capture.questions.map((item: any) => ({ ...item })); q[0].number = "abc"; const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ questions: q })); expectStatus(r, 400); return summary(r); });
  await record("BB-021", "空小题数组拒绝", "输入边界", ["BB-011成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: { questions: [] } }, ["删除全部小题后保存"], { httpStatus: 400 }, async () => { const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ questions: [] })); expectStatus(r, 400); return summary(r); });
  await record("BB-022", "草稿保存并递增版本", "主流程", ["BB-011成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: "沿用完整篇章和十题，标题加HTTP测试前缀" }, ["使用当前版本保存"], { httpStatus: 200, versionIncrement: 1 }, async () => { const version = capture.version; const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ title: `HTTP黑盒测试 · ${capture.title}` })); expectStatus(r, 200); assert.equal(r.data.version, version + 1); capture = r.data; return summary(r, { versionIncrement: 1, questions: capture.questions.length }); });
  await record("BB-023", "旧草稿版本更新拒绝", "版本冲突", ["BB-022成功"], { method: "PATCH", path: "/api/captures/{captureId}", body: { expectedVersion: "前一版本" } }, ["重放旧版本草稿更新"], { httpStatus: 409, code: "VERSION_CONFLICT" }, async () => { const r = await http(`/api/captures/${capture.id}`, "PATCH", draftPayload({ expectedVersion: capture.version - 1 })); expectStatus(r, 409); assert.equal(r.data.code, "VERSION_CONFLICT"); return summary(r); });
  await record("BB-024", "缺AI配置时真实PNG上传明确阻断", "配置异常", ["aiConfigured=false"], { method: "POST", path: "/api/captures", multipart: "image=PNG fixture; clientRequestId=UUID" }, ["上传PNG", "检查错误不是假识别结果"], { httpStatus: 503, code: "CONFIG_REQUIRED", captureAbsent: true }, async () => { const form = new FormData(); form.set("image", new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6eoAAAAASUVORK5CYII=", "base64")], "fixture.png", { type: "image/png" })); form.set("clientRequestId", randomUUID()); const r = await http("/api/captures", "POST", form); expectStatus(r, 503); assert.equal(r.data.code, "CONFIG_REQUIRED"); assert.equal(r.data.id, undefined); return summary(r, { captureAbsent: true }); });
  await record("BB-025", "无AI配置时PDF先被配置门禁阻断", "校验顺序", ["aiConfigured=false"], { method: "POST", path: "/api/captures", multipart: "image=PDF fixture" }, ["上传不支持格式", "记录实际校验优先级"], { httpStatus: 503, code: "CONFIG_REQUIRED", limitation: "未到达文件格式解码分支" }, async () => { const form = new FormData(); form.set("image", new File(["%PDF-1.0"], "fixture.pdf", { type: "application/pdf" })); form.set("clientRequestId", randomUUID()); const r = await http("/api/captures", "POST", form); expectStatus(r, 503); return summary(r, { formatValidationReached: false, limitation: "此用例仅验证缺配置优先阻断；格式422由白盒单独覆盖" }); });
  await record("BB-026", "超过10MB文件拒绝", "上传边界", [], { method: "POST", path: "/api/captures", multipart: "image=10MiB+1字节PNG声明" }, ["上传超过最大大小的文件"], { httpStatus: 413 }, async () => { const form = new FormData(); form.set("image", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })); form.set("clientRequestId", randomUUID()); const r = await http("/api/captures", "POST", form); expectStatus(r, 413); return summary(r); });
  await record("BB-027", "表单缺image拒绝", "上传边界", [], { method: "POST", path: "/api/captures", multipart: "仅clientRequestId" }, ["提交没有图片的multipart"], { httpStatus: 400 }, async () => { const form = new FormData(); form.set("clientRequestId", randomUUID()); const r = await http("/api/captures", "POST", form); expectStatus(r, 400); return summary(r); });
  await record("BB-028", "JSON体超过应用上限拒绝", "请求边界", [], { method: "POST", path: "/api/captures", jsonCharacters: 1000001 }, ["发送超过1,000,000字符的JSON请求体"], { httpStatus: 413 }, async () => { const r = await http("/api/captures", "POST", JSON.stringify({ text: "x".repeat(1_000_000) })); expectStatus(r, 413); return summary(r); });
  await record("BB-029", "创建异步诊断", "主流程", ["BB-022成功"], { method: "POST", path: "/api/submissions", body: "captureId、当前inputVersion、固定请求键B" }, ["提交确认草稿", "检查202和新结果ID"], { httpStatus: 202, status: "queued" }, async () => { requireValue(capture, "草稿"); const r = await http("/api/submissions", "POST", { captureId: capture.id, inputVersion: capture.version, clientRequestId: submissionKey }); expectStatus(r, 202); submission = r.data; assert.equal(submission.mode, "sample"); return summary(r, { resourceStatus: submission.status, mode: submission.mode, questionCount: submission.questions.length }); });
  await record("BB-030", "后台诊断完成并可重复读取", "异步与恢复", ["BB-029成功", "Worker运行"], { method: "GET", path: "/api/submissions/{submissionId}" }, ["按HTTP轮询完成状态", "再次GET同一ID"], { httpStatus: 200, completed: true, questions: 10, totalScore: 4.5, maxScore: 15 }, async () => { requireValue(submission, "诊断"); const r = await poll(`/api/submissions/${submission.id}`, value => value.status === "completed"); submission = r.data; question = submission.questions.find((item: any) => item.gradeStatus === "incorrect"); assert.equal(submission.questions.length, 10); assert.equal(submission.questions.reduce((sum: number, item: any) => sum + item.score, 0), 4.5); assert.equal(submission.questions.reduce((sum: number, item: any) => sum + item.maxScore, 0), 15); const again = await http(`/api/submissions/${submission.id}`); assert.equal(again.data.id, submission.id); return summary(r, { completed: true, questions: 10, correct: submission.questions.filter((item: any) => item.gradeStatus === "correct").length, totalScore: 4.5, maxScore: 15, source: submission.questions[0].answerSource }); });
  await record("BB-031", "重复诊断提交不重复创建", "幂等", ["BB-030成功"], { method: "POST", path: "/api/submissions", body: "与BB-029相同" }, ["重放原请求", "查看概览提交数量"], { httpStatus: 200, sameSubmission: true, totalSubmissions: 1 }, async () => { const r = await http("/api/submissions", "POST", { captureId: capture.id, inputVersion: capture.version, clientRequestId: submissionKey }); expectStatus(r, 200); assert.equal(r.data.id, submission.id); const overview = await http("/api/me/overview"); assert.equal(overview.data.stats.submissions, 1); return summary(r, { sameSubmission: true, totalSubmissions: 1 }); });
  await record("BB-032", "同草稿版本不同请求键仍复用诊断", "幂等", ["BB-030成功"], { method: "POST", path: "/api/submissions", body: "相同captureId/inputVersion，新请求键" }, ["提交相同草稿版本"], { httpStatus: 200, sameSubmission: true }, async () => { const r = await http("/api/submissions", "POST", { captureId: capture.id, inputVersion: capture.version, clientRequestId: randomUUID() }); expectStatus(r, 200); assert.equal(r.data.id, submission.id); return summary(r, { sameSubmission: true }); });
  await record("BB-033", "旧输入版本新请求拒绝", "版本冲突", ["BB-022成功"], { method: "POST", path: "/api/submissions", body: { inputVersion: "前一版本", clientRequestId: "新UUID" } }, ["提交与现草稿不一致版本"], { httpStatus: 409, code: "VERSION_CONFLICT" }, async () => { const r = await http("/api/submissions", "POST", { captureId: capture.id, inputVersion: capture.version - 1, clientRequestId: randomUUID() }); expectStatus(r, 409); return summary(r); });
  await record("BB-034", "跨会话读取诊断拒绝", "隔离", ["BB-030成功"], { method: "GET", path: "/api/submissions/{A.submissionId}", client: "B" }, ["会话B读取会话A结果"], { httpStatus: 404 }, async () => { const r = await http(`/api/submissions/${submission.id}`, "GET", undefined, clientB); expectStatus(r, 404); return summary(r); });
  await record("BB-035", "未知标签拒绝", "输入校验", ["BB-030成功"], { method: "PATCH", path: "/api/questions/{questionId}/diagnosis", body: { tagId: "invented-tag", expectedVersion: "当前版本" } }, ["保存白名单外标签"], { httpStatus: 400 }, async () => { const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { tagId: "invented-tag", expectedVersion: question.diagnosisVersion }); expectStatus(r, 400); return summary(r); });
  await record("BB-036", "异议字段非boolean拒绝", "输入校验", ["BB-030成功"], { method: "PATCH", path: "/api/questions/{questionId}/diagnosis", body: { disputed: "true" } }, ["以字符串提交异议"], { httpStatus: 400 }, async () => { const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { disputed: "true", expectedVersion: question.diagnosisVersion }); expectStatus(r, 400); return summary(r); });
  await record("BB-037", "改标并更新讲解与复习任务", "主流程", ["BB-030成功"], { method: "PATCH", path: "/api/questions/{questionId}/diagnosis", body: { tagId: "noun", note: "HTTP黑盒测试", expectedVersion: "当前版本" } }, ["将首道错题个人分类改为名词", "轮询讲解完成", "读取概览"], { httpStatus: 200, versionIncrement: 1, explanationReady: true, reviewTagPresent: true }, async () => { const oldVersion = question.diagnosisVersion; const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { tagId: "noun", expectedVersion: oldVersion, note: "HTTP黑盒测试" }); expectStatus(r, 200); const result = await poll(`/api/submissions/${submission.id}`, value => value.questions.find((item: any) => item.id === question.id)?.explanationStatus === "ready"); question = result.data.questions.find((item: any) => item.id === question.id); assert.equal(question.tagId, "noun"); assert.equal(question.diagnosisVersion, oldVersion + 1); const overview = await http("/api/me/overview"); assert.ok(overview.data.reviewTasks.some((task: any) => task.tagId === "noun")); return summary(r, { tagId: "noun", versionIncrement: 1, explanationReady: true, reviewTagPresent: true }); });
  await record("BB-038", "旧诊断版本改标拒绝", "版本冲突", ["BB-037成功"], { method: "PATCH", path: "/api/questions/{questionId}/diagnosis", body: { expectedVersion: "前一版本" } }, ["用旧版本修改标签"], { httpStatus: 409 }, async () => { const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { tagId: "article", expectedVersion: question.diagnosisVersion - 1 }); expectStatus(r, 409); return summary(r); });
  await record("BB-039", "跨会话改标拒绝", "隔离", ["BB-037成功"], { method: "PATCH", path: "/api/questions/{A.questionId}/diagnosis", client: "B" }, ["会话B修改A的题目"], { httpStatus: 404 }, async () => { const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { tagId: "article", expectedVersion: question.diagnosisVersion }, clientB); expectStatus(r, 404); return summary(r); });
  await record("BB-040", "异议从待巩固统计和复习排除", "联动", ["BB-037成功"], { method: "PATCH", path: "/api/questions/{questionId}/diagnosis", body: { disputed: true } }, ["记录原错题数量", "标记异议", "读取概览"], { httpStatus: 200, incorrectDelta: -1, disputed: true }, async () => { const before = (await http("/api/me/overview")).data.stats.incorrect; const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { disputed: true, expectedVersion: question.diagnosisVersion }); expectStatus(r, 200); question = r.data.questions.find((item: any) => item.id === question.id); const after = (await http("/api/me/overview")).data; assert.equal(after.stats.incorrect, before - 1); assert.equal(question.disputed, true); assert.ok(!after.reviewTasks.some((task: any) => task.tagId === "noun")); return summary(r, { incorrectDelta: -1, disputed: true, reviewTaskRemoved: true }); });
  await record("BB-041", "取消异议恢复复习任务", "联动", ["BB-040成功"], { method: "PATCH", path: "/api/questions/{questionId}/diagnosis", body: { disputed: false } }, ["取消异议", "检查统计和复习"], { httpStatus: 200, incorrect: 7, reviewTaskRestored: true }, async () => { const r = await http(`/api/questions/${question.id}/diagnosis`, "PATCH", { disputed: false, expectedVersion: question.diagnosisVersion }); expectStatus(r, 200); question = r.data.questions.find((item: any) => item.id === question.id); const overview = (await http("/api/me/overview")).data; assert.equal(overview.stats.incorrect, 7); assert.ok(overview.reviewTasks.some((task: any) => task.tagId === "noun")); return summary(r, { incorrect: 7, reviewTaskRestored: true }); });
  await record("BB-042", "创建针对性练习", "主流程", ["BB-041成功"], { method: "POST", path: "/api/review/sessions", body: "当前noun复习任务ID、固定请求键C、sample模式" }, ["从概览取得公开复习任务ID", "创建三题练习"], { httpStatus: 202, mode: "sample" }, async () => { const overview = (await http("/api/me/overview")).data; const task = overview.reviewTasks.find((item: any) => item.tagId === "noun"); requireValue(task, "名词复习任务"); const r = await http("/api/review/sessions", "POST", { reviewTaskId: task.id, mode: "sample", clientRequestId: practiceKey }); expectStatus(r, 202); practice = r.data; return summary(r, { mode: practice.mode, resourceStatus: practice.status }); });
  await record("BB-043", "练习提交前答案与解析隐藏", "答案保护", ["BB-042成功", "Worker运行"], { method: "GET", path: "/api/review/sessions/{sessionId}" }, ["轮询练习生成完成", "检查公开items字段"], { httpStatus: 200, itemCount: 3, answersAbsent: true, explanationsAbsent: true }, async () => { requireValue(practice, "练习"); const r = await poll(`/api/review/sessions/${practice.id}`, value => value.status === "completed"); practice = r.data; assert.equal(practice.items.length, 3); assert.ok(practice.items.every((item: any) => item.answers === undefined && item.explanation === undefined)); assert.equal(practice.results.length, 0); return summary(r, { itemCount: 3, answersAbsent: true, explanationsAbsent: true, resultsEmpty: true, sampleLabel: practice.sampleLabel }); });
  await record("BB-044", "重复练习请求复用会话", "幂等", ["BB-042成功"], { method: "POST", path: "/api/review/sessions", body: "与BB-042相同请求键与内容" }, ["重放练习创建请求"], { httpStatus: 202, sameSession: true }, async () => { const overview = (await http("/api/me/overview")).data; const task = overview.reviewTasks.find((item: any) => item.tagId === "noun"); const r = await http("/api/review/sessions", "POST", { reviewTaskId: task.id, mode: "sample", clientRequestId: practiceKey }); expectStatus(r, 202); assert.equal(r.data.id, practice.id); return summary(r, { sameSession: true }); });
  await record("BB-045", "跨会话读取练习拒绝", "隔离", ["BB-043成功"], { method: "GET", path: "/api/review/sessions/{A.sessionId}", client: "B" }, ["会话B读取A练习"], { httpStatus: 404 }, async () => { const r = await http(`/api/review/sessions/${practice.id}`, "GET", undefined, clientB); expectStatus(r, 404); return summary(r); });
  await record("BB-046", "练习缺题作答拒绝", "作答边界", ["BB-043成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "仅两道response" }, ["少提交一题"], { httpStatus: 422 }, async () => { const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses: responsesFor(practice).slice(0, 2), clientRequestId: randomUUID() }); expectStatus(r, 422); return summary(r); });
  await record("BB-047", "练习重复题ID拒绝", "作答边界", ["BB-043成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "三道response但重复itemId" }, ["复制第一题ID到第二题"], { httpStatus: 422 }, async () => { const responses = responsesFor(practice); responses[1].itemId = responses[0].itemId; const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses, clientRequestId: randomUUID() }); expectStatus(r, 422); return summary(r); });
  await record("BB-048", "练习未知题ID拒绝", "作答边界", ["BB-043成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "包含不存在itemId" }, ["替换一题ID为随机UUID"], { httpStatus: 422 }, async () => { const responses = responsesFor(practice); responses[0].itemId = randomUUID(); const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses, clientRequestId: randomUUID() }); expectStatus(r, 422); return summary(r); });
  await record("BB-049", "练习答案非字符串拒绝", "作答边界", ["BB-043成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "response=42" }, ["将第一题答案改为数值"], { httpStatus: 400 }, async () => { const responses: any[] = responsesFor(practice); responses[0].response = 42; const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses, clientRequestId: randomUUID() }); expectStatus(r, 400); return summary(r); });
  await record("BB-050", "练习null元素应作为客户端错误处理", "健壮性", ["BB-043成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: { responses: [null, null, null], clientRequestId: "新UUID" } }, ["发送长度正确但元素为null的作答数组"], { httpStatus: [400, 422], noInternalError: true }, async () => { const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses: [null, null, null], clientRequestId: randomUUID() }); const actual = summary(r); if (![400, 422].includes(r.httpStatus)) throw Object.assign(new Error(`预期4xx输入校验，实际 ${r.httpStatus} / ${r.data.code}`), { actualResult: actual }); return actual; });
  await record("BB-051", "正确提交展示结果并安排3天复习", "主流程", ["BB-043成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "根据可见名词练习独立填写apples/children/teachers，固定请求键D" }, ["提交三道答案", "检查反馈与下次复习"], { httpStatus: 200, correct: 3, results: 3, nextDueDays: 3 }, async () => { const before = Date.now(); const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses: responsesFor(practice), clientRequestId: attemptKey }); expectStatus(r, 200); assert.equal(r.data.results.length, 3); assert.equal(r.data.results.filter((item: any) => item.correct).length, 3); const days = (Date.parse(r.data.nextDueAt) - before) / 86400000; assert.ok(days > 2.99 && days < 3.01); practice = r.data; return summary(r, { results: 3, correct: 3, nextDueDays: 3, explanationsPresent: r.data.results.every((item: any) => item.explanation && item.answers.length) }); });
  await record("BB-052", "重复作答提交不重复计数", "幂等", ["BB-051成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "同会话、同内容、同请求键D" }, ["重放作答", "读取练习数量"], { httpStatus: 200, practiced: 3 }, async () => { const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses: responsesFor(practice), clientRequestId: attemptKey }); expectStatus(r, 200); const overview = (await http("/api/me/overview")).data; assert.equal(overview.stats.practiced, 3); return summary(r, { practiced: 3, completedAtUnchanged: r.data.completedAt === practice.completedAt }); });
  await record("BB-053", "同作答请求键不同内容拒绝", "幂等", ["BB-051成功"], { method: "POST", path: "/api/review/sessions/{sessionId}/attempts", body: "同键D但答案更改" }, ["修改答案后复用请求键"], { httpStatus: 409, code: "IDEMPOTENCY_CONFLICT" }, async () => { const r = await http(`/api/review/sessions/${practice.id}/attempts`, "POST", { responses: responsesFor(practice, ["wrong", "wrong", "wrong"]), clientRequestId: attemptKey }); expectStatus(r, 409); return summary(r); });
  await record("BB-054", "完成后刷新可读结果与历史", "恢复", ["BB-051成功"], { method: "GET", path: "/api/review/sessions/{sessionId}; /api/me/overview" }, ["重新GET会话", "读取首页聚合"], { httpStatus: 200, results: 3, historySaved: true }, async () => { const r = await http(`/api/review/sessions/${practice.id}`); expectStatus(r, 200); assert.equal(r.data.results.length, 3); const overview = (await http("/api/me/overview")).data; assert.ok(overview.sessions.some((item: any) => item.id === practice.id && item.results.length === 3)); assert.equal(overview.stats.bySource.sample, 7); return summary(r, { results: 3, historySaved: true, sampleIncorrect: 7, cloudCalls: 0 }); });
  await record("BB-055", "答错练习重置为次日复习", "复习联动", ["会话A已建立"], { method: "POST", path: "/api/review/sessions; /api/review/sessions/{id}/attempts", body: "创建article演示练习，三题均填wrong" }, ["创建新考点练习", "轮询三题", "提交错误答案"], { correct: 0, nextDueDays: 1, practiced: 6 }, async () => { const created = await http("/api/review/sessions", "POST", { tagId: "article", mode: "sample", clientRequestId: randomUUID() }); expectStatus(created, 202); const ready = await poll(`/api/review/sessions/${created.data.id}`, value => value.status === "completed"); practice2 = ready.data; const before = Date.now(); const r = await http(`/api/review/sessions/${practice2.id}/attempts`, "POST", { responses: responsesFor(practice2, ["wrong", "wrong", "wrong"]), clientRequestId: randomUUID() }); expectStatus(r, 200); assert.equal(r.data.results.filter((item: any) => item.correct).length, 0); const days = (Date.parse(r.data.nextDueAt) - before) / 86400000; assert.ok(days > .99 && days < 1.01); const overview = (await http("/api/me/overview")).data; assert.equal(overview.stats.practiced, 6); return summary(r, { correct: 0, nextDueDays: 1, practiced: 6 }); });
  await record("BB-056", "作答幂等键不能跨会话误用", "幂等", ["BB-055成功"], { method: "POST", path: "/api/review/sessions/{session2Id}/attempts", body: "复用会话1请求键D及旧responses" }, ["向第二会话提交第一会话幂等键"], { httpStatus: 409 }, async () => { const r = await http(`/api/review/sessions/${practice2.id}/attempts`, "POST", { responses: responsesFor(practice), clientRequestId: attemptKey }); expectStatus(r, 409); return summary(r); });
  await record("BB-057", "未知API路径返回404", "路由", [], { method: "GET", path: "/api/not-a-route" }, ["请求不存在接口"], { httpStatus: 404, code: "NOT_FOUND" }, async () => { const r = await http("/api/not-a-route"); expectStatus(r, 404); assert.equal(r.data.code, "NOT_FOUND"); return summary(r); });
  await record("BB-058", "未导出HTTP方法返回405", "路由", [], { method: "PUT", path: "/api/captures" }, ["请求未导出的PUT方法"], { httpStatus: 405 }, async () => { const r = await http("/api/captures", "PUT", {}); expectStatus(r, 405); return summary(r); });
  await record("BB-059", "已完成采集不允许重试", "状态约束", ["BB-011成功"], { method: "POST", path: "/api/captures/{captureId}/retry" }, ["重试已完成采集"], { httpStatus: 422 }, async () => { const r = await http(`/api/captures/${capture.id}/retry`, "POST"); expectStatus(r, 422); return summary(r); });
  await record("BB-060", "未知稳定资源ID返回404", "路由", [], { method: "GET", path: "/api/submissions/00000000-0000-0000-0000-000000000000" }, ["读取不存在的诊断ID"], { httpStatus: 404 }, async () => { const r = await http("/api/submissions/00000000-0000-0000-0000-000000000000"); expectStatus(r, 404); return summary(r); });
} catch (error) {
  caseLogs.push(JSON.stringify({ fatal: error instanceof Error ? error.message : "测试启动失败" }));
  console.log(caseLogs[caseLogs.length - 1]);
} finally {
  for (const entry of processes) {
    if (entry.child.exitCode === null) entry.child.kill("SIGTERM");
  }
  await Promise.all(processes.map(({ child }) => child.exitCode !== null ? Promise.resolve() : Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), pause(5000)])));
  for (const entry of processes) if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("grammar-loop-blackbox-"));
  await rm(temporary, { recursive: true, force: true }); cleaned = true;
  const summary = { total: cases.length, passed: cases.filter(item => item.status === "PASS").length, failed: cases.filter(item => item.status === "FAIL").length, blocked: cases.filter(item => item.status === "BLOCKED").length };
  const report = { startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), environment: { mode: "isolated-local-sample-http", port, node: process.version, externalCredentialsEmpty: true, realExternalCalls: false, processPids: processes.map(({ role, child }) => ({ role, pid: child.pid })), temporaryStorageCleaned: cleaned }, methodology: "只使用实际Next HTTP端口。未导入handleApi或业务内部函数，未读取内部状态来获取练习答案；由可见名词练习独立作答。未修改.env.local。", limitations: ["这些黑盒结果为本地样例模式，不是本轮真实DeepSeek/Supabase验证。", "无AI配置先返回503，格式解码分支未通过本轮HTTP测试执行。", "界面视觉与真实外部服务证据由其他报告提供。"], summary, cases };
  await writeFile(path.join(reportDir, "blackbox-cases.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(reportDir, "blackbox-http-run.log"), caseLogs.join("\n") + "\n\n--- isolated child process log ---\n" + serverLogs.join(""));
  console.log(JSON.stringify({ summary, cleaned, report: "docs/report/blackbox-cases.json" }));
  process.exitCode = summary.failed || summary.blocked || !healthy ? 1 : 0;
}
