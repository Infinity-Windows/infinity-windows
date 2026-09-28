// "Your unit" on Work (crew redesign K1.2 + K1.4, 2026-09-23): what the third
// card on the screen shows, decided once, in one place, from the records.
//
// The order the spec settled (Q2, Q4): the unit already RUNNING; else
// yesterday's UNFINISHED unit; else one ASSIGNED to you; else one AVAILABLE on
// today's job; else a blank "New unit" — and only then, so a person never
// types a unit that already exists (the duplicate check lives beside the
// blank form, lib/customWork/matchUnits.ts).
//
// Two kinds of unit meet here and are deliberately not merged: a plan
// OPENING (a job with a plan map — its timer and gates live on the unit
// sheet) and a saved custom-work UNIT (any other job — its timer is a
// custom_work_sessions row). The card says which it is only by where its
// Start button goes.
//
// Pure: no React, no Supabase. The screen hands over what it already loaded.

import { isInstallInProgress, isStaleStart } from "../install/installTimer";
import { applySessionBlocks, toDispatchOpening } from "../install/nextOpening";
import { nextForInstaller } from "../dispatch";
import type { ProjectOpening } from "../install/types";
import type { WorkSession, WorkUnit } from "../customWork/model";

export type NextReason = "yesterday" | "assigned" | "available";

export type NextUp =
  | { kind: "running"; source: "unit"; unit: WorkUnit; session: WorkSession }
  | { kind: "running"; source: "opening"; opening: ProjectOpening }
  | { kind: "next"; source: "unit"; unit: WorkUnit; reason: NextReason }
  | { kind: "next"; source: "opening"; opening: ProjectOpening; reason: NextReason }
  | { kind: "new" };

export interface NextUpInput {
  userId: string;
  now: number;
  /** The job in play: the open shift's, else today's scheduled job, else null. */
  jobId: string | null;
  /** Openings assigned to this person, every job (listMyOpeningsAllJobs). */
  myOpenings: readonly ProjectOpening[];
  /** Every opening on `jobId`, for "available" (listOpenings); [] when unknown. */
  jobOpenings: readonly ProjectOpening[];
  /** Openings whose newest session ended in a Block — never recommended. */
  blockedIds: ReadonlySet<string>;
  /** Saved custom-work units this person can see. */
  units: readonly WorkUnit[];
  /** Custom-work sessions this person can see (own, plus the job's). */
  sessions: readonly WorkSession[];
  /** This person's running custom-work session, if any. */
  active: WorkSession | null;
}

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const notInstalled = (o: ProjectOpening) => o.status !== "installed";

/** Prefer the job in play, then the rest — stable within each half. */
function jobFirst<T extends { project_id: string | null }>(rows: readonly T[], jobId: string | null): T[] {
  if (!jobId) return [...rows];
  return [...rows.filter((r) => r.project_id === jobId), ...rows.filter((r) => r.project_id !== jobId)];
}

/** The dispatch ordering (ready first, lead sequence, area, code), blocks applied. */
function orderOpenings(rows: readonly ProjectOpening[], blockedIds: ReadonlySet<string>): ProjectOpening[] {
  const byId = new Map(rows.map((o) => [o.id, o]));
  const ordered = [...applySessionBlocks(rows.map(toDispatchOpening), blockedIds)]
    .filter((d) => !d.blocked)
    .sort((a, b) => {
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
      const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      if (a.area !== b.area) return a.area.localeCompare(b.area);
      return a.opening_code.localeCompare(b.opening_code);
    });
  return ordered.map((d) => byId.get(d.id)!).filter(Boolean);
}

export function chooseNextUp(i: NextUpInput): NextUp {
  const midnight = localMidnight(i.now);
  const finished = (u: WorkUnit) => u.facts.installation_complete === "Yes";
  const runningOn = (unitId: string) => i.sessions.some((s) => s.unit_id === unitId && !s.ended_at);

  // 1. Running.
  if (i.active && i.active.unit_id) {
    const unit = i.units.find((u) => u.id === i.active!.unit_id);
    if (unit) return { kind: "running", source: "unit", unit, session: i.active };
  }
  const runningOpening = jobFirst(i.myOpenings.filter(notInstalled), i.jobId).find((o) =>
    isInstallInProgress(o, i.now),
  );
  if (runningOpening) return { kind: "running", source: "opening", opening: runningOpening };

  // 2. Yesterday's unfinished: started on an earlier day, never finished.
  const staleOpening = orderOpenings(
    jobFirst(
      i.myOpenings.filter(
        (o) =>
          notInstalled(o) &&
          o.work_started_at != null &&
          isStaleStart(o.work_started_at, i.now) &&
          new Date(o.work_started_at).getTime() < midnight,
      ),
      i.jobId,
    ),
    i.blockedIds,
  )[0];
  if (staleOpening) return { kind: "next", source: "opening", opening: staleOpening, reason: "yesterday" };

  const mineEarlier = i.sessions.filter(
    (s) => s.profile_id === i.userId && s.unit_id && s.ended_at && new Date(s.ended_at).getTime() < midnight,
  );
  const yesterdayUnit = jobFirst(
    i.units.filter(
      (u) =>
        !finished(u) &&
        !runningOn(u.id) &&
        mineEarlier.some((s) => s.unit_id === u.id) &&
        // Not touched again today by me — that would make it today's, and
        // today's unfinished unit is still "next" below, just not "yesterday's".
        !i.sessions.some(
          (s) => s.profile_id === i.userId && s.unit_id === u.id && new Date(s.started_at).getTime() >= midnight,
        ),
    ),
    i.jobId,
  ).sort((a, b) => {
    const last = (u: WorkUnit) =>
      Math.max(...mineEarlier.filter((s) => s.unit_id === u.id).map((s) => new Date(s.ended_at!).getTime()));
    return last(b) - last(a);
  })[0];
  if (yesterdayUnit) return { kind: "next", source: "unit", unit: yesterdayUnit, reason: "yesterday" };

  // 3. Assigned to me — the job in play first, else anywhere.
  const assignedPool = i.myOpenings.filter((o) => notInstalled(o) && o.work_started_at == null);
  const onJob = i.jobId ? assignedPool.filter((o) => o.project_id === i.jobId) : [];
  const assigned = orderOpenings(onJob, i.blockedIds)[0] ?? orderOpenings(assignedPool, i.blockedIds)[0];
  if (assigned) return { kind: "next", source: "opening", opening: assigned, reason: "assigned" };

  // 4. Available on this job: an unassigned, unstarted opening, or a saved
  //    unit nobody is on.
  if (i.jobId) {
    const free = i.jobOpenings.filter(
      (o) => o.project_id === i.jobId && notInstalled(o) && !o.assigned_to && o.work_started_at == null,
    );
    const available = nextForInstaller(applySessionBlocks(free.map(toDispatchOpening), i.blockedIds));
    const opening = available ? free.find((o) => o.id === available.id) : undefined;
    if (opening) return { kind: "next", source: "opening", opening, reason: "available" };

    const unit = i.units
      .filter((u) => u.project_id === i.jobId && !finished(u) && !runningOn(u.id))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))[0];
    if (unit) return { kind: "next", source: "unit", unit, reason: "available" };
  }

  // 5. Nothing matched: the blank form, with its duplicate check.
  return { kind: "new" };
}
