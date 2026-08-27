import { describe, expect, it } from "vitest";
import {
  SHIFT_CAP_HOURS,
  SHIFT_LONG_HOURS,
  checkFinishTime,
  describeDuration,
  describeFlaggedShift,
  endFromDuration,
  finishTimeBounds,
  flaggedShifts,
  isUnfinished,
  needsFinishTime,
  shiftGuard,
  toLocalInputValue,
} from "./shiftGuard";
import type { TimeShift } from "./timeclock";

const NOW = Date.parse("2026-07-30T19:29:26.000Z");

function shiftAgedHours(hours: number, over: Partial<TimeShift> = {}): TimeShift {
  return {
    id: "s1",
    profile_id: "p1",
    project_id: "j1",
    cost_code_id: "c1",
    clock_in_at: new Date(NOW - hours * 3600_000).toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: new Date(NOW - hours * 3600_000).toISOString(),
    ...over,
  };
}

describe("the thresholds", () => {
  it("keeps counting a long day but refuses to keep counting a runaway", () => {
    expect(SHIFT_LONG_HOURS).toBeLessThan(SHIFT_CAP_HOURS);
  });
});

describe("shiftGuard", () => {
  it("leaves a normal shift alone and unflagged", () => {
    const v = shiftGuard(shiftAgedHours(7), NOW);
    expect(v.state).toBe("running");
    expect(v.workedSeconds).toBe(7 * 3600);
    expect(v.flagged).toBe(false);
  });

  it("flags a longer-than-normal day but still shows the real number", () => {
    const v = shiftGuard(shiftAgedHours(13), NOW);
    expect(v.state).toBe("long");
    expect(v.workedSeconds).toBe(13 * 3600);
    expect(v.flagged).toBe(true);
  });

  it("stops counting past the cap rather than showing a number", () => {
    const v = shiftGuard(shiftAgedHours(SHIFT_CAP_HOURS + 1), NOW);
    expect(v.state).toBe("over-cap");
    expect(v.workedSeconds).toBeNull();
    expect(v.flagged).toBe(true);
  });

  it("reproduces the real 286-hour shift from 18 July as over-cap", () => {
    // The actual production row: punched in 2026-07-18T20:31:26Z, never closed.
    const real = shiftAgedHours(0, {
      clock_in_at: "2026-07-18T20:31:26.394254+00:00",
    });
    const v = shiftGuard(real, NOW);
    expect(v.state).toBe("over-cap");
    expect(v.workedSeconds).toBeNull();
    // 286:57:59 on the screenshot — the wall clock is still reported honestly.
    expect(v.sinceClockInSeconds).toBe(286 * 3600 + 57 * 60 + 59);
    expect(describeFlaggedShift(real, NOW)).toContain("11 days");
  });

  it("never turns an unknown length into zero hours", () => {
    const v = shiftGuard(shiftAgedHours(300), NOW);
    expect(v.workedSeconds).not.toBe(0);
    expect(v.workedSeconds).toBeNull();
  });

  it("subtracts break time before judging the length", () => {
    // 17 hours on site, 2 of them on break, is 15 worked — under the cap.
    const v = shiftGuard(shiftAgedHours(17, { break_seconds: 2 * 3600 }), NOW);
    expect(v.state).toBe("long");
    expect(v.workedSeconds).toBe(15 * 3600);
  });

  it("respects a shift the server already gave up on", () => {
    const v = shiftGuard(shiftAgedHours(400, { status: "needs_finish" }), NOW);
    expect(v.state).toBe("needs-finish");
    expect(v.workedSeconds).toBeNull();
    expect(v.flagged).toBe(true);
  });

  it("does not second-guess a shift somebody already closed", () => {
    // A closed 20-hour shift is a person's recorded answer. Flag it for review,
    // but never blank out a number they stood behind.
    const v = shiftGuard(
      shiftAgedHours(20, {
        clock_out_at: new Date(NOW).toISOString(),
        status: "submitted",
      }),
      NOW,
    );
    expect(v.state).toBe("long");
    expect(v.workedSeconds).toBe(20 * 3600);
    expect(v.flagged).toBe(true);
  });

  it("treats a clock that ran ahead of the server as zero, never negative", () => {
    const v = shiftGuard(shiftAgedHours(-2), NOW);
    expect(v.workedSeconds).toBe(0);
    expect(v.sinceClockInSeconds).toBe(0);
  });
});

describe("needsFinishTime / isUnfinished", () => {
  it("recognises the statuses that still owe a finish time", () => {
    expect(needsFinishTime({ status: "needs_finish" })).toBe(true);
    expect(needsFinishTime({ status: "open" })).toBe(false);
    expect(isUnfinished({ status: "open", clock_out_at: null })).toBe(true);
    expect(isUnfinished({ status: "needs_finish", clock_out_at: null })).toBe(true);
    expect(
      isUnfinished({ status: "submitted", clock_out_at: "2026-07-30T00:00:00Z" }),
    ).toBe(false);
  });
});

describe("flaggedShifts", () => {
  it("returns only the ones worth a foreman's attention, longest first", () => {
    const normal = shiftAgedHours(6, { id: "normal" });
    const long = shiftAgedHours(13, { id: "long" });
    const runaway = shiftAgedHours(200, { id: "runaway" });
    const out = flaggedShifts([normal, long, runaway], NOW);
    expect(out.map((s) => s.id)).toEqual(["runaway", "long"]);
  });
});

describe("describeDuration", () => {
  it("says it in words a non-technical reader can act on", () => {
    expect(describeDuration(45 * 60)).toBe("45 minutes");
    expect(describeDuration(3 * 3600)).toBe("3 hours");
    expect(describeDuration(3 * 3600 + 20 * 60)).toBe("3 hours 20 minutes");
    expect(describeDuration(86400)).toBe("1 day");
    expect(describeDuration(86400 + 2 * 3600)).toBe("1 day 2 hours");
    expect(describeDuration(286 * 3600 + 57 * 60 + 59)).toBe("11 days 22 hours");
  });

  it("never reports a negative age", () => {
    expect(describeDuration(-500)).toBe("0 minutes");
  });
});

describe("checkFinishTime", () => {
  const shift = shiftAgedHours(20);

  it("refuses nothing at all", () => {
    expect(checkFinishTime(shift, null, NOW).ok).toBe(false);
  });

  it("refuses unreadable input", () => {
    expect(checkFinishTime(shift, "not a time", NOW).ok).toBe(false);
  });

  it("refuses a finish before the start", () => {
    const before = new Date(Date.parse(shift.clock_in_at) - 60_000).toISOString();
    const res = checkFinishTime(shift, before, NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/after you clocked in/i);
  });

  it("refuses a finish in the future, which would invent hours", () => {
    const future = new Date(NOW + 60 * 60_000).toISOString();
    const res = checkFinishTime(shift, future, NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/future/i);
  });

  it("tolerates a phone clock a minute fast", () => {
    expect(checkFinishTime(shift, new Date(NOW + 60_000).toISOString(), NOW).ok).toBe(
      true,
    );
  });

  it("accepts a plausible finish and returns the hours it implies", () => {
    const finish = new Date(Date.parse(shift.clock_in_at) + 8 * 3600_000).toISOString();
    const res = checkFinishTime(shift, finish, NOW);
    expect(res.ok).toBe(true);
    expect(res.hours).toBeCloseTo(8, 6);
  });

  it("takes recorded breaks off the hours it reports", () => {
    const withBreak = shiftAgedHours(20, { break_seconds: 30 * 60 });
    const finish = new Date(
      Date.parse(withBreak.clock_in_at) + 8 * 3600_000,
    ).toISOString();
    expect(checkFinishTime(withBreak, finish, NOW).hours).toBeCloseTo(7.5, 6);
  });

  it("accepts a long but genuine answer rather than pushing someone to lie", () => {
    const finish = new Date(
      Date.parse(shift.clock_in_at) + 19 * 3600_000,
    ).toISOString();
    const res = checkFinishTime(shift, finish, NOW);
    expect(res.ok).toBe(true);
    expect(res.hours).toBeCloseTo(19, 6);
  });
});

describe("finishTimeBounds", () => {
  it("pins the picker between the punch and now", () => {
    const shift = shiftAgedHours(20);
    const b = finishTimeBounds(shift, NOW);
    expect(b.min).toBe(toLocalInputValue(shift.clock_in_at));
    expect(b.max).toBe(toLocalInputValue(NOW));
  });
});

describe("endFromDuration (T2 edit-sheet duration mode)", () => {
  const clockIn = "2026-08-20T07:00:00.000Z";

  it("adds the worked hours to the clock-in instant", () => {
    expect(endFromDuration(clockIn, 8)).toBe("2026-08-20T15:00:00.000Z");
  });

  it("handles fractional hours down to the minute", () => {
    expect(endFromDuration(clockIn, 8.25)).toBe("2026-08-20T15:15:00.000Z");
  });

  it("a zero duration ends exactly at the clock-in", () => {
    expect(endFromDuration(clockIn, 0)).toBe(clockIn);
  });

  it("clamps a negative duration to zero rather than going backwards", () => {
    expect(endFromDuration(clockIn, -3)).toBe(clockIn);
  });

  it("treats NaN as zero so a half-typed field never throws", () => {
    expect(endFromDuration(clockIn, Number.NaN)).toBe(clockIn);
  });
});
