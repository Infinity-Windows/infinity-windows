import { isUnitComplete } from "../customWork/complete";
import type { WorkSession, WorkUnit } from "../customWork/model";
import type { OpeningCrew, PlanBlock } from "./jobPlan";
import { finishedUnitActivities, lastFinishedUnitActivity, type ActivityDoneMark } from "./unitProgress";

export type UnitActivityState = "complete" | "running" | "blocked" | "rework" | "in-progress" | "not-started";

/**
 * One reading of a unit's state, for every screen that shows one.
 *
 * A unit is the opening the Unit Builder defined. Its work is recorded
 * against other things: timers against a "work unit" row made the first time
 * someone starts one, done-marks and the Plan's crew against the opening.
 * The Plan, Workday and the unit dialog each bridged those themselves, and
 * came out differently: Workday read "done" two ways, one of them ignoring
 * the Plan's marks, and showed a unit that is complete as a whole as "Not
 * started" where the Plan showed it complete.
 *
 * Everything here is asked by OPENING id (Matt, 2026-11-20: "units should be
 * referenced all the same way... that's where they're getting their status,
 * crew, etc").
 */
export function readUnitState(source: {
  /** Every session known for the job: the server's, and any still on this device. */
  sessions: readonly WorkSession[];
  marks?: readonly ActivityDoneMark[];
  /** The job's work units, which say which opening a session's unit_id is. */
  units?: readonly Pick<WorkUnit, "id" | "opening_id" | "facts">[];
  /** The Plan blocks to read lead and crew from. */
  blocks?: readonly PlanBlock[];
  /** Whole-unit completion decided on this device and not yet on a work unit (the preview). */
  completeOverride?: Readonly<Record<string, boolean>>;
}) {
  const { sessions, marks = [], units = [], blocks = [], completeOverride } = source;
  const openingByUnit = new Map(units.flatMap(unit => unit.opening_id ? [[unit.id, unit.opening_id] as const] : []));
  // A session whose unit is not a known work unit carries the opening id
  // itself: the preview's local timers do.
  const openingOf = (session: Pick<WorkSession, "unit_id">) =>
    session.unit_id ? openingByUnit.get(session.unit_id) ?? session.unit_id : undefined;
  const activityDone = finishedUnitActivities(sessions, marks, openingByUnit);
  const complete = (openingId: string | undefined) => !!openingId &&
    (completeOverride?.[openingId] ?? units.some(unit => unit.opening_id === openingId && isUnitComplete(unit)));

  return {
    openingOf,
    /** The unit is finished as a whole. */
    complete,
    /** This activity was finished on this unit: by a timer, a Workday mark or a Plan mark. */
    activityDone,
    /** The activity finished most recently on this unit, whichever one it was. */
    lastDone: lastFinishedUnitActivity(sessions, marks, openingByUnit),
    /** What to show: an activity on a unit that is complete as a whole reads as done. */
    done: (openingId: string | undefined, activity: string) => complete(openingId) || activityDone(openingId, activity),
    status(openingId: string | undefined, activity: string): UnitActivityState {
      if (complete(openingId) || activityDone(openingId, activity)) return "complete";
      const rows = sessions.filter(session => session.stage === activity && !!session.unit_id && openingOf(session) === openingId);
      if (rows.some(session => !session.ended_at)) return "running";
      const latest = [...rows].sort((a, b) => (b.ended_at ?? b.started_at).localeCompare(a.ended_at ?? a.started_at))[0];
      if (latest?.outcome === "blocked") return "blocked";
      if (latest?.outcome === "rework") return "rework";
      return latest ? "in-progress" : "not-started";
    },
    /** The lead and crew the Plan names for this activity on this unit; the latest block wins. */
    crew(openingId: string, activity: string): OpeningCrew {
      const block = blocks.filter(row => row.kind === "unit" && row.activity === activity && row.openingCrew?.[openingId])
        .sort((a, b) => b.end.localeCompare(a.end) || b.id.localeCompare(a.id))[0];
      const roles = block?.openingCrew?.[openingId];
      return { leadId: roles?.leadId, crewIds: (roles?.crewIds ?? []).filter(id => id !== roles?.leadId) };
    },
  };
}

export type UnitState = ReturnType<typeof readUnitState>;
