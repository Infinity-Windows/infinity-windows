import { expect, it, vi } from "vitest";
import { clockedDays, clockedWeeks, clockedJobWeeks, clockedRelativeJobWeeks, relativeClockWindows } from "./clockedWeeks";
import { midnight } from "./generalLabor";
import type { TimeShift } from "../../lib/timeclock";
const shift = (id: string, date: string) => ({ id, clock_in_at: `${date}T06:00:00Z`, clock_out_at: `${date}T14:00:00Z`, break_seconds: 1800, status: "approved", cost_codes: { code: "INSTALL", label: "Installation" } }) as TimeShift;

it("keeps seven calendar days and side-by-side jobs, including empty days across Denver DST", () => {
  const a = { ...shift("a", "2026-11-01"), project_id: "A", clock_in_at: "2026-11-01T07:00:00Z", clock_out_at: "2026-11-01T15:00:00Z" } as TimeShift;
  const b = { ...shift("b", "2026-11-02"), project_id: "B", clock_in_at: "2026-11-02T07:00:00Z", clock_out_at: "2026-11-02T15:00:00Z" } as TimeShift;
  const bars = clockedDays([a, a, b, { ...a, id: "running", clock_out_at: null }], midnight("2026-10-29"), midnight("2026-11-05"), new Map([["A", "Job A"], ["B", "Job B"]]), midnight("2026-11-06"));
  expect(bars).toHaveLength(14);
  expect(bars.map(bar => bar.key).filter((_, index) => index % 2 === 0)).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
  expect(bars.flatMap(bar => bar.ids)).toEqual(["a", "b"]);
  expect(bars.reduce((sum, bar) => sum + bar.seconds / 3600, 0)).toBe(15);
  expect(bars[0]).toMatchObject({ seriesLabel: "Job A", seconds: 0, percent: null, partial: false });
  const future = clockedDays([], midnight("2026-10-19"), midnight("2026-10-26"), undefined, midnight("2026-10-23") + 3600000);
  expect(future.find(day => day.key === "2026-10-23")?.partial).toBe(true);
  expect(future.find(day => day.key === "2026-10-24")?.unavailable).toBe(true);
});
it("uses net clocked hours, retains gap weeks, and excludes voided/running/duplicate shifts", () => {
  const first = shift("a", "2026-10-05");
  const weeks = clockedWeeks([first, first, shift("b", "2026-10-19"), { ...first, id: "void", status: "voided" }, { ...first, id: "running", clock_out_at: null }]);
  expect(weeks.map(week => week.seconds / 3600)).toEqual([7.5, 0, 7.5]);
  expect(weeks[0].segments[0]).toMatchObject({ activity: "INSTALL · Installation", ids: ["a"], seconds: 27000 });
});

it("aligns separate jobs on one calendar without copying hours or records into missing weeks", () => {
  const a = { ...shift("a", "2026-10-05"), project_id: "A", projects: { job_code: "JOB A" } } as TimeShift;
  const b = { ...shift("b", "2026-10-19"), project_id: "B", projects: { job_code: "JOB B" } } as TimeShift;
  const bars = clockedJobWeeks([a, a, b]);
  expect(bars).toHaveLength(6);
  expect(bars.map(bar => bar.seconds / 3600)).toEqual([7.5, 0, 0, 0, 0, 7.5]);
  expect(bars.flatMap(bar => bar.ids)).toEqual(["a", "b"]);
  expect(bars[1]).toMatchObject({ seriesLabel: "JOB B", percent: null, totalSeconds: 0, segments: [] });
});

it("aligns seven-day job periods across different dates and preserves origins under filtering", () => {
  const a = { ...shift("a", "2026-09-30"), project_id: "A", projects: { job_code: "A" } } as TimeShift;
  const b = { ...shift("b", "2026-10-12"), project_id: "B", projects: { job_code: "B" } } as TimeShift;
  const a2 = { ...a, ...shift("a2", "2026-10-07") };
  const b2 = { ...b, ...shift("b2", "2026-10-19") };
  const history = [a, a2, b, b2];
  const bars = clockedRelativeJobWeeks(history, history);
  expect(bars.map(bar => [bar.groupLabel, bar.key, bar.ids])).toEqual([
    ["Week 1", "2026-09-30", ["a"]], ["Week 1", "2026-10-12", ["b"]],
    ["Week 2", "2026-10-07", ["a2"]], ["Week 2", "2026-10-19", ["b2"]],
  ]);
  const filtered = clockedRelativeJobWeeks([a2, b2], history);
  expect(filtered.map(bar => bar.groupLabel)).toEqual(["Week 2", "Week 2"]);
  expect(filtered.reduce((sum, bar) => sum + bar.seconds / 3600, 0)).toBe(15);
});

it("uses local calendar days across daylight saving and retains inactive relative weeks", () => {
  const make = (id: string, date: string) => ({ ...shift(id, date), project_id: "A", clock_in_at: `${date}T15:00:00Z`, clock_out_at: `${date}T23:00:00Z` });
  const first = make("a", "2026-10-30"), next = make("b", "2026-11-13");
  const bars = clockedRelativeJobWeeks([first, next], [first, next]);
  expect(bars.map(bar => [bar.groupLabel, bar.key, bar.seconds / 3600])).toEqual([
    ["Week 1", "2026-10-30", 7.5], ["Week 2", "2026-11-06", 0], ["Week 3", "2026-11-13", 7.5],
  ]);
});

it("bounds each relative read to N Denver weeks from that job's first finished shift", () => {
  const first = { ...shift("origin", "2026-10-30"), project_id: "A", clock_in_at: "2026-10-30T15:00:00Z" } as TimeShift;
  const windows = relativeClockWindows([first], 4);
  expect(windows).toEqual([{ jobId: "A", from: midnight("2026-10-30"), until: midnight("2026-11-27") }]);
  expect((windows[0].until - windows[0].from) / 3600000).toBe(673);
  const bars = clockedRelativeJobWeeks([first], [first], 4);
  expect(bars.map(bar => bar.groupLabel)).toEqual(["Week 1", "Week 2", "Week 3", "Week 4"]);
  expect(bars[3]).toMatchObject({ unavailable: true, ids: [] });
});

it("marks unreached relative weeks separately from missing recorded weeks", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(midnight("2026-11-01"));
  try {
    const first = { ...shift("a", "2026-10-05"), project_id: "A" } as TimeShift;
    const bars = clockedRelativeJobWeeks([first], [first], 8);
    expect(bars.find(bar => bar.groupLabel === "Week 2")).toMatchObject({ unavailable: true, future: false });
    expect(bars.find(bar => bar.groupLabel === "Week 8")).toMatchObject({ unavailable: true, future: true });
  } finally { now.mockRestore(); }
});

it("places each project's own unit-work start together at Week 1 when that alignment is selected", () => {
  const a = { ...shift("a", "2026-09-23"), project_id: "A", projects: { job_code: "A" } } as TimeShift;
  const b = { ...shift("b", "2026-09-28"), project_id: "B", projects: { job_code: "B" } } as TimeShift;
  const bars = clockedRelativeJobWeeks([a, b], [], 2, new Map([["A", "2026-09-23"], ["B", "2026-09-28"]]));
  expect(bars.slice(0, 2).map(bar => [bar.groupLabel, bar.key, bar.ids])).toEqual([["Week 1", "2026-09-23", ["a"]], ["Week 1", "2026-09-28", ["b"]]]);
});
