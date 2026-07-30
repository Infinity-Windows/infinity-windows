import { describe, expect, it } from "vitest";
import {
  DOOR_GAP_WIDTH,
  layoutEdgeGaps,
  MIN_GAP_WIDTH,
  snapOpeningsToWalls,
  wallPinPosition,
  WALL_SNAP_DISTANCE,
  WINDOW_GAP_WIDTH,
  type SnapCandidate,
} from "./wallSnap";
import { outlinePathWithOpenings } from "./cad";
import type { OutlinePoint } from "./outline";

const ASPECT = 0.7;
/** A plain rectangular building, walls at x 0.2/0.8 and y 0.2/0.8. */
const BOX: OutlinePoint[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];

function candidate(
  id: string,
  x: number,
  y: number,
  kind: "window" | "door" = "window",
): SnapCandidate {
  return { id, x, y, kind };
}

describe("snapOpeningsToWalls", () => {
  it("makes a mark sitting on a wall into an opening in that wall", () => {
    const result = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.2)],
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.freeIds).toEqual([]);
    const opening = result.snapped.get("a")!;
    expect(opening.edge).toBe(0);
    expect(opening.width).toBe(WINDOW_GAP_WIDTH);
    expect(opening.point.y).toBeCloseTo(0.2, 2);
    expect(opening.point.x).toBeCloseTo(0.5, 2);
  });

  it("leaves a mark in the middle of the room exactly where it is", () => {
    // This is Pecan's floor 3: marks the extractor put in rows across the page,
    // nowhere near a real wall. Snapping them would invent a location.
    const result = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.5)],
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.snapped.size).toBe(0);
    expect(result.freeIds).toEqual(["a"]);
  });

  it("snaps just inside the threshold and not just outside it", () => {
    // The threshold is in viewBox units; the top wall is at y = 0.2.
    const inside = WALL_SNAP_DISTANCE * 0.8;
    const outside = WALL_SNAP_DISTANCE * 1.4;
    const h = 1000 * ASPECT;
    const near = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.2 + inside / h)],
      points: BOX,
      aspect: ASPECT,
    });
    const far = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.2 + outside / h)],
      points: BOX,
      aspect: ASPECT,
    });
    expect(near.snapped.size).toBe(1);
    expect(far.snapped.size).toBe(0);
  });

  it("gives doors a wider opening than windows", () => {
    const result = snapOpeningsToWalls({
      openings: [candidate("d", 0.4, 0.8, "door")],
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.snapped.get("d")!.width).toBe(DOOR_GAP_WIDTH);
  });

  it("leaves marks packed tighter than openings can be as plain dots", () => {
    // Pecan's schedule strip: entries about a pixel apart in page terms, close
    // enough to a wall to snap. Ten windows in a wall's width of wall is not a
    // building, so none of them is drawn as an opening.
    const packed = Array.from({ length: 10 }, (_, i) =>
      candidate(`s${i}`, 0.3 + i * 0.004, 0.2),
    );
    const result = snapOpeningsToWalls({
      openings: packed,
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.snapped.size).toBe(0);
    expect(result.freeIds.sort()).toEqual(packed.map((p) => p.id).sort());
  });

  it("still draws openings that only need a modest squeeze", () => {
    const openings = Array.from({ length: 5 }, (_, i) =>
      candidate(`m${i}`, 0.3 + i * 0.075, 0.2),
    );
    const result = snapOpeningsToWalls({
      openings,
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.snapped.size).toBe(5);
    for (const opening of result.snapped.values()) {
      expect(opening.width).toBeGreaterThanOrEqual(MIN_GAP_WIDTH);
    }
  });

  it("never lets two openings on one wall merge into a single hole", () => {
    // Three marks within a few pixels of each other on the same wall.
    const result = snapOpeningsToWalls({
      openings: [
        candidate("a", 0.5, 0.2),
        candidate("b", 0.51, 0.2),
        candidate("c", 0.52, 0.2),
      ],
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.snapped.size).toBe(3);
    const spans = [...result.snapped.values()]
      .map((o) => ({
        from: o.t * 600 - o.width / 2,
        to: o.t * 600 + o.width / 2,
      }))
      .sort((p, q) => p.from - q.from);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].from).toBeGreaterThanOrEqual(spans[i - 1].to - 0.01);
    }
  });

  it("leaves wall between the gaps, so the wall does not vanish", () => {
    const openings = Array.from({ length: 6 }, (_, i) =>
      candidate(`m${i}`, 0.25 + i * 0.1, 0.2),
    );
    const result = snapOpeningsToWalls({
      openings,
      points: BOX,
      aspect: ASPECT,
    });
    const path = outlinePathWithOpenings(BOX, ASPECT, [
      ...result.snapped.values(),
    ]);
    expect(path).not.toBeNull();
    // Every wall segment between gaps is a separate move-to in the path.
    expect((path!.match(/M/g) ?? []).length).toBeGreaterThan(6);
  });

  it("refuses to put an opening in a wall shorter than an opening", () => {
    const sliver: OutlinePoint[] = [
      { x: 0.5, y: 0.5 },
      { x: 0.505, y: 0.5 },
      { x: 0.505, y: 0.7 },
      { x: 0.5, y: 0.7 },
    ];
    const result = snapOpeningsToWalls({
      openings: [candidate("a", 0.5025, 0.5)],
      points: sliver,
      aspect: ASPECT,
    });
    expect(result.snapped.has("a")).toBe(false);
    expect(result.freeIds).toContain("a");
  });

  it("is deterministic and independent of input order", () => {
    const openings = [
      candidate("a", 0.3, 0.2),
      candidate("b", 0.32, 0.2),
      candidate("c", 0.7, 0.8, "door"),
      candidate("d", 0.5, 0.5),
    ];
    const forward = snapOpeningsToWalls({
      openings,
      points: BOX,
      aspect: ASPECT,
    });
    const backward = snapOpeningsToWalls({
      openings: [...openings].reverse(),
      points: BOX,
      aspect: ASPECT,
    });
    for (const o of openings) {
      expect(backward.snapped.get(o.id)).toEqual(forward.snapped.get(o.id));
    }
    expect([...backward.freeIds].sort()).toEqual([...forward.freeIds].sort());
  });

  it("accounts for every mark exactly once", () => {
    const openings = [
      candidate("a", 0.5, 0.2),
      candidate("b", 0.5, 0.5),
      candidate("c", 0.8, 0.6),
      candidate("d", Number.NaN, 0.2),
    ];
    const result = snapOpeningsToWalls({
      openings,
      points: BOX,
      aspect: ASPECT,
    });
    expect(result.snapped.size + result.freeIds.length).toBe(openings.length);
  });

  it("treats every mark as free when there is no building to snap to", () => {
    const result = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.2)],
      points: [{ x: 0.5, y: 0.5 }],
      aspect: ASPECT,
    });
    expect(result.freeIds).toEqual(["a"]);
  });
});

describe("wallPinPosition", () => {
  it("puts the touch handle inside the building, off the gap", () => {
    const result = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.2)],
      points: BOX,
      aspect: ASPECT,
    });
    const opening = result.snapped.get("a")!;
    const handle = wallPinPosition(BOX, ASPECT, opening)!;
    // Top wall, so "inside" is downwards, and it must clear the gap.
    expect(handle.y).toBeGreaterThan(0.2);
    expect(handle.x).toBeCloseTo(0.5, 2);
    const clearance = (handle.y - 0.2) * 1000 * ASPECT;
    expect(clearance).toBeGreaterThan(opening.width / 2);
  });

  it("pushes inward on every wall, not just the top one", () => {
    const marks: [string, number, number][] = [
      ["top", 0.5, 0.2],
      ["right", 0.8, 0.5],
      ["bottom", 0.5, 0.8],
      ["left", 0.2, 0.5],
    ];
    const result = snapOpeningsToWalls({
      openings: marks.map(([id, x, y]) => candidate(id, x, y)),
      points: BOX,
      aspect: ASPECT,
    });
    for (const [id] of marks) {
      const handle = wallPinPosition(BOX, ASPECT, result.snapped.get(id)!)!;
      // Inside the box on both axes, whichever wall it came from.
      expect(handle.x).toBeGreaterThan(0.19);
      expect(handle.x).toBeLessThan(0.81);
      expect(handle.y).toBeGreaterThan(0.19);
      expect(handle.y).toBeLessThan(0.81);
    }
  });

  it("keeps the handle on the page", () => {
    const edgeBox: OutlinePoint[] = [
      { x: 0.01, y: 0.01 },
      { x: 0.99, y: 0.01 },
      { x: 0.99, y: 0.99 },
      { x: 0.01, y: 0.99 },
    ];
    const result = snapOpeningsToWalls({
      openings: [candidate("a", 0.5, 0.01)],
      points: edgeBox,
      aspect: ASPECT,
    });
    const handle = wallPinPosition(edgeBox, ASPECT, result.snapped.get("a")!)!;
    expect(handle.x).toBeGreaterThanOrEqual(0);
    expect(handle.x).toBeLessThanOrEqual(1);
    expect(handle.y).toBeGreaterThanOrEqual(0);
    expect(handle.y).toBeLessThanOrEqual(1);
  });
});

describe("layoutEdgeGaps", () => {
  it("leaves a lone gap where it was asked for", () => {
    const [gap] = layoutEdgeGaps(600, [
      { id: "a", center: 300, width: WINDOW_GAP_WIDTH },
    ]);
    expect(gap.center).toBe(300);
    expect(gap.width).toBe(WINDOW_GAP_WIDTH);
  });

  it("shrinks gaps before it moves them", () => {
    // Eight windows on a wall that can only hold about five at full width.
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      center: 30 + i * 40,
      width: WINDOW_GAP_WIDTH,
    }));
    const laid = layoutEdgeGaps(320, items);
    expect(laid.every((g) => g.width < WINDOW_GAP_WIDTH)).toBe(true);
    // Shrinking is bounded: an opening narrower than this stops reading as one.
    expect(laid.every((g) => g.width >= MIN_GAP_WIDTH * 0.99)).toBe(true);
    // And none of them was slid far from where its mark actually is.
    for (const gap of laid) {
      const original = items.find((it) => it.id === gap.id)!.center;
      expect(Math.abs(gap.center - original)).toBeLessThanOrEqual(34.01);
    }
  });

  it("shrinks rather than sliding when a cluster cannot be spread", () => {
    // Three marks within six units of each other: spreading them at full width
    // would need a 100-unit slide, far past the cap.
    const laid = layoutEdgeGaps(600, [
      { id: "a", center: 300, width: WINDOW_GAP_WIDTH },
      { id: "b", center: 306, width: WINDOW_GAP_WIDTH },
      { id: "c", center: 312, width: WINDOW_GAP_WIDTH },
    ]);
    expect(laid.every((g) => g.width < WINDOW_GAP_WIDTH)).toBe(true);
    const spans = laid
      .map((g) => ({ from: g.center - g.width / 2, to: g.center + g.width / 2 }))
      .sort((p, q) => p.from - q.from);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].from).toBeGreaterThanOrEqual(spans[i - 1].to - 0.01);
    }
  });

  it("keeps gaps in order along the wall", () => {
    const laid = layoutEdgeGaps(600, [
      { id: "a", center: 100, width: 46 },
      { id: "b", center: 110, width: 46 },
      { id: "c", center: 120, width: 46 },
    ]);
    const byId = new Map(laid.map((g) => [g.id, g.center]));
    expect(byId.get("a")!).toBeLessThan(byId.get("b")!);
    expect(byId.get("b")!).toBeLessThan(byId.get("c")!);
  });

  it("keeps every gap on the wall", () => {
    const laid = layoutEdgeGaps(300, [
      { id: "a", center: 0, width: 46 },
      { id: "b", center: 300, width: 46 },
    ]);
    for (const gap of laid) {
      expect(gap.center - gap.width / 2).toBeGreaterThanOrEqual(-0.01);
      expect(gap.center + gap.width / 2).toBeLessThanOrEqual(300.01);
    }
  });

  it("does not slide a gap further than the cap", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      center: 250 + i * 2,
      width: WINDOW_GAP_WIDTH,
    }));
    const laid = layoutEdgeGaps(600, items, { maxSlide: 30 });
    const original = new Map(items.map((it) => [it.id, it.center]));
    for (const gap of laid) {
      expect(Math.abs(gap.center - original.get(gap.id)!)).toBeLessThanOrEqual(
        30.01,
      );
    }
  });

  it("handles an empty wall", () => {
    expect(layoutEdgeGaps(600, [])).toEqual([]);
  });
});
