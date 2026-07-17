import { describe, expect, it } from "vitest";
import { currentBreakSeconds, shiftHours, startOfWeekIso, type TimeShift } from "./timeclock";

function shift(partial: Partial<TimeShift>): TimeShift {
  return {
    id: "s1",
    profile_id: "p1",
    project_id: "j1",
    cost_code_id: null,
    clock_in_at: "2026-01-05T08:00:00Z",
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: false,
    time_confirmed: true,
    status: "open",
    created_at: "2026-01-05T08:00:00Z",
    ...partial,
  };
}

describe("shiftHours", () => {
  it("returns 0 for an open shift", () => {
    expect(shiftHours(shift({}))).toBe(0);
  });
  it("subtracts break time from clocked span", () => {
    const s = shift({ clock_out_at: "2026-01-05T16:00:00Z", break_seconds: 1800 }); // 8h - 0.5h
    expect(shiftHours(s)).toBeCloseTo(7.5, 5);
  });
});

describe("currentBreakSeconds", () => {
  it("includes a running break based on break_started_at", () => {
    const now = new Date("2026-01-05T10:00:00Z").getTime();
    const s = shift({ break_seconds: 600, break_started_at: "2026-01-05T09:55:00Z" });
    expect(currentBreakSeconds(s, now)).toBe(600 + 300); // 5 min running
  });
  it("returns stored break when not currently on break", () => {
    const s = shift({ break_seconds: 900, break_started_at: null });
    expect(currentBreakSeconds(s, Date.now())).toBe(900);
  });
});

describe("startOfWeekIso", () => {
  it("returns a Monday at midnight as ISO", () => {
    const iso = startOfWeekIso();
    const d = new Date(iso);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});
