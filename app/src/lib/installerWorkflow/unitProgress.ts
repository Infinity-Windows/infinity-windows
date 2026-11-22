import type { WorkSession } from "../customWork/model";
import { BUILDING_3_PROJECT, PLAN_NOON, PLAN_OPEN, type PlanBlock } from "./jobPlan";

export const building3ProgressBlocks: PlanBlock[] = [
  {
    id: "progress-preview-ro", kind: "unit", activity: "RO checked", start: "2026-11-09", end: "2026-11-09",
    startMinute: PLAN_OPEN, endMinute: PLAN_NOON, installerIds: ["mock-maya", "mock-eli"],
    openingIds: ["16be3aae-2a23-4695-9b5f-34505d72b1b5", "5dd09f6e-8b59-4c35-882f-b3fa953fa764", "dd6fb173-dd1f-4556-a18f-546a638eae17"],
  },
  {
    id: "progress-preview-frame", kind: "unit", activity: "Setting frame", start: "2026-11-11", end: "2026-11-11",
    startMinute: PLAN_OPEN, endMinute: PLAN_NOON, installerIds: ["mock-maya", "mock-eli"],
    openingIds: ["16be3aae-2a23-4695-9b5f-34505d72b1b5", "5dd09f6e-8b59-4c35-882f-b3fa953fa764",
      "dd6fb173-dd1f-4556-a18f-546a638eae17", "9b2645d9-346a-42d5-b0e3-fce6db272703",
      "0b77a63b-458c-4d12-bc46-c9db31a01280", "fd98fcca-a268-4fc1-aacd-d153ee2b47e5",
      "d80c6d84-393e-434a-8f4f-13bc87c408c9"],
  },
];

export type ActivityDoneMark = { opening_id: string; activity: string; done_at: string };

/** The latest word on each activity of each unit: finished, or sent back for rework. */
function latestActivityMarks(sessions: readonly WorkSession[],
  marks: readonly ActivityDoneMark[] = [], openingByUnit?: ReadonlyMap<string, string>) {
  const latest = new Map<string, { at: number; done: boolean }>();
  const record = (id: string, activity: string, at: string, done: boolean) => {
    const key = JSON.stringify([id, activity]);
    const time = Date.parse(at);
    const previous = latest.get(key);
    if (!previous || previous.at < time || (previous.at === time && !done)) latest.set(key, { at: time, done });
  };
  for (const session of sessions) {
    const at = session.ended_at ?? session.workday_done_at;
    if (!session.unit_id || !at || (!session.workday_done_at && session.outcome !== "finished" && session.outcome !== "rework")) continue;
    record(openingByUnit?.get(session.unit_id) ?? session.unit_id, session.stage, at,
      session.outcome !== "rework");
  }
  for (const mark of marks) record(mark.opening_id, mark.activity, mark.done_at, true);
  return latest;
}

export function finishedUnitActivities(sessions: readonly WorkSession[],
  marks: readonly ActivityDoneMark[] = [], openingByUnit?: ReadonlyMap<string, string>) {
  const latest = latestActivityMarks(sessions, marks, openingByUnit);
  return (id: string | undefined, activity: string) =>
    !!id && latest.get(JSON.stringify([id, activity]))?.done === true;
}

export type LastFinishedActivity = { activity: string; at: string };

/** The activity most recently finished on each unit and still standing: one
 * later sent back for rework no longer counts as finished. */
export function lastFinishedUnitActivity(sessions: readonly WorkSession[],
  marks: readonly ActivityDoneMark[] = [], openingByUnit?: ReadonlyMap<string, string>) {
  const last = new Map<string, { activity: string; at: number }>();
  for (const [key, value] of latestActivityMarks(sessions, marks, openingByUnit)) {
    if (!value.done) continue;
    const [id, activity] = JSON.parse(key) as [string, string];
    if ((last.get(id)?.at ?? -Infinity) < value.at) last.set(id, { activity, at: value.at });
  }
  return (id: string | undefined): LastFinishedActivity | undefined => {
    const found = id ? last.get(id) : undefined;
    return found && { activity: found.activity, at: new Date(found.at).toISOString() };
  };
}

export function building3PreviewDone(project: string, activity: string, openingCode: string) {
  if (!import.meta.env.DEV || project !== BUILDING_3_PROJECT) return false;
  if (activity === "RO checked") return ["6-1", "1-1"].includes(openingCode);
  return activity === "Setting frame" && ["6-1", "1-1", "1-2"].includes(openingCode);
}
