import { useState } from "react";
import { useFieldT as useT, type TKey } from "./fieldCatalog";
import { formatApiError } from "../../lib/errors";
import { openClockGlobally } from "../../lib/clockContext";
import { guardedResolve, TimingPendingError, type FieldReceipt } from "../../lib/fieldAsk";
import type { ChecklistItem, SetupChecklist } from "../../../../supabase/functions/_shared/fieldTools";
import { differenceLabel, differenceText, optionText, reasonText } from "./fieldCardText";
import { receiptStatus } from "../../lib/askReceiptGuard";

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

/** The questions still open, what is answered, and what was said unknown. */
export function FieldChecklist({ checklist }: { checklist: SetupChecklist }) {
  const t = useT();
  const rows = [...(checklist.job ?? []), ...(checklist.unit ?? [])].filter((i) => i.status !== "not_applicable");
  if (!rows.length) return null;
  const open = rows.filter((i) => i.status === "missing").length;
  return (
    <section className="field-card field-checklist" aria-label={t("field.checklist")}>
      <h3>{t("field.checklist")} · {open} {t("field.status.missing").toLowerCase()}</h3>
      <p className="muted">{t("field.checklistHelp")}</p>
      {/* K2.5: a checklist is not a receipt. Answers live with the
          conversation until a save returns a receipt card. */}
      <p className="field-status muted">{t("field.checklistKept")}</p>
      <ul>
        {rows.map((item: ChecklistItem) => (
          <li key={item.key} className={`field-item field-${item.status}`}>
            <span className="field-item-label">{t(`field.key.${item.key}` as TKey)}</span>
            <span className="field-item-value">
              {item.status === "captured" ? item.value : t(`field.status.${item.status}` as TKey)}
              {item.from_plans ? ` · ${t("field.fromPlans")}` : ""}
              {item.status === "missing" && item.required_before_timing ? ` · ${t("field.beforeTiming")}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function receiptText(t: ReturnType<typeof useT>, r: FieldReceipt): string {
  const label = r.unit?.label ?? "";
  if (r.status === "stale") return `${t("field.receipt.stale")} ${r.message ?? ""}`.trim();
  if (r.status === "cancelled") return t("field.receipt.cancelled");
  switch (r.outcome) {
    case "created": return r.action === "create_job" ? t("field.receipt.created", { name: r.name ?? "", count: r.supervisor_notice?.recipients ?? 0 }) : t("field.receipt.created_unit", { label });
    case "used_existing": return t("field.receipt.used_existing", { name: r.name ?? "" });
    case "created_from_map": return t("field.receipt.created_from_map", { label });
    case "details_added": return t("field.receipt.details_added", { label });
    case "corrected": return t("field.receipt.corrected", { label });
    case "unchanged": return t("field.receipt.unchanged", { label });
    case "sent_for_review": return t("field.receipt.sent_for_review", { label });
    case "started": return t("field.receipt.started", { label: label || (r.stage ?? ""), time: time(r.started_at) });
    case "already_running": return t("field.receipt.already_running", { label, time: time(r.started_at) });
    case "stopped": return t("field.receipt.stopped", { outcome: String(r.stage_outcome ?? "") });
    case "already_stopped": return t("field.receipt.already_stopped");
    case "released": return t("field.receipt.released", { label });
    case "not_assigned": return t("field.receipt.not_assigned", { label });
    case "crew_recorded": return t("field.receipt.crew_recorded", { label, people: (r.people ?? []).join(", ") });
    default: return r.message ?? "";
  }
}

/** One database receipt. A waiting choice shows its buttons; nothing on this
 * card claims success unless the receipt's status says it happened. */
export function FieldReceiptCard({ receipt, onChange, timingPending }: {
  receipt: FieldReceipt; onChange: (next: FieldReceipt) => void;
  /** Re-read at the moment of a timing tap; pending or unreadable refuses it. */
  timingPending: () => Promise<boolean>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const waiting = receipt.status === "needs_choice";
  const proposed = receipt.proposed as { name?: string; location?: string } | undefined;
  const choose = async (choice: string) => {
    setBusy(true); setError("");
    try { onChange(await guardedResolve(receipt, choice, { timingPending })); }
    catch (e) { setError(e instanceof TimingPendingError ? t("field.timingPending") : `${t("field.choiceFailed")} ${formatApiError(e)}`); }
    finally { setBusy(false); }
  };
  return (
    <section className={`field-card field-receipt field-${receipt.status}`} aria-live="polite">
      {/* K2.5: the real status in three words, from the receipt, first. */}
      <p className={`field-status field-status-${receiptStatus(receipt)}`}><strong>{t(`field.receiptStatus.${receiptStatus(receipt)}` as TKey)}</strong></p>
      {waiting ? (
        <>
          <p className="field-choice-needed"><strong>{t("field.choiceNeeded")}</strong></p>
          <p>{reasonText(t, receipt)}</p>
          {proposed?.name && (
            <p className="field-proposed"><strong>{t("field.proposedJob")}</strong> {proposed.name}{proposed.location ? ` · ${proposed.location}` : ""}</p>
          )}
          {receipt.matches && (
            <ul className="field-matches">
              {receipt.matches.map((m) => <li key={m.id}>{m.name}{m.location ? ` · ${m.location}` : ""}</li>)}
            </ul>
          )}
          {receipt.differences && (
            <dl className="field-differences">
              {Object.entries(receipt.differences).map(([k, d]) => (
                <div key={k}>
                  <dt>{differenceLabel(t, k)}</dt>
                  <dd>{differenceText(k, d.stored ?? d.plans)} → {differenceText(k, d.said)}</dd>
                </div>
              ))}
            </dl>
          )}
          {(receipt.reason === "needs_clock" || receipt.reason === "wrong_job") && (
            <button type="button" onClick={() => openClockGlobally()}>{t("field.openClock")}</button>
          )}
          <div className="field-options">
            {receipt.options?.map((o) => (
              <button key={o.id} type="button" disabled={busy} className={o.id === "cancel" ? undefined : "primary"} onClick={() => void choose(o.id)}>
                {optionText(t, receipt, o)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p>{receiptText(t, receipt)}</p>
          {receipt.status === "running" && receipt.start_time_basis && <p className="muted">{t(`field.basis.${receipt.start_time_basis}`)}</p>}
          {Number(receipt.helpers_still_working ?? 0) > 0 && <p className="muted">{t("field.helpers", { count: Number(receipt.helpers_still_working) })}</p>}
        </>
      )}
      {error && <p role="alert" className="cw-error">{error}</p>}
    </section>
  );
}
