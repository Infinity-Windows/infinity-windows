import { useId } from "react";
import { useUnitReviewT } from "../../lib/i18n/workUnitReviewCatalog";
import {
  basisKey, buildQcIntent, emptyQcDraft, validateQcAction,
  type QcAction, type QcDefect, type QcDraft, type QcState, type ReviewContext, type ReviewDelivery,
} from "../../lib/workUnitReview/form";

export interface UnitQcReviewFieldsProps {
  context: ReviewContext;
  value: QcDraft;
  delivery: ReviewDelivery;
  state: QcState;
  defects: readonly QcDefect[];
  authority: Readonly<Record<QcAction, boolean>>;
  onChange: (value: QcDraft) => void;
  onIntent: (intent: NonNullable<ReturnType<typeof buildQcIntent>>) => void;
}

/** Final QC drafts do not update dimensions, install points, payroll or Data trust. */
export function UnitQcReviewFields({ context, value, delivery, state, defects, authority, onChange, onIntent }: UnitQcReviewFieldsProps) {
  const t = useUnitReviewT(), id = useId();
  const current = context.basisStatus === "current" && context.basis !== null;
  const owned = current && context.actorId !== null && value.actorId === context.actorId && value.basisKey === basisKey(context.basis!);
  const editable = owned && (delivery === "idle" || delivery === "refused");
  const inputStyle = { minWidth: 0, width: "100%", maxWidth: "100%", boxSizing: "border-box" as const, minHeight: 44, fontSize: 16 };
  const textareaStyle = { ...inputStyle, padding: "12px 15px", border: "1px solid var(--border)", borderRadius: 13, background: "var(--card-raised)", color: "var(--text)", fontFamily: "var(--font-body)", resize: "vertical" as const };
  const actions: QcAction[] = state === "not_submitted" ? ["submit"] : state === "awaiting_review" ? ["pass", "fail"] : state === "failed" ? ["claim_resolved", "reopen"] : state === "passed" ? ["reopen"] : [];
  const primaryReason = validateQcAction(context, value, delivery, state, defects, actions[0] || "submit", authority[actions[0] || "submit"]);
  return <section data-testid="unit-qc-review-fields" aria-labelledby={`${id}-title`} style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: 16 }}>
    <h2 id={`${id}-title`}>{t("titleQc")}</h2>
    <p className="muted">{t("qcHelp")}</p>
    <p role="status" aria-live="polite">{t(delivery === "unknown" ? "unknown_delivery" : delivery)}</p>
    {current && <p><strong>{t("qcState")}:</strong> {t(state)}</p>}
    {current && defects.length > 0 && <details open><summary>{t("defects")}</summary><ul style={{ paddingInlineStart: 20 }}>{defects.map(defect => <li key={defect.id} style={{ marginBlock: 12 }}>
      <span>{defect.summary}</span><p className="muted">{t(defect.resolved ? "resolved" : "unresolved")}</p>
    </li>)}</ul></details>}
    {owned ? <>
      <fieldset disabled={!editable} style={{ minWidth: 0, margin: 0, padding: 12, border: "1px solid var(--border)", borderRadius: 12 }}>
        <legend>{t("note")}</legend>
        <textarea aria-label={t("note")} rows={3} style={textareaStyle} value={value.note} onChange={e => onChange({ ...value, note: e.target.value })} aria-describedby={`${id}-note-help`} />
        <p id={`${id}-note-help`} className="muted">{t("noteHelp")}</p>
        {state === "awaiting_review" && authority.fail && <>
          <h3>{t("newDefects")}</h3>
          {value.newDefects.map((defect, index) => <div key={defect.id} style={{ minWidth: 0, marginBlock: 12 }}>
            <label>{t("defectSummary", { number: index + 1 })}<textarea aria-label={t("defectSummary", { number: index + 1 })} rows={2} style={textareaStyle} value={defect.summary} onChange={e => onChange({ ...value, newDefects: value.newDefects.map(item => item.id === defect.id ? { ...item, summary: e.target.value } : item) })} /></label>
            <button type="button" style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal" }} onClick={() => onChange({ ...value, newDefects: value.newDefects.filter(item => item.id !== defect.id) })}>{t("removeDefect", { number: index + 1 })}</button>
          </div>)}
          <button type="button" style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal" }} disabled={value.newDefects.length >= 20} onClick={() => onChange({ ...value, newDefects: [...value.newDefects, { id: crypto.randomUUID(), summary: "" }] })}>{t("addDefect")}</button>
        </>}
        {state === "failed" && authority.claim_resolved && <>
          <p>{t("claimHint")}</p>
          {defects.filter(defect => !defect.resolved).map(defect => <label key={defect.id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, marginBlock: 8 }}>
            <input type="checkbox" style={{ width: 24, height: 24, flexShrink: 0 }} checked={value.resolvedDefectIds.includes(defect.id)} onChange={e => onChange({ ...value, resolvedDefectIds: e.target.checked ? [...value.resolvedDefectIds, defect.id] : value.resolvedDefectIds.filter(item => item !== defect.id) })} /><span style={{ minWidth: 0 }}>{defect.summary}</span>
          </label>)}
        </>}
      </fieldset>
      {primaryReason && <p data-testid="qc-reason" role="status">{t(primaryReason)}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>{actions.map(action => {
        const reason = validateQcAction(context, value, delivery, state, defects, action, authority[action]);
        return <button key={action} type="button" className={action === "pass" || action === "submit" ? "primary" : undefined} style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }} disabled={reason !== null} title={reason ? t(reason) : undefined} onClick={() => {
          const intent = buildQcIntent(context, value, delivery, state, defects, action, authority[action]);
          if (intent) onIntent(intent);
        }}>{t(action)}</button>;
      })}</div>
    </> : <>
      <p role="status">{t(primaryReason || "unavailable")}</p>
      {current && context.actorId && (delivery === "idle" || delivery === "refused") && <button type="button" style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal" }} onClick={() => onChange(emptyQcDraft(context))}>{t("reset")}</button>}
    </>}
    <p className="muted">{t("trustHelp")}</p>
  </section>;
}
