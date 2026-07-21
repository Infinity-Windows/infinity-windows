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

/** "March 2026" title for the month containing `iso`. */
export function monthLabel(iso: string): string {
  return new Date(isoToUtc(startOfMonthISO(iso))).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A contiguous run of days that all fall in the same calendar month. */
export interface MonthSection {
  /** "YYYY-MM" key, unique per month in the horizon. */
  key: string;
  /** Human title, e.g. "March 2026". */
  label: string;
  /** Every day string in this month within the requested horizon. */
  days: string[];
}

/**
 * Split an inclusive [from, to] horizon into month sections (one per calendar
 * month it touches), each carrying its day strings in order. Drives the
 * month-stacked vertical calendar's sticky headers + day rows.
 */
export function groupDaysByMonth(
  fromISO: string,
  toISO: string,
  cap = 400,
): MonthSection[] {
  const sections: MonthSection[] = [];
  let current: MonthSection | null = null;
  for (const day of enumerateDays(fromISO, toISO, cap)) {
    const key = day.slice(0, 7);
    if (!current || current.key !== key) {
      current = { key, label: monthLabel(day), days: [] };
      sections.push(current);
    }
    current.days.push(day);
  }
  return sections;
}

/**
 * Map each day in `days` to the items active on it. A multi-day item appears
 * under every day it spans. Item order within a day mirrors input order, so the
 * calendar's per-day stacking is stable across renders.
 */
export function mapItemsToDays<T extends { start_date: string; end_date: string }>(
  items: T[],
  days: string[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const day of days) {
    map.set(
      day,
      items.filter((it) => it.start_date <= day && it.end_date >= day),
    );
  }
  return map;
}

/**
 * Friendly label for a clash day-span: "Mar 3" (single day), "Mar 3–5"
 * (same month) or "Mar 30 – Apr 2" (crossing a month boundary).
 */
export function clashRangeLabel(startISO: string, endISO: string): string {
  const dayOnly = (iso: string) =>
    new Date(isoToUtc(iso)).toLocaleDateString(undefined, {
      day: "numeric",
      timeZone: "UTC",
    });
  const monthDay = (iso: string) =>
    new Date(isoToUtc(iso)).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  if (startISO === endISO) return monthDay(startISO);
  if (startISO.slice(0, 7) === endISO.slice(0, 7)) {
    return `${monthDay(startISO)}–${dayOnly(endISO)}`;
  }
  return `${monthDay(startISO)} – ${monthDay(endISO)}`;
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
