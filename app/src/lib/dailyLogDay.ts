// Wave L: "what day is it" for daily logs — ONE place, on purpose.
//
// Horizon shipped a reminder chip and a filing flow that each computed
// "today" their own way and quietly disagreed near local midnight. The fix
// here is not a cleverer date function; it's refusing to let a second one
// exist. The "Log today" chip (LogTodayChip.tsx, L4), the tab's own
// "+ Log today" button, and the filing dialog's default log_date all call
// localDateISO() — never Date.toISOString().slice(0, 10) (that's UTC, not
// the phone's local day) and never a second hand-rolled version of it.

import { punchDay } from "./timeclock";

/**
 * The phone's local calendar day, as YYYY-MM-DD — "today" by default, or
 * the local day a given instant falls on. Delegates to timeclock.ts's
 * punchDay (the existing convention that buckets a punch into its local
 * day) instead of re-deriving the same local-getters math a second time.
 */
export function localDateISO(at: Date = new Date()): string {
  return punchDay(at.toISOString());
}

/**
 * A log_date (YYYY-MM-DD, no time) as a short human label — "Aug 20, 2026".
 * Parsed as LOCAL midnight (no `Z` suffix), never UTC: `new Date("2026-08-
 * 20")` alone parses as UTC midnight, which prints as the DAY BEFORE across
 * every US timezone — the exact class of bug this file exists to prevent.
 */
export function formatLogDateLabel(logDate: string): string {
  return new Date(`${logDate}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
