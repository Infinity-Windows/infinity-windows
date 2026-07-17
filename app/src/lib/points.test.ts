import { describe, expect, it } from "vitest";
import { computeInstallPoints, POINT_RULES, sumPoints } from "./points";

describe("computeInstallPoints", () => {
  it("awards base only for a bare install", () => {
    const e = computeInstallPoints({ minutes: null, parMinutes: null, grade: null, hasPhotos: false, hasMemo: false });
    expect(sumPoints(e)).toBe(POINT_RULES.installBase);
  });

  it("adds par bonus when at or under par", () => {
    const e = computeInstallPoints({ minutes: 40, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false });
    expect(e.some((x) => x.kind === "par")).toBe(true);
  });

  it("no par bonus when over par", () => {
    const e = computeInstallPoints({ minutes: 60, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false });
    expect(e.some((x) => x.kind === "par")).toBe(false);
  });

  it("stacks photos, teach, quality", () => {
    const e = computeInstallPoints({ minutes: 30, parMinutes: 45, grade: 5, hasPhotos: true, hasMemo: true });
    expect(sumPoints(e)).toBe(
      POINT_RULES.installBase + POINT_RULES.parBeat + POINT_RULES.photos + POINT_RULES.teach + POINT_RULES.quality,
    );
  });
});
