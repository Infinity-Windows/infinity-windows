import { describe, expect, it } from "vitest";
import { separatePins, type LayoutPin } from "./pinLayout";

const ASPECT = 0.7;
const MIN = 0.06;

/** Closest display-space gap between any two laid-out pins. */
function closestGap(
  layout: Map<string, { x: number; y: number }>,
  aspect = ASPECT,
): number {
  const pts = [...layout.values()];
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      best = Math.min(
        best,
        Math.hypot(pts[i].x - pts[j].x, (pts[i].y - pts[j].y) * aspect),
      );
    }
  }
  return best;
}

describe("separatePins", () => {
  it("pulls two stacked pins apart", () => {
    const pins: LayoutPin[] = [
      { id: "a", x: 0.5, y: 0.5 },
      { id: "b", x: 0.503, y: 0.501 },
    ];
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    expect(closestGap(layout)).toBeGreaterThan(MIN * 0.9);
  });

  it("leaves pins that already have room exactly where they are", () => {
    const pins: LayoutPin[] = [
      { id: "a", x: 0.2, y: 0.2 },
      { id: "b", x: 0.8, y: 0.8 },
    ];
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    expect(layout.get("a")).toEqual({ x: 0.2, y: 0.2 });
    expect(layout.get("b")).toEqual({ x: 0.8, y: 0.8 });
  });

  it("fans a crowded wall along the wall, not across the room", () => {
    // Six marks bunched on one horizontal wall.
    const pins: LayoutPin[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      x: 0.4 + i * 0.012,
      y: 0.3,
    }));
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    for (const pin of pins) {
      const moved = layout.get(pin.id)!;
      // Spread sideways along the wall; the wall itself must not move.
      expect(Math.abs(moved.y - 0.3)).toBeLessThan(0.01);
    }
    // Six marks inside a 0.06 span cannot all reach full spacing without one
    // being moved further than the cap allows, so the guarantee is a large
    // improvement, not perfection. Shrinking the dot handles the rest.
    const before = closestGap(
      new Map(pins.map((p) => [p.id, { x: p.x, y: p.y }])),
    );
    expect(closestGap(layout)).toBeGreaterThan(before * 2);
  });

  it("fans a crowded vertical wall vertically", () => {
    const pins: LayoutPin[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      x: 0.3,
      y: 0.4 + i * 0.01,
    }));
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    for (const pin of pins) {
      expect(Math.abs(layout.get(pin.id)!.x - 0.3)).toBeLessThan(0.01);
    }
  });

  it("never moves a pin further than the cap — a pin must not lie", () => {
    const pins: LayoutPin[] = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      x: 0.5 + (i % 3) * 0.004,
      y: 0.5 + Math.floor(i / 3) * 0.004,
    }));
    const maxShift = MIN;
    const layout = separatePins(pins, {
      minDist: MIN,
      aspect: ASPECT,
      maxShift,
    });
    for (const pin of pins) {
      const moved = layout.get(pin.id)!;
      const shift = Math.hypot(
        moved.x - pin.x,
        (moved.y - pin.y) * ASPECT,
      );
      expect(shift).toBeLessThanOrEqual(maxShift + 1e-9);
    }
  });

  it("is deterministic and independent of input order", () => {
    const pins: LayoutPin[] = [
      { id: "a", x: 0.5, y: 0.5 },
      { id: "b", x: 0.51, y: 0.502 },
      { id: "c", x: 0.52, y: 0.498 },
      { id: "d", x: 0.9, y: 0.1 },
    ];
    const forward = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    const reversed = separatePins([...pins].reverse(), {
      minDist: MIN,
      aspect: ASPECT,
    });
    for (const pin of pins) {
      expect(reversed.get(pin.id)).toEqual(forward.get(pin.id));
    }
  });

  it("returns a position for every pin", () => {
    const pins: LayoutPin[] = Array.from({ length: 42 }, (_, i) => ({
      id: `m${i}`,
      x: 0.2 + (i % 7) * 0.09,
      y: 0.2 + Math.floor(i / 7) * 0.1,
    }));
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    expect(layout.size).toBe(42);
  });

  it("keeps every pin on the page", () => {
    // A pile jammed into the corner: spreading must not push pins off-sheet.
    const pins: LayoutPin[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      x: 0.005 + i * 0.001,
      y: 0.995,
    }));
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    for (const point of layout.values()) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  it("keeps marks in order along the wall rather than shuffling them", () => {
    const pins: LayoutPin[] = [
      { id: "first", x: 0.4, y: 0.3 },
      { id: "second", x: 0.415, y: 0.3 },
      { id: "third", x: 0.43, y: 0.3 },
    ];
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    expect(layout.get("first")!.x).toBeLessThan(layout.get("second")!.x);
    expect(layout.get("second")!.x).toBeLessThan(layout.get("third")!.x);
  });

  it("handles the degenerate cases without throwing", () => {
    expect(separatePins([], { minDist: MIN, aspect: ASPECT }).size).toBe(0);
    const single = separatePins([{ id: "a", x: 0.5, y: 0.5 }], {
      minDist: MIN,
      aspect: ASPECT,
    });
    expect(single.get("a")).toEqual({ x: 0.5, y: 0.5 });
    // Zero spacing means "do not separate", not "divide by zero".
    const off = separatePins(
      [
        { id: "a", x: 0.5, y: 0.5 },
        { id: "b", x: 0.5, y: 0.5 },
      ],
      { minDist: 0, aspect: ASPECT },
    );
    expect(off.get("a")).toEqual({ x: 0.5, y: 0.5 });
    expect(off.get("b")).toEqual({ x: 0.5, y: 0.5 });
  });

  it("separates exactly coincident pins", () => {
    const pins: LayoutPin[] = [
      { id: "a", x: 0.5, y: 0.5 },
      { id: "b", x: 0.5, y: 0.5 },
      { id: "c", x: 0.5, y: 0.5 },
    ];
    const layout = separatePins(pins, { minDist: MIN, aspect: ASPECT });
    expect(closestGap(layout)).toBeGreaterThan(0);
  });
});
