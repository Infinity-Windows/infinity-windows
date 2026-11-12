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

export function finishedUnitActivities(sessions: readonly WorkSession[]) {
  const latest = new Map<string, WorkSession>();
  for (const session of sessions) {
    if (!session.unit_id || !session.ended_at || (session.outcome !== "finished" && session.outcome !== "rework")) continue;
    const key = JSON.stringify([session.unit_id, session.stage]);
    if ((latest.get(key)?.ended_at ?? "") <= session.ended_at) latest.set(key, session);
  }
  return (unitId: string | undefined, activity: string) =>
    !!unitId && latest.get(JSON.stringify([unitId, activity]))?.outcome === "finished";
}

export function building3PreviewDone(project: string, activity: string, openingCode: string) {
  if (!import.meta.env.DEV || project !== BUILDING_3_PROJECT) return false;
  if (activity === "RO checked") return ["6-1", "1-1"].includes(openingCode);
  return activity === "Setting frame" && ["6-1", "1-1", "1-2"].includes(openingCode);
}
