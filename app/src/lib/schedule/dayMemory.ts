// Wave C, C2: the calendar's memory of one day — pure, like dailyLogDraft.ts
// (wave L) is pure. That file trusts its caller to have already bucketed
// shifts/sessions to one job-day; this one can't, because a single call
// covers a whole visible month at once (one query per month beats one query
// per cell), so buildDayMemory does its own local-day bucketing, using wave
// L's localDateISO — "the fix here is not a cleverer date function; it's
// refusing to let a second one exist" (dailyLogDay.ts). Local input shapes
// (DayMemoryShift, DayMemorySession, ...) mirror dailyLogDraft.ts's own
// DailyLogDraftShift/-Session/-Redo convention rather than importing the
// heavier real types (TimeShift, UnitSession) — this file only ever reads
// a handful of fields off any of them.
//
// Survey fallback ladder for a job with no filed log, verbatim: nothing at
// all -> "No day record."; assigned but nobody punched in -> "Assigned, but
// no crew punched in."; crew worked but nobody filed a log -> an auto
// factual line ("3 crew · 21.5h — 4 units finished"); a log exists -> its
// own headline + day_flow + notes (the caller renders that rich block
// directly from `log`, not through dayMemoryFallbackLine).

import { localDateISO } from "../dailyLogDay";
import { formatHours } from "../estimate";
import type { DayFlow } from "../dailyLogs";

export interface DayMemoryAssignment {
  id: string;
  kind: "install" | "delivery";
  project_id: string | null;
  start_date: string;
  end_date: string;
  status: string;
  members: { profile_id: string }[];
  delivery?: { id: string; label: string | null } | null;
}

export interface DayMemoryShift {
  profile_id: string;
  project_id: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  /** Voided shifts pass through uncounted — same idiom dailyLogDraft.ts
   * uses (CONTEXT.md's Void: the row is never erased, so callers filter). */
  status: string;
}

export interface DayMemorySession {
  project_id: string;
  opening_id: string;
  started_at: string;
  end_reason: string | null;
}

export interface DayMemoryLogRow {
  project_id: string;
  log_date: string;
  headline: string | null;
  notes: string;
  day_flow: DayFlow | null;
}

export interface DayMemoryProfile {
  id: string;
  display_name: string;
}

export interface DayMemoryProject {
  id: string;
  job_code: string;
  name: string;
}

export interface DayMemoryWorked {
  profileId: string;
  name: string;
  /** Decimal hours worked on this job, this local day (1 decimal place). */
  hours: number;
}

export interface DayMemoryLog {
  headline: string | null;
  day_flow: DayFlow | null;
  notes: string;
}

export interface DayMemoryJobEntry {
  projectId: string;
  jobCode: string;
  jobName: string;
  /** Names on any (non-canceled) assignment covering this day — the
   * planned side of the honest diff. */
  assigned: string[];
  /** Names (with hours) who actually clocked shift time on this job, this
   * local day — the showed-up side of the honest diff. */
  worked: DayMemoryWorked[];
  /** Distinct units (openings) finished on this job, this local day. */
  unitsFinished: number;
  /** The filed daily log for this job-day, or null if nobody has. */
  log: DayMemoryLog | null;
}

export interface DayMemoryDelivery {
  assignmentId: string;
  label: string;
  memberNames: string[];
}

export interface DayMemory {
  date: string;
  jobs: DayMemoryJobEntry[];
  deliveries: DayMemoryDelivery[];
}

export interface DayMemoryInput {
  assignments: DayMemoryAssignment[];
  shifts: DayMemoryShift[];
  sessions: DayMemorySession[];
  logs: DayMemoryLogRow[];
  profiles: DayMemoryProfile[];
  projects: DayMemoryProject[];
  /** Anchor for a still-open shift's elapsed time. Defaults to the real
   * clock; tests pass a fixed instant for determinism (dailyLogDraft.ts's
   * same `now` idiom). */
  now?: Date;
}

/** Local midnight for `date`, parsed with no `Z` suffix — dailyLogs.ts's
 * localDayBounds convention, so this window means the same thing the
 * daily-log draft's own day bounds do. */
function localDayBounds(date: string): { start: number; end: number } {
  const start = new Date(`${date}T00:00:00`).getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

/** Minutes of `shift` that fall inside `date`'s local day, clipped at both
 * ends — a shift spanning midnight (a forgotten clock-out, a real overnight)
 * contributes only the part that actually happened that day, on every day
 * it touches, never the whole span dumped onto one of them. The break is
 * charged only to the day the shift clocked in on, so it is never double-
 * subtracted across a multi-day overlap and never taken from a day the
 * shift didn't start on. */
function shiftMinutesOnDay(shift: DayMemoryShift, date: string, now: number): number {
  const { start: dayStart, end: dayEnd } = localDayBounds(date);
  const shiftStart = Date.parse(shift.clock_in_at);
  if (Number.isNaN(shiftStart)) return 0;
  const shiftEnd = shift.clock_out_at ? Date.parse(shift.clock_out_at) : now;
  const overlapStart = Math.max(shiftStart, dayStart);
  const overlapEnd = Math.min(shiftEnd, dayEnd);
  if (overlapEnd <= overlapStart) return 0;
  const breakMinutes =
    localDateISO(new Date(shiftStart)) === date
      ? Math.round((shift.break_seconds ?? 0) / 60)
      : 0;
  return Math.max(0, Math.round((overlapEnd - overlapStart) / 60000) - breakMinutes);
}

/** "3 crew · 21.5h" — dailyLogDraft.ts's own crewLine shape, so the two
 * surfaces that both summarize a day's shift time never drift apart. */
function crewHoursLine(worked: readonly DayMemoryWorked[]): string {
  const totalMinutes = worked.reduce((sum, w) => sum + Math.round(w.hours * 60), 0);
  return `${worked.length} crew · ${formatHours(totalMinutes)}`;
}

/**
 * The fallback tiers, verbatim from the survey, for a job entry with no
 * filed log (the caller checks `entry.log` first and renders its rich
 * block instead — this is only the no-log ladder).
 */
export function dayMemoryFallbackLine(
  entry: Pick<DayMemoryJobEntry, "assigned" | "worked" | "unitsFinished">,
): string {
  if (entry.worked.length > 0) {
    const unitWord = entry.unitsFinished === 1 ? "unit" : "units";
    return `${crewHoursLine(entry.worked)} — ${entry.unitsFinished} ${unitWord} finished`;
  }
  if (entry.assigned.length > 0) return "Assigned, but no crew punched in.";
  return "No day record.";
}

/** One day's worth of assigned-vs-worked-vs-logged, across every job that
 * touched it — the day panel's one data source (C3). */
export function buildDayMemory(date: string, input: DayMemoryInput): DayMemory {
  const now = (input.now ?? new Date()).getTime();
  const nameById = new Map(input.profiles.map((p) => [p.id, p.display_name]));
  const projectById = new Map(input.projects.map((p) => [p.id, p]));

  // ---- assigned (per job) + deliveries, from assignments spanning `date` ----
  const assignedByJob = new Map<string, Set<string>>();
  const deliveries: DayMemoryDelivery[] = [];
  for (const a of input.assignments) {
    if (a.status === "canceled") continue;
    if (a.start_date > date || a.end_date < date) continue;
    if (a.kind === "delivery") {
      deliveries.push({
        assignmentId: a.id,
        label: a.delivery?.label ?? "Delivery",
        memberNames: a.members.map((m) => nameById.get(m.profile_id) ?? "Crew"),
      });
      continue;
    }
    if (!a.project_id) continue;
    const set = assignedByJob.get(a.project_id) ?? new Set<string>();
    for (const m of a.members) set.add(m.profile_id);
    assignedByJob.set(a.project_id, set);
  }

  // ---- worked (per job, per person), from shifts overlapping `date` ----
  const workedByJob = new Map<string, Map<string, number>>();
  for (const s of input.shifts) {
    if (s.status === "voided" || !s.project_id) continue;
    const minutes = shiftMinutesOnDay(s, date, now);
    if (minutes <= 0) continue;
    const perPerson = workedByJob.get(s.project_id) ?? new Map<string, number>();
    perPerson.set(s.profile_id, (perPerson.get(s.profile_id) ?? 0) + minutes);
    workedByJob.set(s.project_id, perPerson);
  }

  // ---- unitsFinished (per job): distinct openings finished this day ----
  const finishedByJob = new Map<string, Set<string>>();
  for (const sess of input.sessions) {
    if (sess.end_reason !== "finish") continue;
    if (localDateISO(new Date(sess.started_at)) !== date) continue;
    const set = finishedByJob.get(sess.project_id) ?? new Set<string>();
    set.add(sess.opening_id);
    finishedByJob.set(sess.project_id, set);
  }

  // ---- logs (per job) for this exact date ----
  // `input.logs` is typically a whole visible month, fetched once and
  // reused for every day in it (one query beats one per cell) — so this
  // filters by log_date itself rather than trusting the caller to have
  // pre-scoped it, the same discipline the assignments/shifts/sessions
  // loops above already apply.
  const logByJob = new Map<string, DayMemoryLogRow>();
  for (const log of input.logs) {
    if (log.log_date !== date) continue;
    logByJob.set(log.project_id, log);
  }

  // ---- assemble one entry per job touched by any of the four sources ----
  const jobIds = new Set<string>([
    ...assignedByJob.keys(),
    ...workedByJob.keys(),
    ...finishedByJob.keys(),
    ...logByJob.keys(),
  ]);

  const jobs: DayMemoryJobEntry[] = [...jobIds]
    .map((projectId) => {
      const project = projectById.get(projectId);
      const assignedIds = assignedByJob.get(projectId) ?? new Set<string>();
      const workedMinutes = workedByJob.get(projectId) ?? new Map<string, number>();
      const log = logByJob.get(projectId) ?? null;
      const worked: DayMemoryWorked[] = [...workedMinutes.entries()]
        .map(([profileId, minutes]) => ({
          profileId,
          name: nameById.get(profileId) ?? "Crew",
          hours: Math.round((minutes / 60) * 10) / 10,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        projectId,
        jobCode: project?.job_code ?? "Job",
        jobName: project?.name ?? "",
        assigned: [...assignedIds]
          .map((id) => nameById.get(id) ?? "Crew")
          .sort((a, b) => a.localeCompare(b)),
        worked,
        unitsFinished: (finishedByJob.get(projectId) ?? new Set()).size,
        log: log ? { headline: log.headline, day_flow: log.day_flow, notes: log.notes } : null,
      };
    })
    .sort((a, b) => a.jobCode.localeCompare(b.jobCode, undefined, { numeric: true }));

  return { date, jobs, deliveries };
}
