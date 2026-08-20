// Floors: back-compat parsing, stacking math, and the multi-floor publish
// conversion — BLACK22's shape (a big ground floor, one small section going
// up) must come out as stacked stories, windows on the right elevations.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOOR_CM,
  floorElevationsCm,
  floorHeightCm,
  parseFloorLite,
  parseFloors,
  parseRoof,
} from "./floors";
import { buildFitviewModelFromStudio } from "./toFitview";

const BLANK = JSON.stringify({
  floorplan: { corners: {}, walls: [], wallTextures: [], floorTextures: {}, newFloorTextures: {} },
  items: [],
});

/** Serialized rectangle floor, cm, with per-wall heights. */
function rectFloor(x0: number, y0: number, x1: number, y1: number, heightCm: number): string {
  const corners = {
    a: { x: x0, y: y0 },
    b: { x: x1, y: y0 },
    c: { x: x1, y: y1 },
    d: { x: x0, y: y1 },
  };
  const walls = [
    { corner1: "a", corner2: "b", height: heightCm },
    { corner1: "b", corner2: "c", height: heightCm },
    { corner1: "c", corner2: "d", height: heightCm },
    { corner1: "d", corner2: "a", height: heightCm },
  ];
  return JSON.stringify({ floorplan: { corners, walls }, items: [] });
}

describe("parseFloors back-compat", () => {
  it("a lone serialized string is a one-floor building", () => {
    expect(parseFloors({ serialized: "X" }, BLANK).floors).toEqual(["X"]);
    expect(parseFloors(null, BLANK).floors).toEqual([BLANK]);
  });
  it("floors[] wins and clamps at ten", () => {
    const floors = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(parseFloors({ floors }, BLANK).floors).toHaveLength(10);
  });
});

describe("parseRoof round trip (Studio 100x #49)", () => {
  it("reads back what was saved", () => {
    expect(parseRoof({ roof: "flat" })).toBe("flat");
    expect(parseRoof({ roof: "none" })).toBe("none");
  });
  it("defaults an old or blank save to none — today's shells, unchanged", () => {
    // A pre-#49 save shape: has `serialized`, no `roof` key at all.
    const oldSave: { serialized?: string; roof?: string } = { serialized: "X" };
    expect(parseRoof(oldSave)).toBe("none");
    expect(parseRoof(null)).toBe("none");
    expect(parseRoof({ roof: "garbage" })).toBe("none"); // unrecognized value, not a crash
  });
});

describe("stacking math", () => {
  it("reads walls + heights back out of a serialized plan", () => {
    const { walls } = parseFloorLite(rectFloor(0, 0, 1000, 600, 300));
    expect(walls).toHaveLength(4);
    expect(walls[0].height).toBe(300);
  });
  it("floors stand on the tallest walls below; empty floors use the default", () => {
    const floors = [rectFloor(0, 0, 1000, 600, 300), BLANK, rectFloor(0, 0, 400, 400, 250)];
    expect(floorHeightCm(parseFloorLite(floors[0]).walls)).toBe(300);
    expect(floorElevationsCm(floors)).toEqual([0, 300, 300 + DEFAULT_FLOOR_CM]);
  });
});

describe("multi-floor publish", () => {
  const liteToLike = (serialized: string) => {
    const { walls, items } = parseFloorLite(serialized);
    return {
      walls: walls.map((w) => ({
        height: w.height,
        getStartX: () => w.x1,
        getStartY: () => w.y1,
        getEndX: () => w.x2,
        getEndY: () => w.y2,
      })),
      items: items.map((it) => ({
        position: { x: it.x, y: it.y, z: it.z },
        rotation: { y: it.rotationY },
        metadata: it.metadata,
      })),
    };
  };

  it("stacks a small floor 2 on a big floor 1 (the BLACK22 shape)", () => {
    const ground = rectFloor(0, 0, 1800, 600, 300);
    const upper = rectFloor(1000, 0, 1800, 600, 250);
    const out = buildFitviewModelFromStudio(
      [liteToLike(ground), liteToLike(upper)],
      new Map(),
    )!;
    expect(out).not.toBeNull();
    const building = (out.model as { building: { stories: { elevM: number; heightM: number }[]; height: number } }).building;
    expect(building.stories).toHaveLength(2);
    expect(building.stories[0].elevM).toBe(0);
    expect(building.stories[1].elevM).toBeCloseTo(3, 6); // on floor 1's top
    expect(building.height).toBeCloseTo(5.5, 6);
  });

  it("puts an upper-floor window at its absolute elevation on its own wall", () => {
    const ground = rectFloor(0, 0, 1800, 600, 300);
    const upperSer = JSON.parse(rectFloor(1000, 0, 1800, 600, 250));
    upperSer.items = [
      {
        xpos: 1800, ypos: 120, zpos: 300, rotation: 0,
        item_name: "up-1",
        metadata: {
          unitConfig: { kind: "window", heightMm: 1500, panels: [{ widthMm: 1200 }] },
        },
      },
    ];
    const out = buildFitviewModelFromStudio(
      [liteToLike(ground), liteToLike(JSON.stringify(upperSer))],
      new Map(),
    )!;
    const wins = (out.model as { windows: { story: number; y: number }[] }).windows;
    expect(wins).toHaveLength(1);
    expect(wins[0].story).toBe(2); // second story, not the ground band
    // sill = (120cm centre − 75cm half) floor-relative → 0.45 m above ITS floor.
    expect(wins[0].y).toBeCloseTo(0.45, 2);
    expect((out.stats as { skippedWindows: number }).skippedWindows).toBe(0);
  });
});
