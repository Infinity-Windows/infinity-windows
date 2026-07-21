import { describe, expect, it } from "vitest";
import {
  filterVisible,
  visibleColumnRange,
  visibleRowRange,
  windowDayCount,
} from "./window";

const A = (id: string, start: string, end: string) => ({
  id,
  start_date: start,
  end_date: end,
});

describe("filterVisible", () => {
  it("keeps only assignments overlapping the window, preserving order", () => {
    const items = [
      A("before", "2026-06-01", "2026-06-10"),
      A("edge-start", "2026-06-20", "2026-07-01"),
      A("inside", "2026-07-05", "2026-07-06"),
      A("edge-end", "2026-07-31", "2026-08-05"),
      A("after", "2026-08-06", "2026-08-10"),
    ];
    const visible = filterVisible(items, "2026-07-01", "2026-07-31").map((a) => a.id);
    expect(visible).toEqual(["edge-start", "inside", "edge-end"]);
  });
});

describe("windowDayCount", () => {
  it("counts inclusive days", () => {
    expect(windowDayCount("2026-07-01", "2026-07-01")).toBe(1);
    expect(windowDayCount("2026-07-01", "2026-07-07")).toBe(7);
    expect(windowDayCount("2026-07-07", "2026-07-01")).toBe(0);
  });
});

describe("visibleColumnRange (virtualization)", () => {
  it("returns the on-screen columns plus overscan, clamped", () => {
    // 40px columns, 200px viewport, scrolled to 400px → cols 10..15, overscan 3.
    const r = visibleColumnRange(400, 200, 40, 180, 3);
    expect(r.startIndex).toBe(7);
    expect(r.endIndex).toBe(18);
  });

  it("clamps to [0, totalDays-1] at the edges", () => {
    const start = visibleColumnRange(0, 200, 40, 180, 3);
    expect(start.startIndex).toBe(0);
    const end = visibleColumnRange(100_000, 200, 40, 180, 3);
    expect(end.endIndex).toBe(179);
  });

  it("guards degenerate inputs", () => {
    expect(visibleColumnRange(0, 200, 0, 180)).toEqual({ startIndex: 0, endIndex: 0 });
    expect(visibleColumnRange(0, 200, 40, 0)).toEqual({ startIndex: 0, endIndex: 0 });
  });
});

describe("visibleRowRange (virtualization)", () => {
  it("returns on-screen rows plus overscan, clamped", () => {
    const r = visibleRowRange(300, 150, 50, 40, 2);
    expect(r.startIndex).toBe(4);
    expect(r.endIndex).toBe(11);
  });
});
