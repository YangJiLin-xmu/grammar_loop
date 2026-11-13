import { mkdir, readFile, writeFile, rename, open, stat, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { StoreState } from "../lib/types";
import { AppError, config } from "./config";

export const dataRoot = path.resolve(/* turbopackIgnore: true */ process.env.LOCAL_DATA_DIR || ".data");
export const emptyState = (): StoreState => ({ captures: [], submissions: [], reviewTasks: [], sessions: [], tagEvents: [], jobs: [], modelLogs: [], requests: [] });
export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AppError("请在 .env.local 配置 Supabase URL 和服务端密钥。", 503, "CONFIG_REQUIRED");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
const validId = (id: string) => /^[a-zA-Z0-9-]{1,80}$/.test(id);
const stateFile = (userId: string) => {
  if (!validId(userId)) throw new AppError("无效用户标识", 400);
  return path.join(dataRoot, "users", `${userId}.json`);
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function readState(userId: string): Promise<StoreState> {
  if (config().storage === "supabase") {
    const { data, error } = await supabaseAdmin().from("gl_workspaces").select("state").eq("user_id", userId).maybeSingle();
    if (error) throw new AppError("读取数据库失败，请确认已执行数据库迁移。", 503, "DATABASE_ERROR");
    return { ...emptyState(), ...data?.state } as StoreState;
  }
  try { return JSON.parse(await readFile(stateFile(userId), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(); throw error; }
}
export async function updateState<T>(userId: string, mutate: (state: StoreState) => T): Promise<T> {
  if (config().storage === "supabase") {
    const client = supabaseAdmin();
    for (let attempt = 0; attempt < 12; attempt++) {
      const { data, error } = await client.from("gl_workspaces").select("state,revision").eq("user_id", userId).maybeSingle();
      if (error) throw new AppError("数据库读取失败", 503, "DATABASE_ERROR");
      const state = structuredClone({ ...emptyState(), ...data?.state }) as StoreState;
      const result = mutate(state);
      state.modelLogs = state.modelLogs.slice(-200);
      if (!data) {
        const inserted = await client.from("gl_workspaces").insert({ user_id: userId, revision: 1, state });
        if (!inserted.error) return result;
        if (inserted.error.code !== "23505") throw new AppError("数据库写入失败", 503, "DATABASE_ERROR");
      } else {
        const updated = await client.from("gl_workspaces").update({ state, revision: data.revision + 1, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("revision", data.revision).select("revision");
        if (updated.error) throw new AppError("数据库写入失败", 503, "DATABASE_ERROR");
        if (updated.data?.length) return result;
      }
      await pause(20 * (attempt + 1));
    }
    throw new AppError("数据已更新，请重试。", 409, "VERSION_CONFLICT");
  }
  const file = stateFile(userId);
  await mkdir(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { lock = await open(lockFile, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lockFile)).mtimeMs > 30000) await unlink(lockFile); } catch {}
      await pause(30);
    }
  }
  if (!lock) throw new AppError("数据正忙，请稍后重试", 503);
  try {
    const state = await readState(userId);
    const result = mutate(state);
    state.modelLogs = state.modelLogs.slice(-200);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    // Windows sync/indexing tools may briefly hold the destination without
    // delete sharing. Retry the atomic replacement instead of truncating it.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 19 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        await pause(Math.min(50 * (attempt + 1), 250));
      }
    }
    return result;
  } finally { await lock.close(); await unlink(lockFile).catch(() => {}); }
}
export async function listUserIds(): Promise<string[]> {
  if (config().storage === "supabase") {
    const { data, error } = await supabaseAdmin().from("gl_workspaces").select("user_id");
    if (error) throw error;
    return (data || []).map(row => row.user_id);
  }
  await mkdir(path.join(dataRoot, "users"), { recursive: true });
  return (await readdir(path.join(dataRoot, "users"))).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5));
}
export async function saveImage(userId: string, captureId: string, bytes: Buffer): Promise<string> {
  const key = `${userId}/${captureId}.jpg`;
  if (config().storage === "supabase") {
    const { error } = await supabaseAdmin().storage.from(process.env.SUPABASE_STORAGE_BUCKET || "grammar-loop").upload(key, bytes, { contentType: "image/jpeg", upsert: false });
    if (error) throw new AppError("图片保存失败，请检查私有存储配置。", 503, "STORAGE_ERROR");
  } else {
    const file = path.join(dataRoot, "uploads", key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return key;
}
export async function readImage(key: string): Promise<Buffer> {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.jpg$/.test(key)) throw new AppError("图片路径无效", 400);
  if (config().storage === "supabase") {
    const { data, error } = await supabaseAdmin().storage.from(process.env.SUPABASE_STORAGE_BUCKET || "grammar-loop").download(key);
    if (error || !data) throw new AppError("图片不存在", 404);
    return Buffer.from(await data.arrayBuffer());
  }
  return readFile(path.join(dataRoot, "uploads", key));
}
