import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  clampISO,
  daysBetween,
  enumerateDays,
  endOfMonthISO,
  formatStartTime,
  isISODate,
  monthGridRange,
  rangeLengthDays,
  rangesOverlap,
  startOfMonthISO,
  startOfWeekISO,
  weekdayISO,
} from "./dates";

describe("date primitives", () => {
  it("validates ISO date strings", () => {
    expect(isISODate("2026-07-21")).toBe(true);
    expect(isISODate("2026-7-1")).toBe(false);
    expect(isISODate("nope")).toBe(false);
    expect(isISODate(20260721)).toBe(false);
  });

  it("adds and subtracts days across month/year boundaries", () => {
    expect(addDaysISO("2026-07-21", 1)).toBe("2026-07-22");
    expect(addDaysISO("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts days between (signed) and inclusive range length", () => {
    expect(daysBetween("2026-07-21", "2026-07-24")).toBe(3);
    expect(daysBetween("2026-07-24", "2026-07-21")).toBe(-3);
    expect(rangeLengthDays("2026-07-21", "2026-07-21")).toBe(1);
    expect(rangeLengthDays("2026-07-21", "2026-07-24")).toBe(4);
  });

  it("enumerates inclusive day spans", () => {
    expect(enumerateDays("2026-07-21", "2026-07-23")).toEqual([
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
    ]);
    expect(enumerateDays("2026-07-21", "2026-07-21")).toEqual(["2026-07-21"]);
    expect(enumerateDays("2026-07-23", "2026-07-21")).toEqual([]);
  });

  it("clamps into a range", () => {
    expect(clampISO("2026-07-10", "2026-07-15", "2026-07-20")).toBe("2026-07-15");
    expect(clampISO("2026-07-25", "2026-07-15", "2026-07-20")).toBe("2026-07-20");
    expect(clampISO("2026-07-17", "2026-07-15", "2026-07-20")).toBe("2026-07-17");
  });
});

describe("week/month helpers", () => {
  it("finds the Monday start of a week", () => {
    // 2026-07-21 is a Tuesday.
    expect(weekdayISO("2026-07-21")).toBe(2);
    expect(startOfWeekISO("2026-07-21")).toBe("2026-07-20");
    // A Monday is its own week start.
    expect(startOfWeekISO("2026-07-20")).toBe("2026-07-20");
    // Sunday rolls back to the prior Monday.
    expect(startOfWeekISO("2026-07-19")).toBe("2026-07-13");
  });

  it("computes month bounds and the 42-day grid", () => {
    expect(startOfMonthISO("2026-07-21")).toBe("2026-07-01");
    expect(endOfMonthISO("2026-07-21")).toBe("2026-07-31");
    expect(endOfMonthISO("2026-02-10")).toBe("2026-02-28");
    const grid = monthGridRange("2026-07-15");
    // July 1 2026 is a Wednesday → grid starts Monday June 29.
    expect(grid.from).toBe("2026-06-29");
    expect(daysBetween(grid.from, grid.to)).toBe(41);
  });
});

describe("range overlap", () => {
  it("is inclusive and symmetric", () => {
    expect(rangesOverlap("2026-07-01", "2026-07-05", "2026-07-05", "2026-07-10")).toBe(true);
    expect(rangesOverlap("2026-07-01", "2026-07-04", "2026-07-05", "2026-07-10")).toBe(false);
    expect(rangesOverlap("2026-07-05", "2026-07-10", "2026-07-01", "2026-07-05")).toBe(true);
  });
});

describe("formatStartTime", () => {
  it("formats a clock string and passes through empties", () => {
    expect(formatStartTime("08:30")).toMatch(/8:30/);
    expect(formatStartTime("08:30:00")).toMatch(/8:30/);
    expect(formatStartTime(null)).toBeNull();
    expect(formatStartTime("")).toBeNull();
  });
});
