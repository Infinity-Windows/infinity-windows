// K2.8 — the supervisor's review of AI-drafted schedule rows (crew redesign
// Release 2, Q24). Pure: what the Review AI drafts card lists. The model's
// reason per draft comes from schedule_ai_reasons (lib/schedule/api
// listAiDraftReasons); the card itself is components/schedule/AiDraftReview.
//
// An AI draft is a schedule_assignments row the assistant's draft_assignments
// tool wrote: status 'draft' and created_via 'ai'. The flag is permanent
// (CONTEXT.md: AI-proposed — publishing never clears it), so "still a draft"
// is what makes a row reviewable, not the flag alone. A draft linked to a
// connected plan is left out: it publishes through its plan, never here.
import type { ScheduleAssignment } from "./types";

export interface AiDraftReviewList {
  /** AI drafts overlapping the visible dates, earliest first. */
  inRange: ScheduleAssignment[];
  /** AI drafts outside those dates — counted, so nothing hides: Review &
   * Publish sends every draft, not only the visible ones. */
  outside: number;
}

export const isAiDraft = (a: ScheduleAssignment): boolean => a.status === "draft" && a.created_via === "ai";

export function aiDraftsForReview(
  drafts: ScheduleAssignment[],
  range: { from: string; to: string },
  linkedToPlan: (assignmentId: string) => boolean = () => false,
): AiDraftReviewList {
  const ai = drafts.filter((a) => isAiDraft(a) && !linkedToPlan(a.id));
  const inRange = ai
    .filter((a) => a.start_date <= range.to && a.end_date >= range.from)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || (a.project?.job_code ?? "").localeCompare(b.project?.job_code ?? "") || a.id.localeCompare(b.id));
  return { inRange, outside: ai.length - inRange.length };
}

/** "Sep 28" or "Sep 28 – Oct 1", in the board's own short date style. */
export function draftDaysLabel(a: Pick<ScheduleAssignment, "start_date" | "end_date">): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, opts);
  return a.start_date === a.end_date ? day(a.start_date) : `${day(a.start_date)} – ${day(a.end_date)}`;
}
