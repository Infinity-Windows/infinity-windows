import { describe, expect, it } from "vitest";
import type { WorkSession, WorkUnit } from "../customWork/model";
import type { PlanBlock } from "./jobPlan";
import { readUnitState } from "./unitState";

const session = (over: Partial<WorkSession>) => ({
  id: crypto.randomUUID(), profile_id: "alex", project_id: "job", unit_id: "unit-a", stage: "Flashing",
  outcome: null, started_at: "2026-11-20T15:00:00Z", ended_at: null, ...over,
}) as WorkSession;
const units = [
  { id: "unit-a", opening_id: "opening-a", facts: {} },
  { id: "unit-b", opening_id: "opening-b", facts: { installation_complete: "Yes" } },
] as unknown as WorkUnit[];

describe("unit state", () => {
  it("is asked by opening, whatever the timer was recorded against", () => {
    const state = readUnitState({ units, sessions: [
      session({ outcome: "finished", ended_at: "2026-11-20T16:00:00Z" }),
      // The preview's timers carry the opening id itself.
      session({ unit_id: "opening-c", stage: "Sealing" }),
    ] });
    expect(state.status("opening-a", "Flashing")).toBe("complete");
    expect(state.status("opening-a", "Sealing")).toBe("not-started");
    expect(state.status("opening-c", "Sealing")).toBe("running");
    expect(state.status("unit-a", "Flashing")).toBe("not-started");
  });

  it("counts a Plan done-mark, a timer and a Workday mark as the same done", () => {
    const state = readUnitState({ units, marks: [{ opening_id: "opening-a", activity: "Sealing", done_at: "2026-11-20T12:00:00Z" }],
      sessions: [session({ stage: "RO checked", workday_done_at: "2026-11-20T13:00:00Z" })] });
    expect(state.activityDone("opening-a", "Sealing")).toBe(true);
    expect(state.activityDone("opening-a", "RO checked")).toBe(true);
    expect(state.activityDone("opening-a", "Flashing")).toBe(false);
  });

  it("shows every activity as done on a unit that is complete as a whole, without recording it as done", () => {
    const state = readUnitState({ units, sessions: [] });
    expect(state.complete("opening-b")).toBe(true);
    expect(state.status("opening-b", "Flashing")).toBe("complete");
    expect(state.done("opening-b", "Flashing")).toBe(true);
    expect(state.activityDone("opening-b", "Flashing")).toBe(false);
    expect(readUnitState({ units, sessions: [], completeOverride: { "opening-a": true } }).complete("opening-a")).toBe(true);
  });

  it("reports blocked and rework from the latest session, and rework undoes done", () => {
    const state = readUnitState({ units, sessions: [
      session({ outcome: "finished", ended_at: "2026-11-19T16:00:00Z" }),
      session({ outcome: "rework", started_at: "2026-11-20T15:00:00Z", ended_at: "2026-11-20T16:00:00Z" }),
      session({ stage: "Sealing", outcome: "blocked", ended_at: "2026-11-20T16:00:00Z" }),
      session({ stage: "Staging", outcome: "partial", ended_at: "2026-11-20T16:00:00Z" }),
    ] });
    expect(state.status("opening-a", "Flashing")).toBe("rework");
    expect(state.status("opening-a", "Sealing")).toBe("blocked");
    expect(state.status("opening-a", "Staging")).toBe("in-progress");
  });

  it("reads lead and crew from the Plan's latest block for that activity", () => {
    const block = (over: Partial<PlanBlock>) => ({ id: "one", kind: "unit", activity: "Flashing", start: "2026-11-18", end: "2026-11-18",
      openingIds: ["opening-a"], installerIds: [], ...over }) as PlanBlock;
    const state = readUnitState({ sessions: [], blocks: [
      block({ openingCrew: { "opening-a": { leadId: "old", crewIds: [] } } }),
      block({ id: "two", end: "2026-11-20", openingCrew: { "opening-a": { leadId: "alex", crewIds: ["alex", "sam"] } } }),
      block({ id: "three", end: "2026-11-21", activity: "Sealing", openingCrew: { "opening-a": { leadId: "sam", crewIds: [] } } }),
    ] });
    expect(state.crew("opening-a", "Flashing")).toEqual({ leadId: "alex", crewIds: ["sam"] });
    expect(state.crew("opening-b", "Flashing")).toEqual({ leadId: undefined, crewIds: [] });
  });
});

describe("the last activity finished on a unit", () => {
  it("is the most recent finish, and a later rework takes that activity back out", () => {
    const marks = [
      { opening_id: "u1", activity: "RO checked", done_at: "2026-11-18T15:00:00.000Z" },
      { opening_id: "u1", activity: "Setting frame", done_at: "2026-11-19T15:00:00.000Z" },
    ];
    expect(readUnitState({ sessions: [], marks }).lastDone("u1"))
      .toEqual({ activity: "Setting frame", at: "2026-11-19T15:00:00.000Z" });
    const rework = { id: "s1", unit_id: "u1", stage: "Setting frame", started_at: "2026-11-20T14:00:00.000Z",
      ended_at: "2026-11-20T15:00:00.000Z", outcome: "rework" } as Parameters<typeof readUnitState>[0]["sessions"][number];
    expect(readUnitState({ sessions: [rework], marks }).lastDone("u1")?.activity).toBe("RO checked");
    expect(readUnitState({ sessions: [], marks }).lastDone("u2")).toBeUndefined();
  });
});
