import { useState } from "react";
import { useLanguage } from "../../lib/i18n/context";
import { useUnitReviewT } from "../../lib/i18n/workUnitReviewCatalog";
import { basisKey, emptyQcDraft, emptyVerificationDraft, type QcDraft, type ReviewContext, type ReviewDelivery, type VerificationDraft } from "../../lib/workUnitReview/form";
import { useUnitReviewCoordinator, type UnitReviewSelectionSource } from "../../lib/workUnitReview/useUnitReviewCoordinator";
import type { ReviewCoordinatorDependencies, ReviewInspection } from "../../lib/workUnitReview/coordinator";
import { UnitVerificationFields } from "./UnitVerificationFields";
import { UnitQcReviewFields } from "./UnitQcReviewFields";

const words = {
  returnSelf: ["Return as yourself", "Volver a tu propia cuenta"],
  title: ["Unit review", "Revisión de la unidad"], check: ["Check current review", "Comprobar revisión actual"],
  waiting: ["Checking the current review…", "Comprobando la revisión actual…"],
  unavailable: ["Review is unavailable. Return to this job as yourself, reconnect, and check again.", "La revisión no está disponible. Vuelve a esta obra con tu propia cuenta, reconecta y comprueba de nuevo."],
  storage: ["This device could not safely retain the request. Keep this device and check the original review before trying again.", "Este dispositivo no pudo guardar la solicitud de forma segura. Conserva este dispositivo y comprueba la revisión original antes de reintentar."],
  hidden: ["A retained request cannot be shown with your current access or unit details. Check again, or ask an authorized supervisor to help restore the original access. You may ask the server to cancel that saved request.", "Una solicitud guardada no puede mostrarse con tu acceso o los detalles actuales. Comprueba de nuevo o pide a un supervisor autorizado que ayude a restablecer el acceso original. Puedes solicitar al servidor que cancele esa solicitud."],
  current: ["Current status", "Estado actual"], dimensions: ["Dimensions verified for the current details", "Medidas verificadas para los detalles actuales"],
  dimensionsNo: ["Dimensions are not currently verified", "Las medidas no están verificadas actualmente"],
  accepted: ["Final QC currently accepted", "Control final aceptado actualmente"], notAccepted: ["Final QC is not currently accepted", "El control final no está aceptado actualmente"],
  separate: ["These flags come from the latest check. Saved decisions below are history, not current approval.", "Estos estados provienen de la última comprobación. Las decisiones guardadas son historial, no una aprobación actual."],
  history: ["Saved request history", "Historial de solicitudes guardadas"], original: ["Original request", "Solicitud original"],
  saved: ["Saved on this device; not yet confirmed", "Guardada en este dispositivo; aún sin confirmar"],
  unknown: ["Outcome unknown — check this original before another decision", "Resultado desconocido: comprueba esta solicitud antes de otra decisión"],
  refused: ["Delivery refused; no earlier uncertain attempt is recorded", "Envío rechazado; no hay intentos anteriores sin confirmar"],
  recorded: ["Applied receipt recorded — historical decision", "Recibo de aplicación registrado: decisión histórica"],
  cancelled: ["Cancelled receipt recorded — this original cannot apply", "Recibo de cancelación registrado: esta solicitud no puede aplicarse"],
  send: ["Send saved request", "Enviar solicitud guardada"], retry: ["Retry the same request", "Reintentar la misma solicitud"],
  cancel: ["Cancel saved request", "Cancelar solicitud guardada"],
  cancelHelp: ["Cancellation and delivery race for the first result. If the review already applied, it stays applied. Cancellation does not undo it.", "La cancelación y el envío compiten por el primer resultado. Si la revisión ya se aplicó, seguirá aplicada. Cancelarla no la deshace."],
  selectedDefects: ["Selected corrections", "Correcciones seleccionadas"],
  absentDefect: ["This selected defect is not in the current review.", "Este defecto seleccionado no aparece en la revisión actual."],
  attempts: ["Attempt history", "Historial de intentos"], pending: ["Awaiting confirmation", "Pendiente de confirmación"], held: ["Attempt held before delivery", "Intento detenido antes del envío"],
  cancelAttempt: ["Cancellation", "Cancelación"], deliveryAttempt: ["Delivery", "Envío"], attemptRefused: ["This attempt was refused", "Este intento fue rechazado"],
  refresh_required: ["Check the current review before continuing.", "Comprueba la revisión actual antes de continuar."],
  competing_request: ["Another request or attempt is retained. Check it before continuing.", "Hay otra solicitud o intento guardado. Compruébalo antes de continuar."],
  basis_changed: ["Unit details changed. Check the original request before a new decision.", "Los detalles cambiaron. Comprueba la solicitud original antes de otra decisión."],
} as const;
type Word = keyof typeof words;
function useWords() { const { lang } = useLanguage(); return (key: Word) => words[key][lang === "es" ? 1 : 0]; }
const button = { minHeight: 44, maxWidth: "100%", whiteSpace: "normal" as const, overflowWrap: "anywhere" as const };
export interface UnitReviewPanelProps {
  source: UnitReviewSelectionSource;
  /** Synthetic fixture seam only. Production uses the real coordinator APIs. */
  dependencies?: Partial<ReviewCoordinatorDependencies>;
}

/** Unmounted adapter. The parent supplies a live fresh job/unit source and must
 * invalidate it before any selection, navigation or source-refresh boundary. */
export function UnitReviewPanel({ source, dependencies }: UnitReviewPanelProps) {
  const adapter = useUnitReviewCoordinator(source, dependencies), w = useWords(), t = useUnitReviewT();
  const view = adapter.inspection;
  return <section data-testid="unit-review-panel" style={{ minWidth: 0, width: "100%", maxWidth: "100%", overflowWrap: "anywhere" }}>
    <h2>{w("title")}</h2>
    {adapter.canReturnAsYourself && <button type="button" style={button} onClick={adapter.returnAsYourself}>{w("returnSelf")}</button>}
    <button type="button" style={button} disabled={adapter.busy || !adapter.current()} onClick={() => { void adapter.refresh(); }}>{w("check")}</button>
    {adapter.busy && <p role="status">{w("waiting")}</p>}
    {view.kind !== "ready" ? <p role="status">{w(adapter.notice === "storage_unavailable" || view.reason === "storage_unavailable" ? "storage" : view.reason === "refresh_required" && !adapter.notice ? "refresh_required" : "unavailable")}</p> : <>
      <section aria-label={w("current")} data-testid="unit-review-current">
        <h3>{w("current")}</h3>
        <p>{w(view.current.review.dimensionVerification.state === "verified" ? "dimensions" : "dimensionsNo")}</p>
        <p>{w(view.current.review.qc.qcAccepted ? "accepted" : "notAccepted")}</p>
        <p className="muted">{w("separate")}</p>
      </section>
      {adapter.hasHiddenHead ? <div data-testid="unit-review-hidden"><p>{w("hidden")}</p><p>{w("cancelHelp")}</p>
        <button type="button" style={button} disabled={adapter.busy} onClick={() => { void adapter.cancel(); }}>{w("cancel")}</button>
      </div> : <>
        {adapter.notice && ["storage_unavailable", "competing_request", "basis_changed"].includes(adapter.notice) && <p role="status">{w(adapter.notice === "storage_unavailable" ? "storage" : adapter.notice as Word)}</p>}
        {!!view.history.length && <section aria-label={w("history")} data-testid="unit-review-history"><h3>{w("history")}</h3>
          {view.history.map(({ record, delivery }, index) => <article key={record.commandId} style={{ border: "1px solid var(--border)", padding: 12, borderRadius: 12, marginBlock: 12 }}>
            <h4>{t(record.payload.action === "verify_dimensions" ? "titleVerify" : record.payload.action)}</h4>
            <p>{w(delivery)}</p>
            <details><summary>{w("original")}</summary>
              {record.payload.action === "verify_dimensions" ? <p>{record.payload.data.widthDecimal} × {record.payload.data.heightDecimal} {t(record.payload.data.unit)} · {t(record.payload.data.source)} · {record.payload.data.sourceReference}</p>
                : <><p>{record.payload.data.note}</p>{record.payload.action === "fail" && <ul>{record.payload.data.defects.map(d => <li key={d.id}>{d.summary}</li>)}</ul>}{record.payload.action === "claim_resolved" && <><p>{w("selectedDefects")}</p><ul>{record.payload.data.defectIds.map(id => <li key={id}>{view.current.review.defects.find(defect => defect.id === id)?.summary ?? w("absentDefect")}</li>)}</ul></>}</>}
              {record.attempts.length > 0 && <><h5>{w("attempts")}</h5><ul>{record.attempts.map(a => <li key={a.token}>{w(a.purpose === "cancel" ? "cancelAttempt" : "deliveryAttempt")}: {w(a.outcome === "refused" ? "attemptRefused" : a.outcome)}</li>)}</ul></>}
            </details>
            {index === view.history.length - 1 && !["recorded", "cancelled", "refused"].includes(delivery) && <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button type="button" style={button} disabled={adapter.busy} onClick={() => { void adapter.deliver(record.commandId); }}>{w(delivery === "saved" ? "send" : "retry")}</button>
                <button type="button" style={button} disabled={adapter.busy} onClick={() => { void adapter.cancel(); }}>{w("cancel")}</button>
              </div><p>{w("cancelHelp")}</p>
            </>}
          </article>)}
        </section>}
        <ReviewDrafts key={`${adapter.sessionId}:${adapter.draftEpoch}:${view.current.review.basis ? basisKey(view.current.review.basis) : "none"}`}
          inspection={view} actorId={adapter.login!.userId!} busy={adapter.busy} current={adapter.current} author={adapter.author} />
      </>}
    </>}
  </section>;
}
function ReviewDrafts({ inspection, actorId, busy, current, author }: {
  inspection: ReviewInspection; actorId: string; busy: boolean; current: () => boolean; author: (payload: unknown) => Promise<void>;
}) {
  const review = inspection.current.review;
  const context: ReviewContext = { actorId, basis: review.basis, basisStatus: review.basisStatus, original: review.observation };
  const [verification, setVerification] = useState<VerificationDraft>(() => emptyVerificationDraft(context));
  const [qc, setQc] = useState<QcDraft>(() => emptyQcDraft(context));
  const head = inspection.history.at(-1);
  const delivery: ReviewDelivery = busy ? "pending" : head && ["saved", "unknown"].includes(head.delivery) ? "unknown" : "idle";
  return <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
    <UnitVerificationFields context={context} value={verification} delivery={delivery} allowed={review.capabilities.verifyDimensions}
      onChange={next => { if (current() && !busy) setVerification(next); }} onIntent={intent => { if (current() && !busy) void author(intent); }} />
    <UnitQcReviewFields context={context} value={qc} delivery={delivery} state={review.qc.state} defects={review.defects}
      authority={{ submit: review.capabilities.submit, pass: review.capabilities.pass, fail: review.capabilities.fail, claim_resolved: review.capabilities.claimResolved, reopen: review.capabilities.reopen }}
      onChange={next => { if (current() && !busy) setQc(next); }} onIntent={intent => { if (current() && !busy) void author(intent); }} />
  </div>;
}
