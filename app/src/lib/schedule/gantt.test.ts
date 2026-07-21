import { describe, expect, it } from "vitest";
import { barGeometry, clampToWindow, laneCount, packLanes } from "./gantt";

describe("barGeometry", () => {
  const winStart = "2026-07-01";
  const winDays = 31; // July
  const col = 40;

  it("places a fully-visible multi-day bar as one span", () => {
    const g = barGeometry("2026-07-05", "2026-07-08", winStart, winDays, col)!;
    expect(g.startCol).toBe(4);
    expect(g.endCol).toBe(7);
    expect(g.left).toBe(160);
    expect(g.width).toBe(160); // 4 days * 40
    expect(g.clippedStart).toBe(false);
    expect(g.clippedEnd).toBe(false);
  });

  it("clips a bar that starts before the window", () => {
    const g = barGeometry("2026-06-28", "2026-07-03", winStart, winDays, col)!;
    expect(g.startCol).toBe(0);
    expect(g.endCol).toBe(2);
    expect(g.left).toBe(0);
    expect(g.width).toBe(120);
    expect(g.clippedStart).toBe(true);
    expect(g.clippedEnd).toBe(false);
  });

  it("clips a bar that runs past the window end", () => {
    const g = barGeometry("2026-07-30", "2026-08-10", winStart, winDays, col)!;
    expect(g.startCol).toBe(29);
    expect(g.endCol).toBe(30);
    expect(g.width).toBe(80);
    expect(g.clippedEnd).toBe(true);
  });

  it("renders a single-day bar one column wide", () => {
    const g = barGeometry("2026-07-10", "2026-07-10", winStart, winDays, col)!;
    expect(g.width).toBe(40);
  });

  it("returns null for a bar entirely outside the window", () => {
    expect(barGeometry("2026-08-01", "2026-08-05", winStart, winDays, col)).toBeNull();
    expect(barGeometry("2026-06-01", "2026-06-20", winStart, winDays, col)).toBeNull();
  });

  it("guards degenerate inputs", () => {
    expect(barGeometry("2026-07-01", "2026-07-02", winStart, 0, col)).toBeNull();
    expect(barGeometry("2026-07-01", "2026-07-02", winStart, winDays, 0)).toBeNull();
  });
});

describe("clampToWindow", () => {
  it("clips both ends to the window", () => {
    expect(clampToWindow("2026-06-20", "2026-08-10", "2026-07-01", "2026-07-31")).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });
});

describe("packLanes", () => {
  it("stacks overlapping bars into separate lanes and reuses freed lanes", () => {
    const bars = packLanes([
      { id: "a", start_date: "2026-07-01", end_date: "2026-07-05" },
      { id: "b", start_date: "2026-07-03", end_date: "2026-07-07" },
      { id: "c", start_date: "2026-07-09", end_date: "2026-07-10" },
    ]);
    const laneById = new Map(bars.map((b) => [b.item.id, b.lane]));
    expect(laneById.get("a")).toBe(0);
    expect(laneById.get("b")).toBe(1);
    // c starts after a ends → reuses lane 0.
    expect(laneById.get("c")).toBe(0);
    expect(laneCount(bars)).toBe(2);
  });

  it("keeps a single non-overlapping row on one lane", () => {
    const bars = packLanes([
      { id: "a", start_date: "2026-07-01", end_date: "2026-07-02" },
      { id: "b", start_date: "2026-07-03", end_date: "2026-07-04" },
    ]);
    expect(laneCount(bars)).toBe(1);
  });

  it("reports -1+1=0 lanes for an empty row", () => {
    expect(laneCount(packLanes([]))).toBe(0);
  });
});
