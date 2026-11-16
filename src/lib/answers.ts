import type { InputQuestion, StudentAnswerStatus } from "./types";

// Blank lines and empty markers are not student-written English answers.
export function isBlankAnswer(answer: string): boolean {
  const value = answer.normalize("NFKC").trim();
  return !value || /^[_—–\-\s]+$/u.test(value) || /^(?:未作答|未填写|未填|未答|空白|\[空白\]|\(空\))$/.test(value);
}
export function studentAnswerStatus(question: Pick<InputQuestion, "studentAnswer" | "answerStatus">): StudentAnswerStatus {
  if (question.answerStatus === "uncertain" || question.studentAnswer.includes("无法辨认")) return "uncertain";
  if (question.answerStatus === "blank" || isBlankAnswer(question.studentAnswer)) return "blank";
  return "answered";
}
export function preserveStudentAnswer<T extends InputQuestion>(question: T): T {
  const answerStatus = studentAnswerStatus(question);
  return { ...question, answerStatus, studentAnswer: answerStatus === "answered" ? question.studentAnswer : "" };
}
