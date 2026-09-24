// K2.8 — the supervisor's Review AI drafts card on Scheduling (crew redesign
// Release 2, Q24). Lists the AI-drafted rows still in draft for the visible
// dates with the model's own reason for each, lets the supervisor Keep (a
// reviewed mark that lives on this screen only) or Drop (the board's own
// delete) each one, and hands off to the page's existing Review & publish
// sheet — there is one publish path, and this card is not a second one.
// Publishing is what records that a human approved the AI's plan; the
// created_via flag stays on the row for good (CONTEXT.md: AI-proposed).
import { useState } from "react";
import { Send, Sparkles } from "lucide-react";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import { draftDaysLabel } from "../../lib/schedule/aiDraftReview";
import { useScheduleReviewT } from "./scheduleReviewCatalog";

export interface AiDraftReviewProps {
  /** AI drafts overlapping the visible dates (lib/schedule/aiDraftReview). */
  drafts: ScheduleAssignment[];
  /** AI drafts outside those dates, so the count never hides them. */
  outside: number;
  /** The model's reason per draft id; null while they load. A draft with no
   * entry has none recorded (older than the reason field). */
  reasons: Map<string, string> | null;
  /** Plain words when the reasons could not be read; the drafts still show. */
  reasonsError: string | null;
  nameOf: (profileId: string) => string;
  /** The board's own delete path; rejects with an error to show. */
  onDrop: (draft: ScheduleAssignment) => Promise<void>;
  /** Opens the page's Review & publish sheet — the one publish path. */
  onPublish: () => void;
  /** How many unpublished changes that sheet will send (AI drafts and the
   * supervisor's own), so the card says what Publish really does. */
  publishableCount: number;
  /** The page's error wording (lib/errors), never String(err). */
  formatError: (err: unknown) => string;
}

export function AiDraftReview({ drafts, outside, reasons, reasonsError, nameOf, onDrop, onPublish, publishableCount, formatError }: AiDraftReviewProps) {
  const t = useScheduleReviewT();
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const [dropping, setDropping] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const toggleKeep = (id: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const drop = async (a: ScheduleAssignment) => {
    setDropping(a.id);
    setDropError(null);
    try {
      await onDrop(a);
      setKept((prev) => {
        if (!prev.has(a.id)) return prev;
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    } catch (e) {
      setDropError(t("aiReview.dropFailed", { error: formatError(e) }));
    } finally {
      setDropping(null);
    }
  };

  const crewOf = (a: ScheduleAssignment) =>
    a.members.map((m) => m.display_name ?? nameOf(m.profile_id)).join(", ") || t("aiReview.nobody");

  return (
    <section className="detail-card sched-ai-review" aria-label={t("aiReview.title")} data-testid="ai-draft-review">
      <div className="sched-ai-review-head">
        <strong><Sparkles size={15} aria-hidden /> {t("aiReview.title")}</strong>
        <span className="muted">{t("aiReview.count", { n: drafts.length })}</span>
      </div>
      <p className="muted sched-ai-review-help">{t("aiReview.help")}</p>
      {reasonsError && <p className="warn-text" role="alert">{t("aiReview.reasonsFailed")}</p>}
      {drafts.length === 0 && <p className="muted">{t("aiReview.onlyOutside")}</p>}
      <ul className="sched-ai-review-list">
        {drafts.map((a) => {
          const isKept = kept.has(a.id);
          const reason = reasons === null ? t("aiReview.reasonLoading") : reasons.get(a.id) ?? t("aiReview.noReason");
          return (
            <li key={a.id} className={isKept ? "sched-ai-review-row is-kept" : "sched-ai-review-row"} data-kept={isKept ? "true" : "false"}>
              <div className="sched-ai-review-what">
                <strong>{a.project?.job_code ?? a.project?.name ?? t("aiReview.job")}</strong>
                <span> · {draftDaysLabel(a)} · {crewOf(a)}</span>
                <p className="muted sched-ai-review-reason">{reason}</p>
              </div>
              <div className="sched-ai-review-actions">
                <button
                  type="button"
                  className={isKept ? "button-like active-pill" : "button-like"}
                  aria-pressed={isKept}
                  onClick={() => toggleKeep(a.id)}
                >
                  {isKept ? t("aiReview.kept") : t("aiReview.keep")}
                </button>
                <button type="button" className="button-like" disabled={dropping === a.id} onClick={() => void drop(a)}>
                  {dropping === a.id ? t("aiReview.dropping") : t("aiReview.drop")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {dropError && <p className="warn-text" role="alert">{dropError}</p>}
      {outside > 0 && <p className="muted">{t("aiReview.outside", { n: outside })}</p>}
      <div className="sched-ai-review-foot">
        <span className="muted">{t("aiReview.publishHint", { n: publishableCount })}</span>
        <button type="button" className="button-like active-pill" onClick={onPublish} disabled={publishableCount === 0}>
          <Send size={15} aria-hidden /> {t("aiReview.publish")}
        </button>
      </div>
    </section>
  );
}
