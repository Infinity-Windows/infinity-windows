/** Shared payroll/timeclock arithmetic. No browser or database dependencies. */
export interface ShiftTime {
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  break_started_at: string | null;
}
export const SHIFT_CAP_HOURS = 16;

export function currentBreakSeconds(s: ShiftTime, now = Date.now()): number {
  const running = s.break_started_at
    ? Math.max(0, Math.floor((now - new Date(s.break_started_at).getTime()) / 1000))
    : 0;
  return (s.break_seconds ?? 0) + running;
}

/** Live worked seconds for an open shift: wall time minus all break time. */
export function elapsedWorkSeconds(s: ShiftTime, now = Date.now()): number {
  const end = s.clock_out_at ? new Date(s.clock_out_at).getTime() : now;
  const gross = Math.max(0, Math.floor((end - new Date(s.clock_in_at).getTime()) / 1000));
  return Math.max(0, gross - currentBreakSeconds(s, now));
}

export function shiftHours(s: ShiftTime): number {
  if (!s.clock_out_at) return 0;
  const ms = new Date(s.clock_out_at).getTime() - new Date(s.clock_in_at).getTime();
  return Math.max(0, ms / 3600000 - s.break_seconds / 3600);
}
