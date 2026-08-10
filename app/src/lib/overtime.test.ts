import { describe, expect, it } from "vitest";
import { pickOvertimeRule, splitOvertime, type OvertimeRule } from "./overtime";

const rule = (over: Partial<OvertimeRule>): OvertimeRule => ({
  weeklyThresholdHours: null,
  weeklyOtMultiplier: 1.5,
  dailyThresholdHours: null,
  dailyOtMultiplier: 1.5,
  doubleTimeThresholdHours: null,
  doubleTimeMultiplier: 2,
  ...over,
});

describe("splitOvertime", () => {
  it("no rule means every hour is regular", () => {
    expect(splitOvertime([9, 9, 9, 9, 9], null)).toEqual({
      regular: 45,
      overtime: 0,
      doubleTime: 0,
    });
  });

  it("the seeded company default: over 40h/week is overtime", () => {
    expect(splitOvertime([9, 9, 9, 9, 9], rule({ weeklyThresholdHours: 40 }))).toEqual({
      regular: 40,
      overtime: 5,
      doubleTime: 0,
    });
    expect(splitOvertime([8, 8, 8, 8], rule({ weeklyThresholdHours: 40 }))).toEqual({
      regular: 32,
      overtime: 0,
      doubleTime: 0,
    });
  });

  it("CA-style layering: a 13h day splits 8 regular, 4 OT, 1 double", () => {
    const ca = rule({
      weeklyThresholdHours: 40,
      dailyThresholdHours: 8,
      doubleTimeThresholdHours: 12,
    });
    expect(splitOvertime([13], ca)).toEqual({ regular: 8, overtime: 4, doubleTime: 1 });
  });

  it("daily-OT hours never count again toward the weekly threshold", () => {
    // Five 10h days under daily-8/weekly-40: 2h/day is daily OT, and the
    // remaining 5x8 regular hours sit exactly at 40 - no double counting.
    const ca = rule({ weeklyThresholdHours: 40, dailyThresholdHours: 8 });
    expect(splitOvertime([10, 10, 10, 10, 10], ca)).toEqual({
      regular: 40,
      overtime: 10,
      doubleTime: 0,
    });
  });

  it("a sixth 8h day pushes regular hours over the weekly line", () => {
    const wk = rule({ weeklyThresholdHours: 40 });
    expect(splitOvertime([8, 8, 8, 8, 8, 8], wk)).toEqual({
      regular: 40,
      overtime: 8,
      doubleTime: 0,
    });
  });

  it("negative or zero days contribute nothing", () => {
    expect(splitOvertime([0, -1, 8], rule({ weeklyThresholdHours: 40 }))).toEqual({
      regular: 8,
      overtime: 0,
      doubleTime: 0,
    });
  });
});

describe("pickOvertimeRule", () => {
  const company = { scope: "company", profile_id: null };
  const mine = { scope: "person", profile_id: "p1" };
  it("a person's override beats the company default", () => {
    expect(pickOvertimeRule([company, mine], "p1")).toBe(mine);
    expect(pickOvertimeRule([company, mine], "p2")).toBe(company);
    expect(pickOvertimeRule([], "p1")).toBeNull();
  });
});
