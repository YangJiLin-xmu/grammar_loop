import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { AppError, config } from "./config";
import { dataRoot, supabaseAdmin } from "./store";

let localSecret: string | undefined;
async function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (localSecret) return localSecret;
  await mkdir(dataRoot, { recursive: true });
  const file = path.join(dataRoot, "session-secret");
  try { const fd = await open(file, "wx", 0o600); await fd.writeFile(randomBytes(32).toString("hex")); await fd.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await readFile(file, "utf8");
    if (value.length >= 32) { localSecret = value; return value; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new AppError("本地会话密钥尚未写入完成，请重试。", 503);
}
export async function authenticate(request: Request): Promise<{ userId: string; cookie?: string }> {
  if (config().storage === "supabase") {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new AppError("请先登录", 401, "AUTH_REQUIRED");
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data.user) throw new AppError("登录已过期，请重新登录", 401, "AUTH_REQUIRED");
    return { userId: data.user.id };
  }
  const key = await secret();
  const sign = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  const cookieValue = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith("gl_session="))?.slice(11);
  if (cookieValue) {
    const [userId, signature] = cookieValue.split(".");
    if (/^[a-f0-9-]{36}$/.test(userId || "") && /^[a-f0-9]{64}$/.test(signature || "")) {
      const expected = Buffer.from(sign(userId));
      const actual = Buffer.from(signature);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { userId };
    }
  }
  const userId = randomUUID();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return { userId, cookie: `gl_session=${userId}.${sign(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` };
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === process.env.APP_ORIGIN || origin === new URL(request.url).origin) return;
  // Next's internal Request URL may use localhost while the browser uses
  // 127.0.0.1. Compare the actual HTTP Host as well; never trust an arbitrary
  // forwarded host when authorizing cookie-backed mutations.
  try {
    const source = new URL(origin);
    if (["http:", "https:"].includes(source.protocol) && source.host === request.headers.get("host") && source.protocol === new URL(request.url).protocol) return;
  } catch {}
  throw new AppError("请求来源不匹配", 403, "FORBIDDEN");
}
