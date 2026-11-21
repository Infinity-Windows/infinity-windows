import { useId, useState, type ReactNode } from "react";
import { Coffee, Play, Square } from "lucide-react";
import { openClockGlobally, useClock } from "../../lib/clockContext";
import { announceClockedOut } from "../../lib/dailyLogNudge";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { shiftGuard } from "../../lib/shiftGuard";
import { useShiftPunches, type ShiftPunchResult } from "../../lib/shiftPunches";
import { BREAK_TYPES, breakTypeLabel, CLOCK_REFUSAL_KEY, ClockRefusal } from "../../lib/timeclock";
import { pushToast, toastSuccess } from "../../lib/toast";

/**
 * Break, resume and clock out from inside Workday's timer, instead of the
 * "On the clock" sheet (Matt, 2026-11-20: "we should totally manage the
 * functionality in this On the Clock tool inside our timer"). The sheet's
 * cost codes are not here: in Workday the activity, and the unit where there
 * is one, say what the time is for.
 *
 * Returns the two buttons for the timer's heading and the panel that opens
 * under it: the break choice, or the clock-out confirmation with the two
 * questions the sheet asks.
 *
 * One case still goes to the sheet: a shift left open so long that Forge asks
 * when the day really ended. That needs the sheet's own finish-time form.
 */
export function useWorkdayShiftControls(es: boolean): { buttons: ReactNode; panel: ReactNode } {
  const t = useT();
  const { shift } = useClock();
  const punches = useShiftPunches();
  const panelId = useId();
  const [open, setOpen] = useState<"break" | "clock-out" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [injured, setInjured] = useState(false);
  const [injuryNote, setInjuryNote] = useState("");
  const [timeWrong, setTimeWrong] = useState(false);
  const text = (en: string, spanish: string) => es ? spanish : en;

  if (!shift || shift.status !== "open") return { buttons: null, panel: null };
  const onBreak = Boolean(shift.break_started_at);
  const sheetOnly = shiftGuard(shift, Date.now()).state === "over-cap";
  const toSheet = (action: "break" | "clock-out") => openClockGlobally({
    projectId: shift.project_id ?? null, costCodeId: null, note: null, mode: null, stayOnPage: true, workdayClockAction: action,
  });
  const send = async (punch: () => Promise<ShiftPunchResult>, saved: (result: ShiftPunchResult) => void) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      saved(await punch());
      setOpen(null);
    } catch (e) {
      setError(e instanceof ClockRefusal ? t(CLOCK_REFUSAL_KEY[e.code]) : formatApiError(e));
    } finally {
      setBusy(false);
    }
  };
  // A punch that waits behind the work it just stopped is "queued" for a
  // moment even with signal, and sends by itself. Only say "when you're back
  // online" to someone who is actually offline (seen 2026-11-20: the clock-out
  // toast promised a sync to a phone that was online).
  const waits = (result: ShiftPunchResult) => result.queued && !navigator.onLine;
  const toggle = (next: "break" | "clock-out") => {
    if (sheetOnly) return toSheet(next);
    setError("");
    setOpen(current => current === next ? null : next);
  };

  const buttons = <div className="wd-preview-clock-actions" aria-label={text("Shift controls", "Controles del turno")}>
    {onBreak
      ? <button type="button" disabled={busy} className="wd-break" onClick={() => void send(punches.breakEnd,
          result => toastSuccess(t(waits(result) ? "clock.toast.backOnClockQueued" : "clock.toast.backOnClock")))}>
          <Play size={15} aria-hidden="true" />{text("Resume", "Continuar")}</button>
      : <button type="button" className="wd-break" aria-expanded={open === "break"} aria-controls={open === "break" ? panelId : undefined}
          onClick={() => toggle("break")}><Coffee size={15} aria-hidden="true" />{text("Break", "Descanso")}</button>}
    <button type="button" className="wd-clock-out" aria-expanded={open === "clock-out"} aria-controls={open === "clock-out" ? panelId : undefined}
      onClick={() => toggle("clock-out")}><Square size={15} fill="currentColor" aria-hidden="true" />{text("Clock out", "Marcar salida")}</button>
  </div>;

  const failed = error && <p role="alert">{error}</p>;
  const panel = open === "break" && !onBreak
    ? <section id={panelId} className="wd-shift-panel" aria-label={text("Go on break", "Tomar descanso")}>
        <h3>{text("Go on break", "Tomar descanso")}</h3>
        <p>{text("Your timecard pauses until you tap Resume.", "Tu tarjeta de tiempo se pausa hasta que toques Continuar.")}</p>
        <div className="wd-shift-choices">
          {BREAK_TYPES.map(({ type }) => <button type="button" key={type} disabled={busy}
            onClick={() => void send(() => punches.breakStart(type), result => pushToast(
              `On ${breakTypeLabel(type).toLowerCase()} break${waits(result) ? " — will sync when online" : ""}`, "info"))}>
            {breakTypeLabel(type)}</button>)}
          <button type="button" className="wd-shift-cancel" disabled={busy} onClick={() => setOpen(null)}>{text("Cancel", "Cancelar")}</button>
        </div>
        {failed}
      </section>
    : open === "clock-out"
    ? <section id={panelId} className="wd-shift-panel" aria-label={text("Clock out", "Marcar salida")}>
        <h3>{text("Clock out?", "¿Marcar salida?")}</h3>
        <p>{text("This ends your shift and stops the running activity.", "Esto termina tu turno y detiene la actividad en curso.")}</p>
        <label><input type="checkbox" checked={injured} onChange={event => setInjured(event.target.checked)} />{t("clock.injury.was")}</label>
        {injured && <label className="wd-shift-note">
          <span>{t("clock.injury.whatHappened")} <strong>{t("clock.injury.emergency")}</strong></span>
          <textarea rows={3} value={injuryNote} placeholder={t("clock.injury.placeholder")} onChange={event => setInjuryNote(event.target.value)} />
        </label>}
        <label><input type="checkbox" checked={timeWrong} onChange={event => setTimeWrong(event.target.checked)} />{t("clock.timeWrong")}</label>
        <div className="wd-shift-choices">
          <button type="button" className="wd-shift-confirm" disabled={busy}
            onClick={() => void send(() => punches.clockOut({ injured, injuryNote, timeWrong }), result => {
              toastSuccess(t(waits(result) ? "clock.toast.clockedOutQueued" : "clock.toast.clockedOut"));
              setInjured(false);
              setInjuryNote("");
              setTimeWrong(false);
              // Last, as in the sheet: the punch is saved before anything asks about a daily log.
              announceClockedOut(shift.project_id ?? null, shift.projects);
            })}><Square size={15} fill="currentColor" aria-hidden="true" />{text("Clock out", "Marcar salida")}</button>
          <button type="button" className="wd-shift-cancel" disabled={busy} onClick={() => setOpen(null)}>{text("Cancel", "Cancelar")}</button>
        </div>
        {failed}
      </section>
    : failed ? <section className="wd-shift-panel">{failed}</section> : null;

  return { buttons, panel };
}
