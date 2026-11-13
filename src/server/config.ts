export const config = () => ({
  storage: (process.env.STORAGE_MODE === "supabase" ? "supabase" : "local") as "local" | "supabase",
  aiConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
  authConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
  sampleMode: process.env.ENABLE_SAMPLE_MODE !== "false",
});
export class AppError extends Error {
  constructor(message: string, public status = 400, public code = "INVALID_INPUT") { super(message); }
}
export function assert(condition: unknown, message: string, status = 400, code?: string): asserts condition {
  if (!condition) throw new AppError(message, status, code);
}
