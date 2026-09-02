// Wave W (w-walls-spec.md, 2026-08-31), W3 — interior/free-standing walls
// carry through Publish instead of being silently dropped, and the safety
// rail: adding them must never change one pixel of the exterior silhouette.
// BLACK22's real shape (a big ground floor with a smaller upper section —
// see floors.test.ts's "multi-floor publish" describe block) is reused here
// as a Studio-side fixture, run twice — once with an interior wall added,
// once without — and the exterior halves of the two outputs must be
// byte-identical (JSON.stringify equal). That equality IS the regression
// test outerPolygons stays untouched proves.

import { describe, expect, it } from "vitest";
import { buildFitviewModelFromStudio, classifyWalls, interiorSegments } from "./toFitview";

interface LiteWall {
  height: number;
  getStartX: () => number;
  getStartY: () => number;
  getEndX: () => number;
  getEndY: () => number;
}

function wall(x1: number, y1: number, x2: number, y2: number, heightCm: number): LiteWall {
  return {
    height: heightCm,
    getStartX: () => x1,
    getStartY: () => y1,
    getEndX: () => x2,
    getEndY: () => y2,
  };
}

/** BLACK22's shape: a big rectangular ground floor + a smaller upper section
 * sharing its right-hand wall, same footprint floors.test.ts stacks. */
function black22Ground(): LiteWall[] {
  return [
    wall(0, 0, 1800, 0, 300),
    wall(1800, 0, 1800, 600, 300),
    wall(1800, 600, 0, 600, 300),
    wall(0, 600, 0, 0, 300),
  ];
}

function black22Upper(): LiteWall[] {
  return [
    wall(1000, 0, 1800, 0, 250),
    wall(1800, 0, 1800, 600, 250),
    wall(1800, 600, 1000, 600, 250),
    wall(1000, 600, 1000, 0, 250),
  ];
}

/** The same ground floor with ONE interior partition added — a wall from
 * the middle of the front edge to the middle of the back edge, sharing
 * corners with the exterior loop (the common "hallway divider" shape). */
function black22GroundWithInterior(): LiteWall[] {
  return [...black22Ground(), wall(900, 0, 900, 600, 300)];
}

describe("W3: exterior silhouette is byte-identical with or without an interior wall", () => {
  it("BLACK22's stories/footprints/width/height/windows never move", () => {
    const withoutInterior = buildFitviewModelFromStudio(
      [{ walls: black22Ground(), items: [] }, { walls: black22Upper(), items: [] }],
      new Map(),
    )!;
    const withInterior = buildFitviewModelFromStudio(
      [{ walls: black22GroundWithInterior(), items: [] }, { walls: black22Upper(), items: [] }],
      new Map(),
    )!;

    expect(withoutInterior).not.toBeNull();
    expect(withInterior).not.toBeNull();

    const strip = (m: { model: Record<string, unknown> }) => {
      const b = m.model.building as Record<string, unknown>;
      // Every key EXCEPT interiorWalls, which only the "with" run carries —
      // an additive field is not a shape change.
      const { interiorWalls: _interiorWalls, ...rest } = b;
      return { building: rest, windows: m.model.windows };
    };

    expect(JSON.stringify(strip(withInterior))).toBe(JSON.stringify(strip(withoutInterior)));

    // And the stats an installer reads (masses/stories/windows/skipped) —
    // the same proof, the numbers a human actually sees.
    expect(withInterior.stats.masses).toBe(withoutInterior.stats.masses);
    expect(withInterior.stats.stories).toBe(withoutInterior.stats.stories);
    expect(withInterior.stats.windows).toBe(withoutInterior.stats.windows);
    expect(withInterior.stats.skippedWindows).toBe(withoutInterior.stats.skippedWindows);
  });

  it("a free-standing wall (no loop at all) is equally invisible to the silhouette", () => {
    const withoutStray = buildFitviewModelFromStudio(
      [{ walls: black22Ground(), items: [] }],
      new Map(),
    )!;
    const withStray = buildFitviewModelFromStudio(
      [{ walls: [...black22Ground(), wall(400, 300, 700, 300, 300)], items: [] }],
      new Map(),
    )!;
    const strip = (m: { model: Record<string, unknown> }) => {
      const b = m.model.building as Record<string, unknown>;
      const { interiorWalls: _interiorWalls, ...rest } = b;
      return rest;
    };
    expect(JSON.stringify(strip(withStray))).toBe(JSON.stringify(strip(withoutStray)));
  });
});

describe("W3: interior walls are carried and flagged, not dropped", () => {
  it("interiorSegments finds the one edge outerPolygons' walk didn't consume", () => {
    const segs = interiorSegments(black22GroundWithInterior());
    expect(segs).toHaveLength(1);
    expect(segs[0].heightM).toBeCloseTo(3, 6); // 300cm wall
    // Endpoints are the divider's, in metres.
    const pts = [segs[0].a, segs[0].b].map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).sort();
    expect(pts).toEqual(["9.00,0.00", "9.00,6.00"]);
  });

  it("a free-standing wall with no loop at all is also carried, not dropped", () => {
    const segs = interiorSegments([...black22Ground(), wall(400, 300, 700, 300, 300)]);
    expect(segs).toHaveLength(1);
  });

  it("a pure box has no interior segments", () => {
    expect(interiorSegments(black22Ground())).toHaveLength(0);
  });

  it("buildFitviewModelFromStudio's building.interiorWalls carries the flagged strip", () => {
    const out = buildFitviewModelFromStudio(
      [{ walls: black22GroundWithInterior(), items: [] }],
      new Map(),
    )!;
    const building = out.model.building as {
      interiorWalls: { name: string; interior: boolean; story: number; heightM: number }[];
    };
    expect(building.interiorWalls).toHaveLength(1);
    expect(building.interiorWalls[0].interior).toBe(true);
    expect(building.interiorWalls[0].name).toBe("Interior 1");
    expect(building.interiorWalls[0].story).toBe(1);
  });

  it("a unit placed near the interior wall matches onto it, past the exterior edges", () => {
    const out = buildFitviewModelFromStudio(
      [
        {
          walls: black22GroundWithInterior(),
          items: [
            {
              // Exterior loop has 4 edges (s0..s3); the interior wall is s4.
              // Sitting right on the interior wall's midpoint (9m, 1.5m sill, 6m).
              position: { x: 900, y: 150, z: 300 },
              metadata: {
                itemName: "custom-1",
                unitConfig: { heightMm: 1200, panels: [{ widthMm: 900 }], kind: "window" },
              },
            },
          ],
        },
      ],
      new Map(),
    )!;
    const windows = out.model.windows as { id: string; elev: string }[];
    expect(windows).toHaveLength(1);
    expect(windows[0].elev).toBe("s4");
  });

  it("a floor with only stray walls (no exterior mass) carries no interior walls — documented scope, not a regression", () => {
    const out = buildFitviewModelFromStudio(
      [
        { walls: black22Ground(), items: [] },
        { walls: [wall(0, 0, 100, 0, 250)], items: [] }, // all-stray upper floor
      ],
      new Map(),
    )!;
    const building = out!.model.building as { interiorWalls: unknown[] };
    expect(building.interiorWalls).toHaveLength(0);
  });
});

// studio-plans-through-floor (2026-09-01, owner: "highlight the walls we
// have exterior and interior when we make them so we can distinguish
// them"). classifyWalls is the per-wall counterpart of interiorSegments —
// same outer-loop test, just keyed by wall identity instead of returning
// loose segments — so the 2D floorplanner can color a wall (or an
// in-progress drag preview) live, in perfect agreement with what Publish
// ships.
describe("studio-plans-through-floor: classifyWalls tells exterior from interior per wall", () => {
  it("a rectangle plus one interior segment: 4 exterior, 1 interior", () => {
    // ONE array, ONE set of wall objects — classifyWalls keys its Map by
    // wall identity, so the walls looked up below must be the exact
    // objects passed in, not a fresh call to the fixture builder.
    const walls = black22GroundWithInterior();
    const classes = classifyWalls(walls);
    const values = [...classes.values()];
    expect(values.filter((c) => c === "exterior")).toHaveLength(4);
    expect(values.filter((c) => c === "interior")).toHaveLength(1);
    // The rectangle's own 4 sides (indices 0-3) are exterior; the divider
    // appended on top (index 4, black22GroundWithInterior's own shape) is
    // the one flagged interior.
    for (let i = 0; i < 4; i++) {
      expect(classes.get(walls[i])).toBe("exterior");
    }
    expect(classes.get(walls[4])).toBe("interior");
  });

  it("a pure box has every wall classified exterior", () => {
    const classes = classifyWalls(black22Ground());
    const values = [...classes.values()];
    expect(values.every((c) => c === "exterior")).toBe(true);
    expect(values).toHaveLength(4);
  });

  it("a free-standing 2-corner wall (no loop at all) classifies as interior", () => {
    const stray = wall(400, 300, 700, 300, 300);
    const classes = classifyWalls([...black22Ground(), stray]);
    expect(classes.get(stray)).toBe("interior");
  });

  it("a lone free-standing wall with nothing else on the floor is interior too", () => {
    const stray = wall(0, 0, 300, 0, 250);
    const classes = classifyWalls([stray]);
    expect(classes.get(stray)).toBe("interior");
  });
});
