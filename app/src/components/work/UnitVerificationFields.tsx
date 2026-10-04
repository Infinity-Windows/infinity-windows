import { useId } from "react";
import { useUnitReviewT } from "../../lib/i18n/workUnitReviewCatalog";
import {
  basisKey, buildVerificationIntent, emptyVerificationDraft, validateVerification,
  type ReviewContext, type ReviewDelivery, type VerificationDraft,
} from "../../lib/workUnitReview/form";

export interface UnitVerificationFieldsProps {
  context: ReviewContext;
  value: VerificationDraft;
  delivery: ReviewDelivery;
  allowed: boolean;
  observerLabel?: string | null;
  actorLabel?: string | null;
  onChange: (value: VerificationDraft) => void;
  onIntent: (intent: NonNullable<ReturnType<typeof buildVerificationIntent>>) => void;
}

/** Draft-only UI. The caller owns current source authority, request identity and receipts. */
export function UnitVerificationFields({ context, value, delivery, allowed, observerLabel, actorLabel, onChange, onIntent }: UnitVerificationFieldsProps) {
  const t = useUnitReviewT(), id = useId();
  const current = context.basisStatus === "current" && context.basis !== null;
  const owned = context.actorId !== null && value.actorId === context.actorId && current && value.basisKey === basisKey(context.basis!);
  const editable = owned && allowed && (delivery === "idle" || delivery === "refused");
  const reason = validateVerification(context, value, delivery, allowed);
  const inputStyle = { minWidth: 0, width: "100%", maxWidth: "100%", boxSizing: "border-box" as const, minHeight: 44, fontSize: 16 };
  const textareaStyle = { ...inputStyle, padding: "12px 15px", border: "1px solid var(--border)", borderRadius: 13, background: "var(--card-raised)", color: "var(--text)", fontFamily: "var(--font-body)", resize: "vertical" as const };
  const pairStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 12 };
  const evidencePairStyle = { ...pairStyle, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" };
  const source = current ? context.original : null;
  return <section data-testid="unit-verification-fields" aria-labelledby={`${id}-title`} style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: 16 }}>
    <h2 id={`${id}-title`}>{t("titleVerify")}</h2>
    <p role="status" aria-live="polite">{t(delivery === "unknown" ? "unknown_delivery" : delivery)}</p>
    {source && <details open style={{ minWidth: 0 }}><summary>{t("original")}</summary>
      <dl style={{ minWidth: 0 }}>
        <dt>{t("width")} / {t("height")}</dt><dd style={{ marginInlineStart: 0 }}>{String(source.width)} × {String(source.height)} {t(source.units)}</dd>
        <dt>{t("originalSource")}</dt><dd style={{ marginInlineStart: 0 }}>{t(source.source)}</dd>
        <dt>{t("originalReference")}</dt><dd style={{ marginInlineStart: 0 }}>{source.sourceReference || t("noReference")}</dd>
        <dt>{t("observer")}</dt><dd style={{ marginInlineStart: 0 }}>{context.observerId ? observerLabel || context.observerId : t("unknownPerson")}</dd>
      </dl>
    </details>}
    {owned ? <form onSubmit={event => {
      event.preventDefault();
      const intent = buildVerificationIntent(context, value, delivery, allowed);
      if (intent) onIntent(intent);
    }}>
      <fieldset disabled={!editable} style={{ minWidth: 0, margin: 0, padding: 12, border: "1px solid var(--border)", borderRadius: 12 }} aria-describedby={`${id}-help`}>
        <legend>{t("corroboration")}</legend>
        <p>{t("reviewer")}: {actorLabel || context.actorId}</p>
        <div style={pairStyle}>
          <label>{t("width")}<input aria-label={t("width")} required style={inputStyle} inputMode="decimal" value={value.width} maxLength={100} onChange={e => onChange({ ...value, width: e.target.value })} /></label>
          <label>{t("height")}<input aria-label={t("height")} required style={inputStyle} inputMode="decimal" value={value.height} maxLength={100} onChange={e => onChange({ ...value, height: e.target.value })} /></label>
        </div>
        <div style={evidencePairStyle}>
          <label>{t("units")}<select aria-label={t("units")} style={inputStyle} value={value.units} onChange={e => onChange({ ...value, units: e.target.value as VerificationDraft["units"] })}>
            {(["in", "ft", "mm", "cm"] as const).map(unit => <option key={unit} value={unit}>{t(unit)}</option>)}
          </select></label>
          <label>{t("source")}<select aria-label={t("source")} required style={inputStyle} value={value.source} onChange={e => onChange({ ...value, source: e.target.value as VerificationDraft["source"] })}>
            <option value="">{t("choose")}</option><option value="measured">{t("measured")}</option><option value="plans">{t("plans")}</option>
          </select></label>
        </div>
        <label>{t("reference")}<textarea aria-label={t("reference")} required rows={3} style={textareaStyle} value={value.reference} onChange={e => onChange({ ...value, reference: e.target.value })} aria-describedby={`${id}-reference-help`} /></label>
        <p id={`${id}-reference-help`} className="muted">{t("referenceHelp")}</p>
      </fieldset>
      <p id={`${id}-help`} className="muted">{t("preserveSource")}</p>
      {reason && <p data-testid="verification-reason" role="status">{t(reason)}</p>}
      {reason === "dimension_mismatch" && <p>{t("mismatchHelp")}</p>}
      <button type="submit" className="primary" disabled={reason !== null} style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }}>{t("verify")}</button>
    </form> : <>
      <p role="status">{t(reason || "unavailable")}</p>
      {current && context.actorId && (delivery === "idle" || delivery === "refused") && <button type="button" style={{ minHeight: 44, maxWidth: "100%", whiteSpace: "normal" }} onClick={() => onChange(emptyVerificationDraft(context))}>{t("reset")}</button>}
    </>}
  </section>;
}
