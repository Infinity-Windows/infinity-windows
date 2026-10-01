import type { FeedbackT } from "./i18n/feedbackCatalog";
export interface AiIssueContext { question: string; answer: string; channel: "text" | "live" }
/** Reserve space for the person's explanation instead of silently dropping
 * the question when an AI reply fills the report's 2,000-character limit. */
export function buildAiIssueBody(context: AiIssueContext, t: FeedbackT): string {
  const excerpt = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
  return `${t(context.channel === "live" ? "feedback.liveContext" : "feedback.textContext")}\n\n${t("feedback.whatFailed")}\n\n${t("feedback.question")}\n${excerpt(context.question, 600)}\n\n${t("feedback.answer")}\n${excerpt(context.answer, 1000)}`.slice(0, 1900);
}
