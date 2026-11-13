import { describe, expect, it } from "vitest";
import { coversPlanSlot, planBoundary, planDayEnd, type PlanBlock } from "./jobPlan";

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
