// Plain-language lines for lesson write-ups, shared by the form, the detail and
// the lists. Kept out of the component files so fast refresh stays intact.
import type { BridgeResult } from "../../../../supabase/functions/_shared/hexReviewBridge";
import { LEARNING_HEADINGS, formatBreakdown, type LearningContent, type LearningHeading } from "../../../../supabase/functions/_shared/learningTools";
import type { LearningDelivery, LearningWithdrawal } from "../../lib/hexLearning";
import type { LearningKey, LearningT } from "./learningCatalog";

/** The breakdown in the reader's language, self-reported impact labelled. */
export function breakdownText(t: LearningT, c: LearningContent): string {
  return formatBreakdown(c, {
    labels: Object.fromEntries(LEARNING_HEADINGS.map((h) => [h, t(`learn.heading.${h}` as LearningKey)])) as Record<LearningHeading, string>,
    unknown: t("learn.unknown"), missing: t("learn.notAnswered"),
    selfReported: (parts) => t("learn.selfReported", { parts }), minutes: (count) => t("learn.minutes", { count }),
  });
}

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

/** Review state and delivery state are separate; only a stored receipt says received. */
export function deliveryText(t: LearningT, d: LearningDelivery | null): string | null {
  if (!d) return null;
  if (d.status === "delivered" || d.status === "removed_remote") return t(`learn.delivery.${d.status}`, { when: when(d.received_at), receipt: d.receipt_id ?? "" });
  if (d.status === "failed") return t("learn.delivery.failed", { attempts: d.attempts });
  return t(`learn.delivery.${d.status}`);
}
export function withdrawalText(t: LearningT, w: LearningWithdrawal | null): string | null {
  if (!w) return null;
  if (w.status === "removed") return t("learn.withdrawal.removed", { when: when(w.received_at), receipt: w.receipt_id ?? "" });
  return w.status === "failed" ? t("learn.withdrawal.failed", { attempts: w.attempts }) : t("learn.withdrawal.pending");
}
/** An attempt's answer, when it adds something the refreshed status does not. */
export const attemptText = (t: LearningT, r: BridgeResult) =>
  r.status === "not_configured" || r.status === "not_current" ? t(`learn.delivery.${r.status}`) : "";
