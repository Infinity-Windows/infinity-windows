import { describe, expect, it } from "vitest";
import { computeInstallPoints, POINT_RULES, sumPoints } from "./points";

describe("computeInstallPoints", () => {
  it("awards base + par + photos + teach + quality when all conditions met", () => {
    const entries = computeInstallPoints({
      minutes: 40,
      parMinutes: 45,
      grade: 5,
      hasPhotos: true,
      hasMemo: true,
    });
    expect(sumPoints(entries)).toBe(
      POINT_RULES.installBase +
        POINT_RULES.parBeat +
        POINT_RULES.photos +
        POINT_RULES.teach +
        POINT_RULES.quality,
    );
  });

  it("no par bonus when over par, no quality bonus under grade 4", () => {
    const entries = computeInstallPoints({
      minutes: 60,
      parMinutes: 45,
      grade: 3,
      hasPhotos: false,
      hasMemo: false,
    });
    expect(entries.map((e) => e.kind)).toEqual(["install"]);
    expect(sumPoints(entries)).toBe(POINT_RULES.installBase);
  });

  it("par bonus is exactly at par (<=), missing data skips par", () => {
    expect(
      computeInstallPoints({ minutes: 45, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false })
        .some((e) => e.kind === "par"),
    ).toBe(true);
    expect(
      computeInstallPoints({ minutes: null, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false })
        .some((e) => e.kind === "par"),
    ).toBe(false);
  });
});
