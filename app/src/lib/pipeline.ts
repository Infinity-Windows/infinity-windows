// The job pipeline: readiness, the windows' ETA, and when somebody should be
// making a phone call about a job (Wave J, transcripts grill 2026-09-03, Q8+Q9).
//
// Everything here is PURE — no React, no Supabase, no clock of its own. That is
// what lets the same rule drive two things that must never disagree: the
// "Needs a call" chip a foreman sees on the Jobs page, and the 7 AM sweep that
// pushes a warning to a phone. The sweep's copy of the rule is in SQL, inside
// claim_pipeline_nudges() (migration 20260979000000), because a sweep has to
// decide and claim in one statement; pipeline.test.ts carries a block named
// after that function which spells its clauses out here, so a change made to
// one side and not the other fails a test instead of going quietly live.
//
// Dates are handled as plain YYYY-MM-DD day strings throughout, and every one
// of them is parsed as LOCAL midnight (`${day}T00:00:00`). `new Date("2026-09-
// 22")` alone parses as UTC midnight, which prints as the day BEFORE across
// every US timezone — the same bug lib/dailyLogDay.ts exists to prevent.

import type { Project } from "./types";

/** A job is either ready for us to work or it is not. Mirrors the CHECK. */
export type ReadyState = "not_ready" | "ready";

/**
 * How many days before a start date the app starts saying something, and how
 * stale a GC check-in has to be before it counts against a job. Both are the
 * numbers the SQL uses; changing one means changing both.
 */
export const NUDGE_DAYS_FAR = 14;
export const NUDGE_DAYS_NEAR = 7;
export const GC_CHECKIN_STALE_DAYS = 14;

/** What the sweep can say about a job. Wave O adds its own kinds to the same
 * ledger table; this union is only the ones wave J writes. */
export type PipelineNudgeKind = "start_14" | "start_7" | "materials_late";

/** Why a job needs a phone call. Rendered as chips and joined into push copy. */
export type PipelineReason =
  | "not_ready"
  | "materials_missing"
  | "materials_late"
  | "no_gc_checkin";

/**
 * The fields of a job this module reads. A loose shape rather than `Project`
 * so a test, a fixture or a projection can hand over four fields instead of
 * thirty — and so a phone running ahead of the migration, where the columns
 * simply are not in the row yet, is a normal input rather than a crash.
 */
export interface PipelineJob {
  /** From the `project_pipeline` side table, folded onto the job by
   * lib/api.ts's flattenPipeline. Wave H (H0) moved it off `projects`, which a
   * granted builder reads whole — see the note in lib/types.ts. */
  ready_state?: string | null;
  start_date?: string | null;
  materials_eta?: string | null;
  materials_arrived_at?: string | null;
}

export interface NeedsCallResult {
  /** True when at least one reason applies. */
  call: boolean;
  reasons: PipelineReason[];
  /** Days from `today` to `start_date`; null when the job has no start date.
   * Negative once the start date has passed. */
  daysUntilStart: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight for a YYYY-MM-DD day string, or null for anything else. */
function localMidnight(day: string | null | undefined): Date | null {
  if (!day) return null;
  const iso = day.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whole days from `today` to `day`, positive for the future. Null when either
 * date is missing or unreadable.
 *
 * Rounded rather than truncated because the two Date objects are local
 * midnights an exact number of days apart everywhere except the two mornings a
 * year a daylight-saving change makes one of those "days" 23 or 25 hours long.
 * Truncating there turns 7 days into 6, which would move a warning a day early
 * once a year for no reason anybody could ever find.
 */
export function daysBetween(today: string, day: string | null | undefined): number | null {
  const from = localMidnight(today);
  const to = localMidnight(day);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * "Sep 22" — the short date the job cards and the Pipeline card print.
 *
 * No year, because every date this wave shows is within weeks either way and a
 * card that reads "start ~Sep 22, 2026" on a phone is a card with less room for
 * the job's name. Parsed as LOCAL midnight for the reason at the top of this
 * file. An empty or unreadable date renders as an empty string, never "Invalid
 * Date" — a job with no start date should look like a job with no start date.
 */
export function shortDay(day: string | null | undefined, locale?: string): string {
  const at = localMidnight(day?.slice(0, 10));
  if (!at) return "";
  return at.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/**
 * True when the windows were PROMISED for a day and have not been marked
 * arrived.
 *
 * The promise is half the rule, and leaving it out was the bug. A bare
 * `!materials_arrived_at` is true of every job in the company on the morning
 * this ships, because `materials_arrived_at` is a brand new column nobody has
 * ever been able to set — so the first sweep would have pushed "windows not in"
 * about every job starting inside a fortnight, and lit a "Needs a call" chip on
 * every one of those cards, for the crime of never having been asked.
 *
 * That is exactly the reasoning that keeps the GC check-in clause switched off
 * until wave H (see needsCall's `gcCheckinsKnown`), and it holds here for the
 * same reason: a fact nobody has been able to record yet is UNKNOWN, and an
 * unknown is never counted against a job. An ETA on file is what turns it into
 * a fact — somebody said the windows were coming on the 15th, and they are not
 * here.
 */
export function materialsMissing(job: PipelineJob): boolean {
  return !!job.materials_eta && !job.materials_arrived_at;
}

/**
 * True when the promised day for the windows has passed and nothing has been
 * marked arrived. A job with no ETA on file cannot be late — it was never
 * promised anything.
 */
export function materialsLate(job: PipelineJob, today: string): boolean {
  if (!materialsMissing(job)) return false;
  const days = daysBetween(today, job.materials_eta);
  return days !== null && days < 0;
}

/**
 * Does somebody need to pick up the phone about this job?
 *
 * `lastCheckinAt` is the seam for wave H (the GC handshake), and it is
 * deliberately inert until that wave lands. Today every caller passes null,
 * which means UNKNOWN — nobody has ever been able to record a GC check-in, so
 * "there has not been one in 14 days" is true of every job in the company and
 * is not a fact worth pushing anyone about. When H ships the
 * project_gc_checkins table, its callers pass `gcCheckinsKnown = true` along
 * with the real timestamp (or null, meaning genuinely never), and the fourth
 * reason switches itself on with no other change here.
 */
export function needsCall(
  job: PipelineJob,
  today: string,
  lastCheckinAt: string | null = null,
  gcCheckinsKnown = false,
): NeedsCallResult {
  const daysUntilStart = daysBetween(today, job.start_date);
  const reasons: PipelineReason[] = [];
  const startingSoon =
    daysUntilStart !== null && daysUntilStart >= 0 && daysUntilStart <= NUDGE_DAYS_FAR;

  if (startingSoon && job.ready_state === "not_ready") reasons.push("not_ready");
  if (startingSoon && materialsMissing(job)) reasons.push("materials_missing");
  if (materialsLate(job, today)) reasons.push("materials_late");

  if (gcCheckinsKnown && startingSoon) {
    const sinceCheckin = lastCheckinAt ? daysBetween(today, lastCheckinAt.slice(0, 10)) : null;
    // Null here means "no check-in on file at all", which — once the table
    // exists — is itself the thing worth calling about.
    if (sinceCheckin === null || -sinceCheckin >= GC_CHECKIN_STALE_DAYS) {
      reasons.push("no_gc_checkin");
    }
  }

  return { call: reasons.length > 0, reasons, daysUntilStart };
}

/** One warning the sweep would send about a job this morning. */
export interface DueNudge {
  kind: PipelineNudgeKind;
  /** The day this nudge is ABOUT — the start date, or the ETA that was missed.
   * It is the idempotency key, not the day it was sent. */
  onDate: string;
  daysUntilStart: number | null;
  notReady: boolean;
  materialsMissing: boolean;
}

/**
 * The sweep's decision, in TypeScript — the readable twin of
 * claim_pipeline_nudges()'s `due` CTE.
 *
 * Two rules today:
 *   (a) the job starts within a fortnight and is still not ready, or its
 *       windows were promised and are not here. Said once at the far mark
 *       (8..14 days out) and once at the near mark (0..7). WINDOWED rather than
 *       "exactly 14 and exactly 7" because one missed sweep must not silently
 *       drop a warning; the ledger's unique key is what makes each one a single
 *       event per start date.
 *   (b) the promised ETA came and went with nothing arrived — once, keyed to
 *       the date that was missed, so it never becomes a daily drumbeat.
 *
 * A job nobody has promised windows for raises neither, on purpose — see
 * materialsMissing.
 */
export function dueNudges(job: PipelineJob, today: string): DueNudge[] {
  const out: DueNudge[] = [];
  const days = daysBetween(today, job.start_date);
  const notReady = job.ready_state === "not_ready";
  const missing = materialsMissing(job);

  if (days !== null && days >= 0 && days <= NUDGE_DAYS_FAR && (notReady || missing)) {
    out.push({
      kind: days > NUDGE_DAYS_NEAR ? "start_14" : "start_7",
      // The start date itself is the key: move the date and the crew is warned
      // again about the new plan, which is right and not an accident.
      onDate: (job.start_date ?? "").slice(0, 10),
      daysUntilStart: days,
      notReady,
      materialsMissing: missing,
    });
  }

  if (materialsLate(job, today)) {
    out.push({
      kind: "materials_late",
      onDate: (job.materials_eta ?? "").slice(0, 10),
      daysUntilStart: days,
      notReady,
      materialsMissing: true,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// J2 — one order for the jobs list, everywhere
// ---------------------------------------------------------------------------

/**
 * The order every jobs list reads in: the office's hand-made order first, then
 * the jobs starting soonest, then alphabetically.
 *
 * Nulls sort LAST at both steps, which is the whole point of the rule. A job
 * nobody has placed by hand, or one with no start date, belongs after the ones
 * somebody made a decision about — not first, which is where a plain ascending
 * sort with nulls would put it.
 *
 * The server applies the same three keys (lib/api.ts asks PostgREST for them);
 * this comparator is what makes the answer identical when a screen re-sorts
 * locally, when an optimistic reorder is showing, and on a phone whose database
 * does not have sort_order yet.
 */
export function compareProjectsForList(
  a: Pick<Project, "name" | "job_code"> & { sort_order?: number | null; start_date?: string | null },
  b: Pick<Project, "name" | "job_code"> & { sort_order?: number | null; start_date?: string | null },
): number {
  const byOrder = nullsLast(a.sort_order ?? null, b.sort_order ?? null);
  if (byOrder !== 0) return byOrder;
  const byStart = nullsLast(dayOrNull(a.start_date), dayOrNull(b.start_date));
  if (byStart !== 0) return byStart;
  const nameA = (a.name || a.job_code || "").toLocaleLowerCase();
  const nameB = (b.name || b.job_code || "").toLocaleLowerCase();
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

function dayOrNull(value: string | null | undefined): string | null {
  const day = value ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function nullsLast(a: number | string | null, b: number | string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stable copy of `rows` in list order. */
export function sortProjectsForList<
  T extends Pick<Project, "name" | "job_code"> & {
    sort_order?: number | null;
    start_date?: string | null;
  },
>(rows: readonly T[]): T[] {
  return [...rows].sort(compareProjectsForList);
}
