// Pure date-only helpers for the schedule board. Everything operates on
// "YYYY-MM-DD" strings in UTC so day math never drifts with the viewer's local
// timezone or DST. Kept free of React/Supabase so the geometry, windowing and
// conflict logic that build on top stay directly unit-testable.

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a well-formed calendar date string "YYYY-MM-DD". */
export function isISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Parse "YYYY-MM-DD" to a UTC-midnight epoch (ms). Throws on malformed input. */
export function isoToUtc(iso: string): number {
  if (!isISODate(iso)) throw new Error(`Invalid ISO date: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Epoch (ms) back to a "YYYY-MM-DD" string. */
export function utcToISO(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Add (or subtract) whole days to a date string. */
export function addDaysISO(iso: string, days: number): string {
  return utcToISO(isoToUtc(iso) + days * DAY_MS);
}

/** Whole days from `a` to `b` (b - a); negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((isoToUtc(b) - isoToUtc(a)) / DAY_MS);
}

/** Inclusive day count of a range [start, end]. Always ≥ 1 for valid ranges. */
export function rangeLengthDays(startISO: string, endISO: string): number {
  return Math.max(0, daysBetween(startISO, endISO)) + 1;
}

/** Every day string in [start, end] inclusive (capped to avoid runaways). */
export function enumerateDays(startISO: string, endISO: string, cap = 400): string[] {
  const out: string[] = [];
  let cur = startISO;
  for (let i = 0; i <= cap && daysBetween(cur, endISO) >= 0; i += 1) {
    out.push(cur);
    cur = addDaysISO(cur, 1);
  }
  return out;
}

/** Clamp a date string into [min, max]. */
export function clampISO(iso: string, minISO: string, maxISO: string): string {
  if (daysBetween(iso, minISO) > 0) return minISO;
  if (daysBetween(maxISO, iso) > 0) return maxISO;
  return iso;
}

/** 0=Sun … 6=Sat for a date string (UTC). */
export function weekdayISO(iso: string): number {
  return new Date(isoToUtc(iso)).getUTCDay();
}

/** Monday-based start of the week containing `iso`. */
export function startOfWeekISO(iso: string, weekStartsOn = 1): string {
  const dow = weekdayISO(iso);
  const delta = (dow - weekStartsOn + 7) % 7;
  return addDaysISO(iso, -delta);
}

/** First day of the month for `iso`. */
export function startOfMonthISO(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Last day of the month for `iso`. */
export function endOfMonthISO(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

/** The 6-week (42-day) grid a month calendar renders, Monday-aligned. */
export function monthGridRange(monthISO: string): { from: string; to: string } {
  const from = startOfWeekISO(startOfMonthISO(monthISO));
  return { from, to: addDaysISO(from, 41) };
}

/** Inclusive overlap test for two date ranges. */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return daysBetween(aStart, bEnd) >= 0 && daysBetween(bStart, aEnd) >= 0;
}

/** Short "Mon 21" style label for a day header. */
export function shortDayLabel(iso: string): string {
  return new Date(isoToUtc(iso)).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Mon, Jul 21" agenda header. */
export function agendaDayLabel(iso: string): string {
  return new Date(isoToUtc(iso)).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Format an optional "HH:MM[:SS]" clock string to a friendly "8:30 AM". */
export function formatStartTime(time: string | null | undefined): string | null {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  const d = new Date(Date.UTC(2000, 0, 1, h, m || 0));
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}
