// Jobs page search, grouping and the "Next on your schedule" recommendation
// (owner ask: less scrolling on /projects). Everything here is PURE — no
// React, no Supabase, no clock of its own — so the ordering a test checks is
// exactly the ordering the page renders, and a schedule fixture can drive it
// without a server.
//
// Dates and clock times are plain strings throughout: "YYYY-MM-DD" days and
// "HH:MM[:SS]" times, the same shapes lib/schedule/dates.ts already uses for
// the board and lib/pipeline.ts uses for the pipeline chip. Local, never UTC
// — a day and a clock reading mean what the person standing in front of the
// phone would call "today" and "right now".

import { addDaysISO, daysBetween, enumerateDays } from "./schedule/dates";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Strip accents and case so "Peña" matches "pena" and "PEÑA" alike. */
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** The query split into the tokens a job must match ALL of. Empty for a blank query. */
export function searchTokens(query: string): string[] {
  return normalizeForSearch(query).trim().split(/\s+/).filter(Boolean);
}

/** The fields search reads, loose rather than `Project` so a fixture can hand
 * over four strings instead of the whole row. */
export interface SearchableJob {
  name?: string | null;
  job_code?: string | null;
  address?: string | null;
  customer_name?: string | null;
}

/**
 * True when `job` matches every token in `query` — case- and
 * diacritic-insensitive, across name, job code, address and customer name. A
 * blank query matches everything, which is what "no search yet" should do.
 */
export function matchesSearch(job: SearchableJob, query: string): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const haystack = normalizeForSearch(
    [job.name, job.job_code, job.address, job.customer_name].filter(Boolean).join(" "),
  );
  return tokens.every((token) => haystack.includes(token));
}

// ---------------------------------------------------------------------------
// Alphabetical grouping
// ---------------------------------------------------------------------------

/** The key every A-Z group and search result sorts by: name, falling back to
 * job code for the rare row with no name yet. */
function alphaKey(job: { name?: string | null; job_code?: string | null }): string {
  return (job.name || job.job_code || "").toLocaleLowerCase();
}

/** Alphabetical, diacritic-aware (`localeCompare`), with the row id as the
 * last tiebreak so two jobs sharing a name sort the same way on every render. */
function compareJobsAlpha<T extends { id: string; name?: string | null; job_code?: string | null }>(
  a: T,
  b: T,
): number {
  const byName = alphaKey(a).localeCompare(alphaKey(b));
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A stable alphabetical copy — what a single chip (Scheduled, Recent) or a
 * search result shows: one flat list, no sub-grouping. */
export function sortJobsAlpha<T extends { id: string; name?: string | null; job_code?: string | null }>(
  jobs: readonly T[],
): T[] {
  return [...jobs].sort(compareJobsAlpha);
}

export interface GroupedJobs<T> {
  /** The job shown above the list, or null when nothing qualifies (see
   * `nextScheduledJob`). Never also present in the groups below, unless
   * `keepHighlightedInGroups` was asked for (search: the highlighted job must
   * still be findable by its own name). */
  highlighted: T | null;
  scheduled: T[];
  recentlyWorked: T[];
  other: T[];
}

/**
 * One job appears exactly once: scheduled beats recently-worked beats
 * everything else, and the highlighted job (today's or next's recommended
 * job) is pulled out of the list entirely — UNLESS `keepHighlightedInGroups`
 * is set, which is what a search does: a person typing the highlighted job's
 * own name must still find it in the results, not just in the banner above.
 */
export function groupJobsForList<T extends { id: string; name?: string | null; job_code?: string | null }>(
  jobs: readonly T[],
  scheduledIds: ReadonlySet<string>,
  recentlyWorkedIds: ReadonlySet<string>,
  highlightedId: string | null,
  keepHighlightedInGroups = false,
): GroupedJobs<T> {
  const highlighted = highlightedId ? jobs.find((j) => j.id === highlightedId) ?? null : null;
  const omit = highlighted && !keepHighlightedInGroups ? highlighted.id : null;

  const scheduled: T[] = [];
  const recentlyWorked: T[] = [];
  const other: T[] = [];
  for (const job of jobs) {
    if (job.id === omit) continue;
    if (scheduledIds.has(job.id)) scheduled.push(job);
    else if (recentlyWorkedIds.has(job.id)) recentlyWorked.push(job);
    else other.push(job);
  }
  scheduled.sort(compareJobsAlpha);
  recentlyWorked.sort(compareJobsAlpha);
  other.sort(compareJobsAlpha);
  return { highlighted, scheduled, recentlyWorked, other };
}

// ---------------------------------------------------------------------------
// Recently-worked project ids
// ---------------------------------------------------------------------------

/** A shift row counts unless it was voided or rejected — the same two
 * statuses CONTEXT.md's Void and the timecard already treat as "did not
 * happen". A custom-work session carries its linked shift's status
 * (`shift_status`), not a status of its own. */
const EXCLUDED_SHIFT_STATUSES = new Set(["voided", "rejected"]);

export interface RecentWorkSessionRow {
  project_id: string | null;
  shift_status?: string | null;
}
export interface RecentWorkShiftRow {
  project_id: string | null;
  status?: string | null;
}

/**
 * Every project id this person actually worked, from the two sources real
 * field time lives in — custom-work sessions and time-clock shifts — never
 * `project.updated_at` (anyone's edit) or another person's history. The
 * caller bounds both queries to a recent window and a row cap; this function
 * only applies the status exclusion, so it stays correct however the caller
 * tunes those bounds.
 */
export function recentlyWorkedProjectIds(
  sessions: readonly RecentWorkSessionRow[],
  shifts: readonly RecentWorkShiftRow[],
): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions) {
    if (s.project_id && !EXCLUDED_SHIFT_STATUSES.has(s.shift_status ?? "")) ids.add(s.project_id);
  }
  for (const s of shifts) {
    if (s.project_id && !EXCLUDED_SHIFT_STATUSES.has(s.status ?? "")) ids.add(s.project_id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Scheduling: scheduled-job ids and the one "next" recommendation
// ---------------------------------------------------------------------------

/** How far ahead "Next on your schedule" is allowed to look. Six weeks,
 * inclusive of today (today + the next 41 days) — the owner's bound, so the
 * page never implies it knows a crew's plans further out than that. */
export const RECOMMENDATION_HORIZON_DAYS = 41;

/** The fields this module reads off a schedule assignment — a loose shape
 * (mirrors `PipelineJob` in lib/pipeline.ts) so a fixture or a projection can
 * hand over six fields instead of the whole `ScheduleAssignment`. */
export interface ScheduleCandidate {
  id: string;
  project_id: string | null;
  kind: "install" | "delivery";
  start_date: string;
  end_date: string;
  start_time?: string | null;
  end_time?: string | null;
  /** Absent is read as published — callers that already filtered to
   * `status = 'published'` (every `listMyPublished` caller) need not repeat it. */
  status?: string | null;
}

/** Deliveries have no `project_id` and never recommend a job; this is the one
 * filter both `scheduledProjectIds` and `nextScheduledJob` share. */
function isSchedulableInstall(a: ScheduleCandidate): a is ScheduleCandidate & { project_id: string } {
  return a.kind === "install" && !!a.project_id && (a.status ?? "published") === "published";
}

/** Every project id with a published assignment for this person — the
 * "Scheduled" chip and group. No horizon bound: whatever window the caller
 * queried `listMyPublished` for is the window this reflects. */
export function scheduledProjectIds(assignments: readonly ScheduleCandidate[]): Set<string> {
  const ids = new Set<string>();
  for (const a of assignments) if (isSchedulableInstall(a)) ids.add(a.project_id);
  return ids;
}

/** First five characters of an "HH:MM[:SS]" clock string, or null for
 * anything unreadable — so "08:00:00" and "08:00" compare equal and a blank
 * or malformed time reads as unknown rather than crashing the comparison. */
function hhmm(time: string | null | undefined): string | null {
  if (!time) return null;
  const m = /^(\d{2}):(\d{2})(?::([0-5]\d))?$/.exec(time);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]}:${m[2]}` : null;
}

/**
 * Has this assignment's end time actually passed, as of `nowClock`?
 *
 * Three ways to be honest about NOT knowing, each on its own line because
 * each is a different kind of unknown:
 *   - no end time at all (an old assignment, or one nobody set an end for)
 *   - no current time was given (the caller could not read the clock)
 *   - the end time is at or before the start time, which on a single day
 *     reads as overnight (an 8 PM start ending at 6 AM) rather than a job
 *     that ended before it began — and an overnight span's "did it end yet"
 *     needs tomorrow's date, which this function is never given.
 * Any of the three means "not provably over", and this returns false — never
 * claiming a job ended when the honest answer is "can't tell".
 */
export function endTimeHasPassed(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  nowClock: string | null,
): boolean {
  const end = hhmm(endTime);
  const now = hhmm(nowClock);
  if (!end || !now) return false;
  const start = hhmm(startTime);
  if (start && end <= start) return false;
  return now >= end;
}

export interface NextScheduleEntry<T extends ScheduleCandidate> {
  assignment: T;
  /** The specific day this recommendation is about — today, or a day ahead. */
  day: string;
}

/**
 * The one job to put above the list: the earliest day, inside the six-week
 * horizon, that still has work ahead of it.
 *
 * "Earliest day with work ahead of it" is doing two jobs at once, on
 * purpose:
 *   - an ongoing or not-yet-started assignment TODAY always wins over
 *     anything later, published or not
 *   - but today's assignment stops counting the moment its end time has
 *     actually passed (`endTimeHasPassed`), so a crew member checking this
 *     at 6 PM after a job that ended at 3 sees tomorrow's job, not today's
 *     stale one
 *
 * Ties (same day, same start time, e.g. two assignments with no time set)
 * resolve on the assignment id, so the answer never depends on array order.
 * Drafts, canceled and done rows are excluded by `isSchedulableInstall`
 * unless the caller already filtered to published-only, in which case this
 * is a no-op re-check, never a hole.
 */
export function nextScheduledJob<T extends ScheduleCandidate>(
  assignments: readonly T[],
  todayISO: string,
  nowClock: string | null,
  horizonDays: number = RECOMMENDATION_HORIZON_DAYS,
): NextScheduleEntry<T> | null {
  const horizonEnd = addDaysISO(todayISO, horizonDays);
  const entries: NextScheduleEntry<T>[] = [];
  for (const a of assignments) {
    if (!isSchedulableInstall(a)) continue;
    const spanStart = daysBetween(todayISO, a.start_date) >= 0 ? a.start_date : todayISO;
    const spanEnd = daysBetween(a.end_date, horizonEnd) >= 0 ? a.end_date : horizonEnd;
    if (daysBetween(spanStart, spanEnd) < 0) continue;
    for (const day of enumerateDays(spanStart, spanEnd)) entries.push({ assignment: a, day });
  }

  entries.sort((x, y) => {
    // ISO day strings ("YYYY-MM-DD") sort correctly as plain strings — no need
    // to route this through daysBetween, whose (a, b) => b-a direction is easy
    // to get backwards here (it was, the first time this was written).
    const byDay = x.day < y.day ? -1 : x.day > y.day ? 1 : 0;
    if (byDay !== 0) return byDay;
    const timeX = x.assignment.start_time ?? "99:99";
    const timeY = y.assignment.start_time ?? "99:99";
    if (timeX !== timeY) return timeX < timeY ? -1 : 1;
    return x.assignment.id < y.assignment.id ? -1 : x.assignment.id > y.assignment.id ? 1 : 0;
  });

  for (const entry of entries) {
    const isToday = entry.day === todayISO;
    if (isToday && endTimeHasPassed(entry.assignment.start_time, entry.assignment.end_time, nowClock)) {
      continue;
    }
    return entry;
  }
  return null;
}

/** "08:07" for right now, in the device's own timezone — what `nextScheduledJob`
 * compares an assignment's end time against. A thin wrapper so every caller
 * reads the clock the same way instead of re-deriving it. */
export function nowClockLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// View chips (All / Scheduled / Recent)
// ---------------------------------------------------------------------------

export type JobsViewFilter = "all" | "scheduled" | "recent";

/**
 * The chip filter, applied BEFORE search. Search itself always reads the
 * full list regardless of which chip is selected — the page is responsible
 * for passing `"all"` here once there is a query, not this function, since
 * "search ignores the chip" is a page-level decision about what to call the
 * chip row while searching, not a rule about the data.
 */
export function filterJobsByView<T extends { id: string }>(
  jobs: readonly T[],
  view: JobsViewFilter,
  scheduledIds: ReadonlySet<string>,
  recentlyWorkedIds: ReadonlySet<string>,
): T[] {
  if (view === "scheduled") return jobs.filter((j) => scheduledIds.has(j.id));
  if (view === "recent") return jobs.filter((j) => recentlyWorkedIds.has(j.id));
  return [...jobs];
}
