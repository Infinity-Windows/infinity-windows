import type { TimeShift } from "./timeclock";
export function lunchReminder(shift: TimeShift | null, now: number) {
  if (
    !shift ||
    shift.status !== "open" ||
    shift.clock_out_at ||
    shift.break_type !== "lunch" ||
    !shift.break_started_at
  )
    return null;
  const started = Date.parse(shift.break_started_at);
  if (
    !Number.isFinite(started) ||
    now - started < 30 * 60_000 ||
    now - started >= 2 * 60 * 60_000
  )
    return null;
  return { tag: `lunch:${shift.id}:${started}` };
}
