/**
 * When a shift has run so long that the clock is no longer evidence of
 * anything, and what the app is allowed to do about it.
 *
 * This exists because of a real one: a shift was opened on 18 July and never
 * closed, and twelve days later the clock sheet was showing "WORKING
 * 286:57:59". The number was arithmetically correct — it really was that long
 * since the punch — but it was not a fact about anyone's working day.
 *
 * The dangerous part was not the display. `clock_in` closes a dangling shift
 * by stamping `clock_out_at = now()`, so the next time that person punched in
 * anywhere, all 286 hours would have become a *submitted* timecard with a
 * confident-looking total on it. Nobody typed that number and nobody worked
 * it.
 *
 * So the rule here is the same one the install timer settled on in
 * `install/installTimer.ts`: past the point where an auto-timed figure is
 * believable, stop filling the number in and ask for it. A gap that asks a
 * human is recoverable; a wrong number that looks confident is not.
 *
 *   Never invent hours somebody did not work.
 *   Never silently erase hours they did.
 */

import type { TimeShift } from "./timeclock";
import { elapsedWorkSeconds } from "./timeclock";

/**
 * Longer than a long day, but still possibly true — a big install with travel
 * either side can run past twelve hours. We keep counting, and we make sure a
 * foreman can see it today rather than discovering it at payroll.
 */
export const SHIFT_LONG_HOURS = 12;

/**
 * Past this, "still on the clock" stops meaning "still working" and starts
 * meaning "forgot to clock out" or "phone died". No single continuous shift
 * runs sixteen hours, so beyond it the timer is measuring absence, not work.
 * We stop counting and ask for the real finish time.
 */
export const SHIFT_CAP_HOURS = 16;

export const SHIFT_LONG_SECONDS = SHIFT_LONG_HOURS * 3600;
export const SHIFT_CAP_SECONDS = SHIFT_CAP_HOURS * 3600;

/** Clock skew between a phone and the server, tolerated on a typed finish. */
const FUTURE_TOLERANCE_MS = 2 * 60_000;

export type ShiftGuardState =
  /** Normal. The live timer is honest. */
  | "running"
  /** Longer than a normal day but still plausible — counting, and flagged. */
  | "long"
  /** Too long to believe. We stop counting and ask for the real finish. */
  | "over-cap"
  /** The server gave up on it: no finish time, and only a human knows it. */
  | "needs-finish";

export interface ShiftGuardView {
  state: ShiftGuardState;
  /**
   * Worked seconds to display, or null when there is nothing truthful to
   * show. Null must never be rendered as 0 — a shift nobody closed has an
   * unknown length, not a length of zero.
   */
  workedSeconds: number | null;
  /** Wall seconds since the punch. Always known, and always safe to say. */
  sinceClockInSeconds: number;
  /** True once the office should be looking at this shift. */
  flagged: boolean;
}

/** Has the server marked this shift as awaiting a hand-entered finish time? */
export function needsFinishTime(shift: Pick<TimeShift, "status">): boolean {
  return shift.status === "needs_finish";
}

/** Is this shift still accruing, i.e. no finish time recorded? */
export function isUnfinished(
  shift: Pick<TimeShift, "status" | "clock_out_at">,
): boolean {
  return shift.clock_out_at == null && (shift.status === "open" || needsFinishTime(shift));
}

/** The whole state machine for one shift. */
export function shiftGuard(shift: TimeShift, now = Date.now()): ShiftGuardView {
  const since = Math.max(
    0,
    Math.floor((now - new Date(shift.clock_in_at).getTime()) / 1000),
  );

  if (needsFinishTime(shift)) {
    return {
      state: "needs-finish",
      workedSeconds: null,
      sinceClockInSeconds: since,
      flagged: true,
    };
  }

  const worked = elapsedWorkSeconds(shift, now);

  // A shift that has actually been closed is somebody's recorded answer, not
  // a guess, however long it is. We only police the ones still running.
  if (shift.clock_out_at) {
    return {
      state: worked >= SHIFT_LONG_SECONDS ? "long" : "running",
      workedSeconds: worked,
      sinceClockInSeconds: since,
      flagged: worked >= SHIFT_LONG_SECONDS,
    };
  }

  if (worked >= SHIFT_CAP_SECONDS) {
    return {
      state: "over-cap",
      workedSeconds: null,
      sinceClockInSeconds: since,
      flagged: true,
    };
  }
  if (worked >= SHIFT_LONG_SECONDS) {
    return {
      state: "long",
      workedSeconds: worked,
      sinceClockInSeconds: since,
      flagged: true,
    };
  }
  return {
    state: "running",
    workedSeconds: worked,
    sinceClockInSeconds: since,
    flagged: false,
  };
}

/** Shifts the office needs to look at, longest-running first. */
export function flaggedShifts(shifts: TimeShift[], now = Date.now()): TimeShift[] {
  return shifts
    .filter((s) => shiftGuard(s, now).flagged)
    .sort(
      (a, b) =>
        shiftGuard(b, now).sinceClockInSeconds - shiftGuard(a, now).sinceClockInSeconds,
    );
}

/**
 * "12 days", "1 day 3 hours", "13 hours", "45 minutes" — how long it has been,
 * in words a non-technical reader can act on. H:MM:SS is unreadable past a day.
 */
export function describeDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (days > 0) {
    return hours > 0
      ? `${plural(days, "day")} ${plural(hours, "hour")}`
      : plural(days, "day");
  }
  if (hours > 0) {
    return minutes > 0
      ? `${plural(hours, "hour")} ${plural(minutes, "minute")}`
      : plural(hours, "hour");
  }
  return plural(minutes, "minute");
}

/** One plain-English line about a flagged shift, for crew and for the office. */
export function describeFlaggedShift(shift: TimeShift, now = Date.now()): string {
  const view = shiftGuard(shift, now);
  const age = describeDuration(view.sinceClockInSeconds);
  if (view.state === "needs-finish") {
    return `Needs a finish time — clocked in ${age} ago and never clocked out.`;
  }
  if (view.state === "over-cap") {
    return `On the clock ${age} — too long to total up. Needs a real finish time.`;
  }
  if (view.state === "long") {
    return `On the clock ${age} — longer than a normal day.`;
  }
  return `On the clock ${age}.`;
}

export interface FinishTimeCheck {
  ok: boolean;
  /** Why it was refused, in words worth showing a person. */
  error?: string;
  /** Worked hours the entered finish implies, once it is accepted. */
  hours?: number;
}

/**
 * Check a hand-entered finish time before it is sent.
 *
 * The only things refused are the ones that could not be true: a finish before
 * the start, and a finish in the future. A long-but-real answer is accepted —
 * if someone genuinely worked nineteen hours that is their answer to give and
 * the office's to review, and refusing it would push them into typing a
 * comfortable lie instead.
 */
export function checkFinishTime(
  shift: Pick<TimeShift, "clock_in_at" | "break_seconds">,
  candidateIso: string | null,
  now = Date.now(),
): FinishTimeCheck {
  if (!candidateIso) return { ok: false, error: "Pick the time you finished." };

  const finish = new Date(candidateIso).getTime();
  if (Number.isNaN(finish)) return { ok: false, error: "That isn't a time we can read." };

  const start = new Date(shift.clock_in_at).getTime();
  if (Number.isNaN(start)) {
    return { ok: false, error: "This shift's start time is unreadable — ask the office." };
  }
  if (finish <= start) {
    return { ok: false, error: "Your finish time has to be after you clocked in." };
  }
  if (finish > now + FUTURE_TOLERANCE_MS) {
    return { ok: false, error: "That's in the future — use the time you actually finished." };
  }

  const breakSec = Math.max(0, shift.break_seconds ?? 0);
  const hours = Math.max(0, (finish - start) / 3600000 - breakSec / 3600);
  return { ok: true, hours };
}

/**
 * Bounds for the finish-time picker: never before the punch, never after now.
 * Values are local-time strings for a `<input type="datetime-local">`.
 */
export function finishTimeBounds(
  shift: Pick<TimeShift, "clock_in_at">,
  now = Date.now(),
): { min: string; max: string } {
  return { min: toLocalInputValue(shift.clock_in_at), max: toLocalInputValue(now) };
}

/**
 * Wave T2's edit-sheet "duration" mode: pick a clock-in and how many hours
 * were worked, rather than a literal clock-out time, and let the sheet
 * compute the finish time. Pure so it is unit-testable without a page
 * render; the sheet is the only caller, but this has nothing to do with
 * rendering, so it lives with the rest of the shift-time math.
 *
 * Negative durations clamp to zero rather than erroring — the input is a
 * plain number field, and a momentarily-negative value while someone is
 * still typing (e.g. "-" before "1.5" is corrected) should never crash a
 * live preview.
 */
export function endFromDuration(clockInIso: string, durationHours: number): string {
  const start = new Date(clockInIso).getTime();
  const hours = Number.isFinite(durationHours) ? Math.max(0, durationHours) : 0;
  return new Date(start + hours * 3600_000).toISOString();
}

/** ISO or epoch → the `YYYY-MM-DDTHH:MM` a datetime-local input wants. */
export function toLocalInputValue(at: string | number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
