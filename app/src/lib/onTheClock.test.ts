import { describe, expect, it } from "vitest";
import { isOnTheClock, shiftHours, type TimeShift } from "./timeclock";

function shift(over: Partial<TimeShift>): TimeShift {
  return {
    id: "s",
    profile_id: "p",
    project_id: null,
    cost_code_id: null,
    clock_in_at: "2026-07-18T20:31:26.394254+00:00",
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: "2026-07-18T20:31:26.394254+00:00",
    ...over,
  };
}

describe("isOnTheClock", () => {
  it("is true only for a shift that is genuinely running", () => {
    expect(isOnTheClock(shift({ status: "open" }))).toBe(true);
  });

  it("is false for a shift awaiting a finish time", () => {
    // This is the important one: a shift the app stopped counting means the
    // person went home. Treating it as "on the clock" would let them start
    // installing windows against a shift that ended days ago.
    expect(isOnTheClock(shift({ status: "needs_finish" }))).toBe(false);
  });

  it("is false for finished, submitted and missing shifts", () => {
    expect(isOnTheClock(shift({ status: "submitted" }))).toBe(false);
    expect(isOnTheClock(shift({ status: "approved" }))).toBe(false);
    expect(isOnTheClock(null)).toBe(false);
    expect(isOnTheClock(undefined)).toBe(false);
  });
});

describe("shiftHours on an unfinished shift", () => {
  it("contributes nothing to any total until a finish time exists", () => {
    // Why the 286-hour shift never reached payroll: no clock_out_at, no hours.
    expect(shiftHours(shift({ status: "open" }))).toBe(0);
    expect(shiftHours(shift({ status: "needs_finish" }))).toBe(0);
  });

  it("counts the hours once a real finish time is recorded", () => {
    const done = shift({
      clock_out_at: "2026-07-19T04:31:26.394254+00:00",
      status: "submitted",
      break_seconds: 1800,
    });
    expect(shiftHours(done)).toBeCloseTo(7.5, 6);
  });
});
