import { describe, expect, it } from "vitest";
import { lunchReminder } from "./lunchReminder";
import type { TimeShift } from "./timeclock";
const started = Date.parse("2026-09-18T18:00:00Z");
const shift = {
  id: "s",
  status: "open",
  clock_out_at: null,
  break_type: "lunch",
  break_started_at: new Date(started).toISOString(),
} as TimeShift;
describe("30-minute lunch reminder", () => {
  it("waits for 30 minutes and keeps the same identity across ticks", () => {
    expect(lunchReminder(shift, started + 1799999)).toBeNull();
    expect(lunchReminder(shift, started + 1800000)?.tag).toBe(
      lunchReminder(shift, started + 1900000)?.tag,
    );
  });
  it("does not remind a rest, ended break, ended shift or stale lunch", () => {
    for (const s of [
      null,
      { ...shift, break_type: "rest" as const },
      { ...shift, break_started_at: null },
      { ...shift, status: "submitted" as const },
      { ...shift, clock_out_at: new Date().toISOString() },
    ])
      expect(lunchReminder(s, started + 1800000)).toBeNull();
    expect(lunchReminder(shift, started + 2 * 3600000)).toBeNull();
  });
});
