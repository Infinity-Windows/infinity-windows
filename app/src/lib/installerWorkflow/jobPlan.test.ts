import { describe, expect, it } from "vitest";
import { mergeDroppedAssignment, planDayEnd, type PlanBlock } from "./jobPlan";

const assignment: PlanBlock = {
  id: "moved", kind: "unit", activity: "Flashing", start: "2026-11-04", end: "2026-11-04",
  startMinute: 540, endMinute: 660, installerIds: ["eli"], openingIds: ["1-1"],
};

describe("mergeDroppedAssignment", () => {
  it("joins closing to next-day opening but leaves unscheduled work hours visible", () => {
    const closing = { ...assignment, endMinute: 1140 };
    const nextDay = { ...assignment, id: "next-day", start: "2026-11-05", end: "2026-11-05", startMinute: 420 };
    expect(mergeDroppedAssignment([nextDay], closing).merged.end).toBe(nextDay.end);
    const standard = mergeDroppedAssignment([nextDay], { ...closing, endMinute: 960 }).merged;
    expect(standard.end).toBe(nextDay.end);
    expect(planDayEnd(standard, closing.start)).toBe(960);
    expect(mergeDroppedAssignment([nextDay], { ...closing, endMinute: 945 }).absorbed.has(nextDay.id)).toBe(false);
  });

  it("unions overlapping times and openings without absorbing another installer", () => {
    const sameCrew = { ...assignment, id: "existing", startMinute: 600, endMinute: 720, openingIds: ["1-2"] };
    const otherCrew = { ...sameCrew, id: "other", installerIds: ["maya"] };
    const { merged, absorbed } = mergeDroppedAssignment([sameCrew, otherCrew], assignment);
    expect(merged).toMatchObject({ id: "moved", startMinute: 540, endMinute: 720, openingIds: ["1-1", "1-2"] });
    expect([...absorbed]).toEqual(["moved", "existing"]);
  });

  it("leaves a gap intact and preserves whole-job scope when touching", () => {
    const touching = { ...assignment, id: "touching", startMinute: 660, endMinute: 720, openingIds: [] };
    const later = { ...assignment, id: "later", startMinute: 735, endMinute: 780 };
    const { merged, absorbed } = mergeDroppedAssignment([later, touching], assignment);
    expect(merged).toMatchObject({ endMinute: 720, openingIds: [] });
    expect(absorbed.has("later")).toBe(false);
  });
});
