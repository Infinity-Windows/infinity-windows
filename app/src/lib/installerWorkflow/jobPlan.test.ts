import { describe, expect, it } from "vitest";
import { currentPlanBlocks, coversPlanSlot, planBoundary, planDayEnd, type PlanBlock } from "./jobPlan";

const assignment: PlanBlock = {
  id: "moved", kind: "unit", activity: "Flashing", start: "2026-11-04", end: "2026-11-04",
  startMinute: 540, endMinute: 660, installerIds: ["eli"], openingIds: ["1-1"],
};

describe("plan timing", () => {
  it("keeps legacy AM and PM boundaries readable", () => {
    const legacy = { ...assignment, startMinute: undefined, endMinute: undefined, startPeriod: "PM" as const };
    expect(planBoundary(legacy, "start")).toBe(720);
    expect(coversPlanSlot(legacy, legacy.start, "AM")).toBe(false);
    expect(coversPlanSlot(legacy, legacy.start, "PM")).toBe(true);
  });

  it("uses the daily cutoff before the final day", () => {
    const multiDay = { ...assignment, dailyEndMinute: 960, end: "2026-11-05" };
    expect(planDayEnd(multiDay, multiDay.start)).toBe(960);
    expect(planDayEnd(multiDay, multiDay.end)).toBe(660);
    expect(coversPlanSlot(multiDay, multiDay.end, "PM")).toBe(false);
  });
});

describe("unfinished scheduled activities", () => {
  const overdue = { ...assignment, startMinute: 780, endMinute: 1020, openingIds: ["done", "open"] };
  const day = "2026-11-06";
  const unfinished = (id: string, stage: string) => id !== "done" || stage !== "Flashing";

  it("moves only unfinished unit activities to the day, at their planned hours, while retaining completed references", () => {
    const general = { ...overdue, kind: "general" as const, id: "general" };
    const empty = { ...overdue, id: "empty", openingIds: [] };
    expect(currentPlanBlocks([overdue, general, empty], day, unfinished, true)).toEqual([
      { ...overdue, start: day, end: day }, general, empty,
    ]);
    expect(currentPlanBlocks([overdue], day, unfinished)[0].openingIds).toEqual(["open"]);
    expect(currentPlanBlocks([overdue], day, () => false)).toEqual([overdue]);
    expect(overdue.start).toBe("2026-11-04");
  });

  it("suppresses duplicates after rescheduling or removing a unit/activity", () => {
    const future = { ...overdue, id: "new", start: "2026-11-07", end: "2026-11-07", openingIds: ["open"] };
    expect(currentPlanBlocks([overdue, future], day, unfinished)).toEqual([overdue, future]);
    expect(currentPlanBlocks([future], day, unfinished)).toEqual([future]);
    const sealing = { ...future, activity: "Sealing" };
    expect(currentPlanBlocks([overdue, sealing], day, unfinished)[0].openingIds).toEqual(["open"]);
  });
});
