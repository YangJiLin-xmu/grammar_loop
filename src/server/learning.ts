import { randomUUID } from "node:crypto";
import type { QuestionResult, ReviewTask, StoreState } from "../lib/types";
export const normalizeAnswer = (answer: string) => answer.normalize("NFKC").trim().replace(/\s+/g, " ");
export function gradeAnswer(answer: string, references: string[], uncertain = false): QuestionResult["gradeStatus"] {
  if (uncertain || answer.includes("无法辨认") || !references.length) return "uncertain";
  return references.some(reference => normalizeAnswer(reference) === normalizeAnswer(answer)) ? "correct" : "incorrect";
}
export interface ReviewScheduler { nextDue(previousLevel: number, correct: boolean, now?: Date): { level: number; dueAt: string } }
export const fixedScheduler: ReviewScheduler = {
  nextDue(previousLevel, correct, now = new Date()) {
    const level = correct ? Math.min(previousLevel + 1, 2) : 0;
    return { level, dueAt: new Date(now.getTime() + [1, 3, 7][level] * 86400000).toISOString() };
  },
};
export function rebuildReviewTasks(state: StoreState, userId: string, now = new Date()) {
  const byTag = new Map<string, { question: QuestionResult; submissionId: string }>();
  for (const submission of state.submissions) {
    if (submission.status !== "completed") continue;
    for (const question of submission.questions) if (question.gradeStatus === "incorrect" && !question.disputed) byTag.set(question.tagId, { question, submissionId: submission.id });
  }
  for (const task of state.reviewTasks) {
    if (task.status !== "pending") continue;
    if (!byTag.has(task.tagId)) task.status = "completed";
  }
  for (const [tagId, { question, submissionId }] of byTag) {
    let task = state.reviewTasks.find(item => item.tagId === tagId && item.status === "pending");
    if (!task) {
      const schedule = fixedScheduler.nextDue(0, false, now);
      task = { id: randomUUID(), userId, tagId, sourceQuestionId: question.id, sourceSubmissionId: submissionId, status: "pending", tentative: question.answerSource === "ai", ...schedule } satisfies ReviewTask;
      state.reviewTasks.push(task);
    } else {
      task.sourceQuestionId = question.id;
      task.sourceSubmissionId = submissionId;
      task.tentative = question.answerSource === "ai";
    }
  }
}
export function publicSession<T extends { items: { answers: string[]; explanation: string }[] }>(session: T) {
  return { ...session, items: session.items.map(({ answers: _answers, explanation: _explanation, ...item }) => item) };
}
