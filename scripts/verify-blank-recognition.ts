// Explicit live regression check. Uses DEEPSEEK_API_KEY and makes three image
// recognition requests, but never connects to Supabase or alters user records.
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("请先配置 DEEPSEEK_API_KEY；此脚本会调用真实识别 API。");
const temporary = await mkdtemp(path.join(os.tmpdir(), "grammar-loop-blank-live-"));
process.env.LOCAL_DATA_DIR = temporary;
process.env.STORAGE_MODE = "local";
delete process.env.DATABASE_URL;
const { deepseekAI } = await import("../src/server/ai");
const { imageNormalizer } = await import("../src/server/files");
const cases = [];
try {
  for (const file of ["2023-question-page13.png", "2024-question-page10.png", "2025-question-page11.png"]) {
    const started = Date.now();
    try {
      const bytes = await imageNormalizer.normalize(await readFile(path.join("data/sources", file)), "image/png");
      const recognized = await deepseekAI.recognize(bytes, { userId: randomUUID(), targetId: randomUUID() });
      const result = {
        file, latencyMs: Date.now() - started, questionCount: recognized.questions.length,
        blank: recognized.questions.filter(question => question.answerStatus === "blank").length,
        uncertain: recognized.questions.filter(question => question.answerStatus === "uncertain").length,
        nonemptyAnswers: recognized.questions.filter(question => question.studentAnswer !== "").map(question => question.number),
        questions: recognized.questions.map(({ number, studentAnswer, answerStatus }) => ({ number, studentAnswer, answerStatus })),
        warnings: recognized.warnings,
        passed: recognized.questions.length === 10 && recognized.questions.every(question => question.studentAnswer === "" && question.answerStatus === "blank") && new Set(recognized.questions.map(question => question.number)).size === 10 && recognized.questions.every(question => Number(question.number) >= 56 && Number(question.number) <= 65),
      };
      cases.push(result);
      console.log(JSON.stringify({ file, questionCount: result.questionCount, blank: result.blank, uncertain: result.uncertain, nonemptyAnswers: result.nonemptyAnswers, passed: result.passed }));
    } catch (error) {
      const result = { file, latencyMs: Date.now() - started, passed: false, error: error instanceof Error ? error.message : "识别失败" };
      cases.push(result); console.log(JSON.stringify(result));
    }
  }
  await mkdir("docs/report", { recursive: true });
  await writeFile("docs/report/blank-recognition-live.json", JSON.stringify({ checkedAt: new Date().toISOString(), model: process.env.DEEPSEEK_MODEL || "deepseek-flash", method: "Live DeepSeek image recognition on three existing unfilled exam pages; isolated temporary local storage", cases, passed: cases.every(item => item.passed) }, null, 2));
  if (cases.some(item => !item.passed)) process.exitCode = 1;
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("grammar-loop-blank-live-"));
  await rm(temporary, { recursive: true, force: true });
}
