import { useState } from "react";
import { Plus, Tractor, X } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { clockText, type MachineTimer, type WorkSession } from "../../lib/customWork/model";
/** A time for a datetime-local field, in this device's zone. Machine timers
 * keep their seconds; a rounded minute would move every in and out on save. */
const localTime = (iso: string, seconds = false) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, seconds ? 19 : 16);
};
const timersMs = (timers: MachineTimer[]) => timers.reduce((ms, timer) =>
  ms + (timer.off ? Math.max(0, Date.parse(timer.off) - Date.parse(timer.on)) : 0), 0);

export function SessionCorrection({ row, lead, onSave, onSaveMachinery, onCancel }: {
  row: WorkSession;
  lead: boolean;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  /** Saves the activity's machine timers. Where it is not given, or the
   * database does not keep timers yet, the timers are not offered. */
  onSaveMachinery?: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [session, setSession] = useState(row);
  const [reason, setReason] = useState("");
  const [reviewTime, setReviewTime] = useState(false);
  const [timers, setTimers] = useState<MachineTimer[]>(() => row.workday_machinery_spans ?? []);
  const [timersChanged, setTimersChanged] = useState(false);
  const machinery = Boolean(lead && onSaveMachinery && row.ended_at && row.workday_machinery_spans);
  const changeTimers = (next: MachineTimer[]) => { setTimers(next); setTimersChanged(true); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setError("");
    setBusy(true);
    try {
      const detailsChanged = reviewTime || session.description !== row.description
        || session.outcome !== row.outcome || session.delay_reason !== row.delay_reason;
      if (machinery && timersChanged) {
        if (timers.some(timer => !timer.off || Date.parse(timer.off) <= Date.parse(timer.on)))
          throw new Error("Each machine timer needs an out time after its in time.");
        await onSaveMachinery!({ id: session.id, reason, spans: timers });
        // Only the timers changed: nothing else to record as a correction.
        if (!detailsChanged) { onCancel(); return; }
      }
      await onSave({
        id: session.id, revision: session.revision, description: session.description,
        outcome: session.outcome, delay_reason: session.delay_reason, reason,
        ...(lead && reviewTime ? { started_at: session.started_at, ended_at: session.ended_at, review_time: true } : {}),
      });
      onCancel();
    } catch (error) {
      setError(formatApiError(error));
    } finally {
      setBusy(false);
    }
  }
  const times = lead && session.ended_at;
  const setTime = (field: "started_at" | "ended_at", value: string) => {
    if (!value) return;
    setSession({ ...session, [field]: new Date(value).toISOString() });
    setReviewTime(true);
  };
  return <section className="cw-card cw-correction">
    <h3>Correct this activity</h3>
    {times && <>
      <label>
        Started
        <input type="datetime-local" value={localTime(session.started_at)}
          onChange={(e) => setTime("started_at", e.target.value)} />
      </label>
      <label>
        Ended
        <input type="datetime-local" value={localTime(session.ended_at!)}
          onChange={(e) => setTime("ended_at", e.target.value)} />
      </label>
      <label className="cw-correction-wide cw-correction-check">
        <input type="checkbox" checked={reviewTime} onChange={(e) => setReviewTime(e.target.checked)} />
        I checked these times, breaks and the job assignment
      </label>
    </>}
    <label>
      Outcome
      <select value={session.outcome ?? ""}
        onChange={(e) => setSession({ ...session, outcome: (e.target.value || null) as WorkSession["outcome"] })}>
        <option value="">Not finished</option>
        {["finished", "partial", "blocked", "rework"].map((v) => (
          <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>
        ))}
      </select>
    </label>
    <label>
      Delay reason
      <input value={session.delay_reason}
        onChange={(e) => setSession({ ...session, delay_reason: e.target.value })} />
    </label>
    {machinery && <fieldset className="cw-correction-wide cw-machine-timers">
      <legend><Tractor size={15} aria-hidden="true" />Machine timers
        <span>{clockText(Math.round((timersChanged || timers.length ? timersMs(timers) : row.workday_machinery_ms ?? 0) / 1000))}</span></legend>
      {!timers.length && !timersChanged && Boolean(row.workday_machinery_ms) && <p className="muted">
        This activity has machinery time but its in and out times were not kept. Adding a timer here replaces that total.
      </p>}
      {timers.map((timer, index) => <div className="cw-machine-timer" key={index}>
        <label>In
          <input type="datetime-local" step={1} value={localTime(timer.on, true)}
            min={localTime(session.started_at, true)} max={localTime(session.ended_at!, true)}
            onChange={(e) => e.target.value && changeTimers(timers.map((other, at) =>
              at === index ? { ...other, on: new Date(e.target.value).toISOString() } : other))} />
        </label>
        <label>Out
          <input type="datetime-local" step={1} value={timer.off ? localTime(timer.off, true) : ""}
            min={localTime(session.started_at, true)} max={localTime(session.ended_at!, true)}
            onChange={(e) => e.target.value && changeTimers(timers.map((other, at) =>
              at === index ? { ...other, off: new Date(e.target.value).toISOString() } : other))} />
        </label>
        <button type="button" className="cw-machine-remove" aria-label={`Remove machine timer ${index + 1}`}
          onClick={() => changeTimers(timers.filter((_, at) => at !== index))}><X size={16} aria-hidden="true" /></button>
      </div>)}
      <button type="button" className="cw-machine-add" onClick={() => {
        // Starts after the last timer, or with the activity, and runs to its end.
        const last = timers.at(-1)?.off;
        changeTimers([...timers, { on: last ?? session.started_at, off: session.ended_at }]);
      }}><Plus size={15} aria-hidden="true" />Add machine timer</button>
    </fieldset>}
    <label className="cw-correction-wide">
      Notes
      <textarea rows={2} value={session.description}
        onChange={(e) => setSession({ ...session, description: e.target.value })} />
    </label>
    <label className="cw-correction-wide">
      Correction reason
      <input value={reason} placeholder="Why is this being changed?"
        onChange={(e) => setReason(e.target.value)} />
    </label>
    {error && <p role="alert" className="cw-correction-wide">{error}</p>}
    <div className="cw-correction-foot cw-correction-wide">
      <p className="muted">
        Changes the recorded activity only, not the timecard. Times must
        fall inside a closed job clock for the same job.
      </p>
      <div className="cw-actions">
        <button type="button" onClick={() => onCancel()}>Cancel</button>
        <button type="button" className="cw-correction-save" disabled={busy || reason.trim().length < 3}
          onClick={() => void save()}>
          Save correction
        </button>
      </div>
    </div>
  </section>;
}
