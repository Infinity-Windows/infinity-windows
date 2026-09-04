import { describe, expect, it } from "vitest";
import { isOnTheClock, shiftHours, type TimeShift } from "./timeclock";
import { computeLabor } from "./costing";
import { flaggedShifts, isUnfinished, needsFinishTime, shiftGuard } from "./shiftGuard";

/**
 * The exact shape `close_shift_as_no_work` leaves behind: closed at its own
 * clock-in moment, approved, zero break. This is how Ammon's 18 July punch on
 * PECAN14 now sits on production after Taylor recorded it as no work done.
 */
const CLOCK_IN = "2026-07-18T20:31:26.394254+00:00";

const zeroed: TimeShift = {
  id: "d59b9c5a-f500-41b8-bae3-337e46dd8e58",
  profile_id: "ammon",
  project_id: "pecan14",
  cost_code_id: "c1",
  clock_in_at: CLOCK_IN,
  clock_out_at: CLOCK_IN,
  break_seconds: 0,
  break_started_at: null,
  injured: false,
  time_confirmed: false,
  status: "approved",
  created_at: CLOCK_IN,
  edited_note:
    "Recorded as zero hours by Taylor on 2026-07-30: this punch was Ammon testing the app while it was being built, not worked time.",
};

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

describe("a shift written off as no work done", () => {
  it("counts as exactly zero hours", () => {
    expect(shiftHours(zeroed)).toBe(0);
  });

  it("adds nothing to job costing — no hours and no cost", () => {
    const labor = computeLabor([
      {
        project_id: zeroed.project_id!,
        clock_in_at: zeroed.clock_in_at,
        clock_out_at: zeroed.clock_out_at,
        break_seconds: zeroed.break_seconds,
        role: "owner",
      },
    ]);
    // Wave Z added the per-person breakdown (so Costing can mark a line
    // "estimated — no rate on file"); the two numbers that matter are still
    // zero, and the person's own line is zero too.
    const pecan = labor.get("pecan14")!;
    expect(pecan.hours).toBe(0);
    expect(pecan.cost).toBe(0);
    expect(pecan.people).toEqual([
      { profileId: "unknown", name: "Someone", hours: 0, cost: 0, estimated: true },
    ]);
  });

  it("is no longer unfinished, so it leaves the office's runaway list", () => {
    expect(isUnfinished(zeroed)).toBe(false);
    expect(needsFinishTime(zeroed)).toBe(false);
    expect(flaggedShifts([zeroed], NOW)).toEqual([]);
  });

  it("is not flagged, however long ago it was punched", () => {
    // Weeks later, the guard must not re-flag it just because the clock-in is
    // ancient — it is closed, and its recorded length is zero.
    const view = shiftGuard(zeroed, NOW);
    expect(view.state).toBe("running");
    expect(view.flagged).toBe(false);
    expect(view.workedSeconds).toBe(0);
  });

  it("does not put anybody back on the clock", () => {
    expect(isOnTheClock(zeroed)).toBe(false);
  });

  it("is settled rather than waiting on an approval", () => {
    expect(zeroed.status).toBe("approved");
    expect(zeroed.status).not.toBe("submitted");
    expect(zeroed.status).not.toBe("needs_finish");
  });

  it("says on the row why it is zero and who decided", () => {
    expect(zeroed.edited_note).toMatch(/zero hours/i);
    expect(zeroed.edited_note).toMatch(/Taylor/);
    expect(zeroed.edited_note).toMatch(/not worked time/i);
  });

  it("records that the worker did not confirm the time", () => {
    // A supervisor decided this; Ammon never signed off on it.
    expect(zeroed.time_confirmed).toBe(false);
  });
});
