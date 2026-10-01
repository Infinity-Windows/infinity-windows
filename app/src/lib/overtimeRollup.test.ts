import { describe, expect, it } from "vitest";
import { splitOvertimeByPerson, type OvertimeShiftRow } from "./overtimeRollup";
import type { OvertimeRule } from "./overtime";

const WEEKLY_40: OvertimeRule = {
  weeklyThresholdHours: 40,
  weeklyOtMultiplier: 1.5,
  dailyThresholdHours: null,
  dailyOtMultiplier: 1.5,
  doubleTimeThresholdHours: null,
  doubleTimeMultiplier: 2,
};

const DAILY_8: OvertimeRule = { ...WEEKLY_40, dailyThresholdHours: 8 };

function row(over: Partial<OvertimeShiftRow>): OvertimeShiftRow {
  return {
    profileId: "p1",
    employee: "Ana Ruiz",
    day: "2026-09-07",
    week: "2026-09-07",
    hours: 8,
    ...over,
  };
}

describe("splitOvertimeByPerson", () => {
  it("keeps the two weeks of a pay period as two weekly buckets", () => {
    // 45 hours in each of two weeks: 40 regular + 5 OT, twice — NOT 40 + 50.
    const rows: OvertimeShiftRow[] = [];
    for (const week of ["2026-09-07", "2026-09-14"]) {
      for (let d = 0; d < 5; d += 1) {
        rows.push(row({ week, day: `${week}-${d}`, hours: 9 }));
      }
    }
    expect(splitOvertimeByPerson(rows, () => WEEKLY_40)).toEqual([
      { profileId: "p1", employee: "Ana Ruiz", regular: 80, overtime: 10, doubleTime: 0 },
    ]);
  });

  it("adds up several punches on the same day before the daily rule applies", () => {
    const rows = [
      row({ hours: 5 }),
      row({ hours: 5 }),
    ];
    // 10 hours in one day: 8 regular, 2 daily OT — not two 5-hour days.
    expect(splitOvertimeByPerson(rows, () => DAILY_8)[0]).toMatchObject({
      regular: 8,
      overtime: 2,
    });
  });

  it("gives each person their own rule", () => {
    const rows = [
      row({ profileId: "p1", employee: "Ana Ruiz", hours: 10 }),
      row({ profileId: "p2", employee: "Ben Cole", hours: 10 }),
    ];
    const lines = splitOvertimeByPerson(rows, (id) => (id === "p2" ? DAILY_8 : WEEKLY_40));
    expect(lines).toEqual([
      { profileId: "p1", employee: "Ana Ruiz", regular: 10, overtime: 0, doubleTime: 0 },
      { profileId: "p2", employee: "Ben Cole", regular: 8, overtime: 2, doubleTime: 0 },
    ]);
  });

  it("orders people by name, so two exports diff cleanly", () => {
    const lines = splitOvertimeByPerson(
      [
        row({ profileId: "z", employee: "Zoe" }),
        row({ profileId: "a", employee: "aaron" }),
        row({ profileId: "m", employee: "Mo" }),
      ],
      () => null,
    );
    expect(lines.map((l) => l.employee)).toEqual(["aaron", "Mo", "Zoe"]);
  });

  it("has nothing to say about nobody", () => {
    expect(splitOvertimeByPerson([], () => WEEKLY_40)).toEqual([]);
  });
});


describe("paychecks split across a calendar week", () => {
  const rows = [14, 15, 16, 17, 18].map(day => row({ day: `2026-09-${day}`, week: "2026-09-14", hours: 10 }));
  it("uses earlier-period work toward the threshold without paying it again", () => {
    expect(splitOvertimeByPerson(rows, () => WEEKLY_40, { start: "2026-09-16", end: "2026-10-01" })[0])
      .toMatchObject({ regular: 20, overtime: 10, doubleTime: 0 });
  });
  it("two halves add up to the full week's regular, OT and double time", () => {
    const rule = { ...DAILY_8, doubleTimeThresholdHours: 9, weeklyThresholdHours: 30 };
    const first = splitOvertimeByPerson(rows, () => rule, { start: "2026-09-01", end: "2026-09-16" })[0];
    const second = splitOvertimeByPerson(rows, () => rule, { start: "2026-09-16", end: "2026-10-01" })[0];
    const whole = splitOvertimeByPerson(rows, () => rule)[0];
    for (const key of ["regular", "overtime", "doubleTime"] as const) expect(first[key] + second[key]).toBe(whole[key]);
  });
  it("does not export people whose only work falls outside selected dates", () => {
    expect(splitOvertimeByPerson(rows.slice(0, 2), () => WEEKLY_40, { start: "2026-09-16", end: "2026-10-01" })).toEqual([]);
  });
});
