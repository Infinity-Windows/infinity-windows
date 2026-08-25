// The crew board's math: Horizon's week-grid ideas (person lanes, job chips,
// coverage, seeding) computed over Infinity's own schedule blocks.
//
// Nothing here fetches or renders. The board is a SURFACE over the existing
// schedule_assignments rows — date-range blocks with member lists — expanded
// to person-days for display. Board edits are made by the page through the
// existing api (draft blocks only; published chips open the block editor),
// so the draft -> Review & Publish -> one-digest-per-person flow stays the
// spine exactly as before.

import type { Profile } from "../install/types";
import { isForemanPlus } from "../install/types";
import type { ScheduleAssignment } from "./types";
import { addDaysISO, enumerateDays, rangesOverlap, startOfWeekISO } from "./dates";

/** One chip on the board: a person's day on a job. */
export interface BoardChip {
  assignmentId: string;
  projectId: string;
  day: string;
  personId: string;
  status: ScheduleAssignment["status"];
}

export interface BoardLane {
  personId: string;
  name: string;
  /** Foremen band first — the people who anchor a crew read first. */
  isLead: boolean;
}

/** Monday-first week the board shows, from any anchor date. */
export function boardWeek(anchorISO: string): string[] {
  const monday = startOfWeekISO(anchorISO, 1);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
}

/**
 * Lanes: every active crew member, foremen banded first, alphabetical within
 * each band. Everyone gets a lane (owner call, 2026-08-11) — Infinity
 * schedules people by name; crews don't "ride along" invisibly.
 */
export function boardLanes(profiles: Profile[]): BoardLane[] {
  return profiles
    .filter((p) => p.active)
    .map((p) => ({
      personId: p.id,
      name: p.display_name,
      isLead: isForemanPlus(p.role),
    }))
    .sort(
      (a, b) =>
        Number(b.isLead) - Number(a.isLead) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

/**
 * Expand range blocks into person-day chips for the visible week.
 * One block spanning Mon–Wed with two members becomes six chips.
 */
export function boardChips(
  assignments: ScheduleAssignment[],
  weekDays: string[],
): BoardChip[] {
  if (weekDays.length === 0) return [];
  const first = weekDays[0];
  const last = weekDays[weekDays.length - 1];
  const chips: BoardChip[] = [];
  for (const a of assignments) {
    if (!rangesOverlap(a.start_date, a.end_date, first, last)) continue;
    for (const day of enumerateDays(a.start_date, a.end_date)) {
      if (day < first || day > last) continue;
      // Delivery entries render on their own strip, never in the job pivot.
      if (a.kind === "delivery" || !a.project_id) continue;
      for (const m of a.members) {
        chips.push({
          assignmentId: a.id,
          projectId: a.project_id,
          day,
          personId: m.profile_id,
          status: a.status,
        });
      }
    }
  }
  return chips;
}

/** Chips keyed for a cell lookup: `${personId}|${day}` (crew pivot). */
export function chipsByPersonDay(chips: BoardChip[]): Map<string, BoardChip[]> {
  const m = new Map<string, BoardChip[]>();
  for (const c of chips) {
    const k = `${c.personId}|${c.day}`;
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  }
  return m;
}

/** Chips keyed `${projectId}|${day}` (job pivot). */
export function chipsByProjectDay(chips: BoardChip[]): Map<string, BoardChip[]> {
  const m = new Map<string, BoardChip[]>();
  for (const c of chips) {
    const k = `${c.projectId}|${c.day}`;
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Coverage: the strip that nags BEFORE a job starts uncovered.
// ---------------------------------------------------------------------------

/** "Three working weeks out" — far enough to fix, near enough to matter. */
export const COVERAGE_LOOKAHEAD_DAYS = 21;
/** Inside this, an uncovered job is an incident, not a reminder. */
export const COVERAGE_IMMINENT_DAYS = 3;

export interface CoverageJob {
  id: string;
  job_code: string;
  name: string;
  /** The job's target start (projects.start_date). */
  start_date: string;
}

export interface CoverageReport {
  upcoming: CoverageJob[];
  covered: CoverageJob[];
  uncovered: CoverageJob[];
  imminent: CoverageJob[];
}

/**
 * A job counts as covered when ANY assignment (draft or published — a plan
 * counts as a plan) touches it on any day from today forward. Past crew does
 * not cover a future start. The bar is deliberately one person-day: the
 * metric exists to start the habit, not to grade staffing levels.
 */
export function coverageReport(
  jobs: { id: string; job_code: string; name: string; start_date?: string | null }[],
  assignments: ScheduleAssignment[],
  todayISO: string,
): CoverageReport {
  const horizon = addDaysISO(todayISO, COVERAGE_LOOKAHEAD_DAYS);
  const upcoming: CoverageJob[] = jobs
    .filter(
      (j): j is CoverageJob & { start_date: string } =>
        typeof j.start_date === "string" &&
        j.start_date >= todayISO &&
        j.start_date <= horizon,
    )
    .map((j) => ({ id: j.id, job_code: j.job_code, name: j.name, start_date: j.start_date! }))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const coveredIds = new Set(
    assignments
      .filter((a) => a.end_date >= todayISO && a.members.length > 0)
      .map((a) => a.project_id),
  );

  const covered = upcoming.filter((j) => coveredIds.has(j.id));
  const uncovered = upcoming.filter((j) => !coveredIds.has(j.id));
  const imminentEdge = addDaysISO(todayISO, COVERAGE_IMMINENT_DAYS);
  const imminent = uncovered.filter((j) => j.start_date <= imminentEdge);
  return { upcoming, covered, uncovered, imminent };
}

// ---------------------------------------------------------------------------
// Outside-window: scheduling crew outside the job's target dates is legal —
// it's how the window gets proven wrong — but the scheduler should SEE it.
// ---------------------------------------------------------------------------

export interface OutsideWindowEntry {
  assignmentId: string;
  jobCode: string;
  /** Which side and by how much, in words. */
  detail: string;
}

export function outsideWindowEntries(
  assignments: ScheduleAssignment[],
  jobs: { id: string; job_code: string; start_date?: string | null; end_date?: string | null }[],
): OutsideWindowEntry[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const out: OutsideWindowEntry[] = [];
  for (const a of assignments) {
    if (!a.project_id) continue; // deliveries have no job window
    const j = byId.get(a.project_id);
    // No window on the job is normal here — say nothing.
    if (!j?.start_date) continue;
    const before = a.start_date < j.start_date;
    // An open-ended window is unbounded on the right.
    const after = j.end_date ? a.end_date > j.end_date : false;
    if (!before && !after) continue;
    const parts: string[] = [];
    if (before) parts.push(`starts before the job's target start (${j.start_date})`);
    if (after) parts.push(`runs past the target completion (${j.end_date})`);
    out.push({ assignmentId: a.id, jobCode: j.job_code, detail: parts.join(" and ") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeding: propose, never auto-commit. Horizon measured why — most person-
// days repeat the next working day, but not reliably on the same job.
// ---------------------------------------------------------------------------

export interface SeedProposal {
  personId: string;
  personName: string;
  projectId: string;
  jobCode: string;
  day: string;
}

/** Dedupe key for a proposed person-day. */
const seedKey = (p: { personId: string; projectId: string; day: string }) =>
  `${p.personId}|${p.projectId}|${p.day}`;

/**
 * "Repeat yesterday's crew": everyone who actually CLOCKED IN on the most
 * recent worked day, proposed onto the target day on the same job. A person
 * who split across two jobs is proposed on both — the human confirming the
 * draft is the one who knows which is right.
 */
export function repeatLastWorkedDay(
  shifts: {
    profile_id: string;
    project_id: string | null;
    clock_in_at: string;
  }[],
  names: Map<string, string>,
  jobCodes: Map<string, string>,
  targetDay: string,
): SeedProposal[] {
  const withJob = shifts.filter(
    (s): s is typeof s & { project_id: string } => s.project_id != null,
  );
  if (withJob.length === 0) return [];
  const dayOf = (iso: string) => iso.slice(0, 10);
  const lastDay = withJob.map((s) => dayOf(s.clock_in_at)).sort().at(-1)!;
  const seen = new Set<string>();
  const out: SeedProposal[] = [];
  for (const s of withJob) {
    if (dayOf(s.clock_in_at) !== lastDay) continue;
    const p = {
      personId: s.profile_id,
      personName: names.get(s.profile_id) ?? "crew",
      projectId: s.project_id,
      jobCode: jobCodes.get(s.project_id) ?? "job",
      day: targetDay,
    };
    const k = seedKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.sort(
    (a, b) => a.personName.localeCompare(b.personName) || a.jobCode.localeCompare(b.jobCode),
  );
}

/**
 * "Copy week forward": this week's PLAN (not punches) shifted 7 days,
 * weekday offsets preserved. Copying a plan forward is a different statement
 * from repeating what happened.
 */
export function copyWeekForward(
  chips: BoardChip[],
  names: Map<string, string>,
  jobCodes: Map<string, string>,
): SeedProposal[] {
  const seen = new Set<string>();
  const out: SeedProposal[] = [];
  for (const c of chips) {
    const p = {
      personId: c.personId,
      personName: names.get(c.personId) ?? "crew",
      projectId: c.projectId,
      jobCode: jobCodes.get(c.projectId) ?? "job",
      day: addDaysISO(c.day, 7),
    };
    const k = seedKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.personName.localeCompare(b.personName));
}

/**
 * Drop proposals already on the board (any status): re-running a seed must
 * be idempotent, not additive.
 */
export function dedupeProposals(
  proposals: SeedProposal[],
  existing: BoardChip[] | ScheduleAssignment[],
): { fresh: SeedProposal[]; skipped: number } {
  const have = new Set<string>();
  for (const e of existing) {
    if ("day" in e) {
      have.add(seedKey(e as BoardChip));
    } else {
      const a = e as ScheduleAssignment;
      if (!a.project_id) continue;
      for (const day of enumerateDays(a.start_date, a.end_date)) {
        for (const m of a.members) {
          have.add(seedKey({ personId: m.profile_id, projectId: a.project_id, day }));
        }
      }
    }
  }
  const fresh = proposals.filter((p) => !have.has(seedKey(p)));
  return { fresh, skipped: proposals.length - fresh.length };
}
