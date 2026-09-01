import { describe, expect, it } from "vitest";
import {
  distanceToDivider,
  mergeOutlineFeatures,
  nearestPointOnOutline,
  outlinePathWithOpenings,
  parseOutlineFeatures,
  rectFromDrag,
  snapPointToAxis,
  snapVertexToNeighbors,
  wallOpeningGeometry,
} from "./cad";

const ASPECT = 1; // square page keeps the math easy to read

const SQUARE = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];

describe("snapPointToAxis", () => {
  it("locks nearly-horizontal lines flat", () => {
    const snapped = snapPointToAxis(
      { x: 0.2, y: 0.5 },
      { x: 0.6, y: 0.51 }, // ~1.4° off horizontal
      ASPECT,
    );
    expect(snapped).toEqual({ x: 0.6, y: 0.5 });
  });

  it("locks nearly-vertical lines plumb", () => {
    const snapped = snapPointToAxis(
      { x: 0.5, y: 0.2 },
      { x: 0.508, y: 0.6 }, // ~1.1° off vertical
      ASPECT,
    );
    expect(snapped).toEqual({ x: 0.5, y: 0.6 });
  });

  it("leaves diagonal lines alone", () => {
    const next = { x: 0.6, y: 0.6 };
    expect(snapPointToAxis({ x: 0.2, y: 0.2 }, next, ASPECT)).toEqual(next);
  });

  it("respects page aspect when judging the on-screen angle", () => {
    // On a tall page (aspect 2) the same normalized offsets look flatter.
    const snapped = snapPointToAxis(
      { x: 0.2, y: 0.5 },
      { x: 0.6, y: 0.505 },
      2,
    );
    expect(snapped.y).toBe(0.5);
  });
});

describe("snapVertexToNeighbors", () => {
  it("snaps a dragged corner against both neighbors", () => {
    const snapped = snapVertexToNeighbors(
      SQUARE,
      1, // top-right corner
      { x: 0.81, y: 0.208 }, // slightly off both axes
      ASPECT,
    );
    expect(snapped.y).toBeCloseTo(0.2, 10); // level with top-left
    // and plumb with bottom-right after the second snap
    expect(snapped.x).toBeCloseTo(0.8, 10);
  });
});

describe("rectFromDrag", () => {
  it("makes a 4-corner axis-aligned rectangle", () => {
    const rect = rectFromDrag({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.5 }, false, ASPECT);
    expect(rect).toHaveLength(4);
    expect(rect[0]).toEqual({ x: 0.2, y: 0.3 });
    expect(rect[1]).toEqual({ x: 0.6, y: 0.3 });
    expect(rect[2]).toEqual({ x: 0.6, y: 0.5 });
    expect(rect[3]).toEqual({ x: 0.2, y: 0.5 });
  });

  it("locks to a perfect square in display space", () => {
    const rect = rectFromDrag({ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.3 }, true, ASPECT);
    const w = Math.abs(rect[1].x - rect[0].x);
    const hgt = Math.abs(rect[3].y - rect[0].y);
    expect(w).toBeCloseTo(hgt, 10);
    expect(w).toBeCloseTo(0.3, 10);
  });

  it("handles drags up/left of the anchor", () => {
    const rect = rectFromDrag({ x: 0.6, y: 0.6 }, { x: 0.3, y: 0.4 }, false, ASPECT);
    expect(rect[2]).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe("nearestPointOnOutline / distanceToDivider", () => {
  it("finds the closest edge point", () => {
    const hit = nearestPointOnOutline(SQUARE, { x: 0.5, y: 0.15 }, ASPECT);
    expect(hit).not.toBeNull();
    expect(hit!.edge).toBe(0);
    expect(hit!.point.x).toBeCloseTo(0.5, 10);
    expect(hit!.point.y).toBeCloseTo(0.2, 10);
    expect(hit!.dist).toBeCloseTo(50, 5); // 0.05 * 1000
  });

  it("measures distance to a divider", () => {
    const d = distanceToDivider(
      { id: "d", a: { x: 0.2, y: 0.5 }, b: { x: 0.8, y: 0.5 } },
      { x: 0.5, y: 0.53 },
      ASPECT,
    );
    expect(d).toBeCloseTo(30, 5);
  });
});

describe("wall openings", () => {
  it("resolves gap endpoints on the edge with an interior normal", () => {
    const geo = wallOpeningGeometry(SQUARE, ASPECT, {
      id: "w1",
      edge: 0,
      t: 0.5,
      width: 60,
      kind: "window",
    });
    expect(geo).not.toBeNull();
    expect(geo!.ax).toBeCloseTo(470, 5);
    expect(geo!.bx).toBeCloseTo(530, 5);
    expect(geo!.ay).toBeCloseTo(200, 5);
    // interior of the square is below the top edge
    expect(geo!.ny).toBeGreaterThan(0);
  });

  it("cuts gaps out of the stroked outline path", () => {
    const d = outlinePathWithOpenings(SQUARE, ASPECT, [
      { id: "w1", edge: 0, t: 0.5, width: 60, kind: "window" },
    ]);
    expect(d).toBeTruthy();
    // top edge split into two strokes around x=470..530
    expect(d).toContain("M200.0 200.0");
    expect(d).toContain("L470.0 200.0");
    expect(d).toContain("M530.0 200.0");
  });

  it("keeps the gap on the edge near corners", () => {
    const geo = wallOpeningGeometry(SQUARE, ASPECT, {
      id: "w2",
      edge: 0,
      t: 0.01,
      width: 80,
      kind: "door",
    });
    expect(geo!.ax).toBeGreaterThanOrEqual(200);
  });
});

describe("parseOutlineFeatures", () => {
  it("parses stored jsonb shapes tolerantly", () => {
    const parsed = parseOutlineFeatures({
      dividers: [
        { id: "d1", a: { x: 0.1, y: 0.2 }, b: { x: 0.9, y: 0.2 } },
        { a: "bad" },
      ],
      wallOpenings: [
        { id: "w1", edge: 2, t: 0.4, width: 50, kind: "door" },
        { edge: -1, t: 0.5, width: 40 },
      ],
    });
    expect(parsed.dividers).toHaveLength(1);
    expect(parsed.wallOpenings).toHaveLength(1);
    expect(parsed.wallOpenings[0].kind).toBe("door");
  });

  it("returns empty features for junk", () => {
    expect(parseOutlineFeatures(null)).toEqual({ dividers: [], wallOpenings: [] });
    expect(parseOutlineFeatures("x")).toEqual({ dividers: [], wallOpenings: [] });
  });
});

// The PlanModelEditor.tsx footgun fix (CLAUDE.md, wave N's N4): this editor
// only ever knows dividers/wallOpenings, but the features column also
// carries fitview (the tracer's survey model, calibration, northDeg) and
// modelstudio. A save used to write {dividers, wallOpenings} as the WHOLE
// column, wiping both silently — mergeOutlineFeatures is the fix PlanModelEditor
// now calls before every save.
describe("mergeOutlineFeatures (PlanModelEditor's writer, the footgun fix)", () => {
  it("keeps an unknown top-level key (fitview, northDeg included) across a save", () => {
    const prevRaw = {
      fitview: {
        longSideM: 30,
        wallHeightM: 3.6,
        northDeg: 27,
        source: "in-app trace",
        model: { building: {}, windows: [] },
      },
      modelstudio: { floors: ["x"] },
      dividers: [{ id: "old", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }],
      wallOpenings: [],
    };
    const patch = {
      dividers: [{ id: "new", a: { x: 0.1, y: 0.1 }, b: { x: 0.9, y: 0.9 } }],
      wallOpenings: [{ id: "w1", edge: 0, t: 0.5, width: 50, kind: "window" as const }],
    };
    const merged = mergeOutlineFeatures(prevRaw, patch);
    // The editor's own fields win...
    expect(merged.dividers).toEqual(patch.dividers);
    expect(merged.wallOpenings).toEqual(patch.wallOpenings);
    // ...but fitview (northDeg included) and modelstudio, which this editor
    // never touches, ride through untouched.
    expect(merged.fitview).toEqual(prevRaw.fitview);
    expect(merged.modelstudio).toEqual(prevRaw.modelstudio);
  });

  it("works from nothing (a brand new outline's first save)", () => {
    const patch = { dividers: [], wallOpenings: [] };
    expect(mergeOutlineFeatures(undefined, patch)).toEqual(patch);
    expect(mergeOutlineFeatures(null, patch)).toEqual(patch);
    expect(mergeOutlineFeatures("not an object", patch)).toEqual(patch);
  });
});
