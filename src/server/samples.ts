import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sample, SampleSummary } from "../lib/types";
import { AppError } from "./config";
export async function samples(): Promise<Sample[]> {
  try { return JSON.parse(await readFile(path.join(process.cwd(), "data", "samples.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function getSample(id: string): Promise<Sample> {
  const sample = (await samples()).find(item => item.id === id);
  if (!sample) throw new AppError("真题样例不存在", 404);
  return sample;
}
export async function sampleSummaries(): Promise<SampleSummary[]> {
  return (await samples()).map(({ id, year, title, split, verification, questions }) => ({ id, year, title, split, verification, questionCount: questions.length }));
}
