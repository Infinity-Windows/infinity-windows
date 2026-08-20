// Planning half only — see elevationRender.ts's own header for why the
// capture half (renderWallElevation) has no tests here.

import { describe, expect, it } from "vitest";
import { findMarkWall, frameForWall, type WallSegment } from "./elevationRender";
import type { JobModel } from "./projects";
import type { UnitConfig } from "./units";

interface ItemFixture {
  x: number;
  y: number;
  z: number;
  rotation?: number;
  name: string;
  unitConfig?: UnitConfig;
}

/** A rectangular floor, corners a→b→c→d, with the given items dropped in
 * plan space. Same shape floors.test.ts's rectFloor builds, extended with
 * items since this module's planning half is the first thing in the Studio
 * to actually read them back out. */
function rectFloorWithItems(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  heightCm: number,
  items: ItemFixture[],
): string {
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
  return JSON.stringify({
    floorplan: { corners, walls },
    items: items.map((it) => ({
      xpos: it.x,
      ypos: it.y,
      zpos: it.z,
      rotation: it.rotation ?? 0,
      item_name: it.name,
      metadata: it.unitConfig ? { unitConfig: it.unitConfig } : {},
    })),
  });
}

const SAMPLE_CONFIG: UnitConfig = {
  kind: "window",
  heightMm: 1200,
  panels: [{ widthMm: 600, mechanism: "fixed" }, { widthMm: 600, mechanism: "fixed" }],
};

describe("findMarkWall", () => {
  it("locates a mark on the wall its item sits nearest to", () => {
    // 10m x 6m building; the item sits 5cm proud of the SOUTH wall (a-b, y=0).
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 5, z: 150, name: "Window 4A", unitConfig: SAMPLE_CONFIG },
    ]);
    const model: JobModel = { floors: [floor] };

    const found = findMarkWall(model, "4A");
    expect(found).not.toBeNull();
    expect(found!.floorIndex).toBe(0);
    expect(found!.wall).toEqual({
      x1: 0,
      y1: 0,
      x2: 1000,
      y2: 0,
      heightCm: 300,
      // South wall of a building spanning y=0..600 faces AWAY from the
      // interior — negative y/z.
      outwardNormal: { x: 0, z: -1 },
    });
  });

  it("matches the mark case-insensitively and ignores surrounding whitespace", () => {
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 0, z: 150, name: "Door 12" },
    ]);
    const model: JobModel = { floors: [floor] };
    expect(findMarkWall(model, "  12  ")).not.toBeNull();
    expect(findMarkWall(model, "door 12" /* not a mark at all */)).toBeNull();
  });

  it("reports the item's own rectangle along the wall", () => {
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 0, z: 150, name: "Window 4A", unitConfig: SAMPLE_CONFIG },
    ]);
    const model: JobModel = { floors: [floor] };
    const found = findMarkWall(model, "4A");
    // Panels sum to 1200mm wide = 120cm; heightMm 1200 = 120cm tall;
    // centred at z=150cm, so the sill sits at 150 - 60 = 90cm.
    expect(found!.unitRect).toEqual({ xCm: 300, sillCm: 90, widthCm: 120, heightCm: 120 });
  });

  it("falls back to a default size when the item has no unitConfig", () => {
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 0, z: 150, name: "Window 9" },
    ]);
    const model: JobModel = { floors: [floor] };
    const found = findMarkWall(model, "9");
    expect(found!.unitRect.widthCm).toBe(90);
    expect(found!.unitRect.heightCm).toBe(120);
  });

  it("finds a mark on the second floor when it isn't on the first", () => {
    const ground = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 0, z: 150, name: "Window 1" },
    ]);
    const upper = rectFloorWithItems(0, 0, 800, 500, 250, [
      { x: 200, y: 500, z: 130, name: "Window 2" },
    ]);
    const model: JobModel = { floors: [ground, upper] };
    const found = findMarkWall(model, "2");
    expect(found!.floorIndex).toBe(1);
    expect(found!.wall.heightCm).toBe(250);
  });

  it("returns null for a mark the model doesn't have", () => {
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 0, z: 150, name: "Window 1" },
    ]);
    expect(findMarkWall({ floors: [floor] }, "99")).toBeNull();
  });

  it("returns null for an item nowhere near any wall (stray/unattached)", () => {
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 300, z: 150, name: "Window 1" }, // dead center of the room
    ]);
    expect(findMarkWall({ floors: [floor] }, "1")).toBeNull();
  });

  it("returns null when the model has no floors at all", () => {
    expect(findMarkWall({}, "1")).toBeNull();
    expect(findMarkWall({ serialized: undefined, floors: [] }, "1")).toBeNull();
  });

  it("returns null for a blank mark code", () => {
    const floor = rectFloorWithItems(0, 0, 1000, 600, 300, [
      { x: 300, y: 0, z: 150, name: "Window 1" },
    ]);
    expect(findMarkWall({ floors: [floor] }, "   ")).toBeNull();
  });
});

describe("frameForWall", () => {
  const wall: WallSegment = {
    x1: 0,
    y1: 0,
    x2: 1000,
    y2: 0,
    heightCm: 300,
    outwardNormal: { x: 0, z: -1 },
  };

  it("centres the camera on the wall, backed off along its outward normal", () => {
    const frame = frameForWall(wall);
    expect(frame.lookAt).toEqual({ x: 500, y: 150, z: 0 });
    // standoff = max(length, height, 100) = max(1000, 300, 100) = 1000
    expect(frame.position).toEqual({ x: 500, y: 150, z: -1000 });
  });

  it("pads the frustum by the margin on every side (default 10%)", () => {
    const frame = frameForWall(wall);
    expect(frame.left).toBeCloseTo(-550);
    expect(frame.right).toBeCloseTo(550);
    expect(frame.top).toBeCloseTo(165);
    expect(frame.bottom).toBeCloseTo(-165);
  });

  it("a zero margin frames exactly the wall's own bounds", () => {
    const frame = frameForWall(wall, 0);
    expect(frame.left).toBe(-500);
    expect(frame.right).toBe(500);
    expect(frame.top).toBe(150);
    expect(frame.bottom).toBe(-150);
  });

  it("keeps the far plane well past the camera's standoff", () => {
    const frame = frameForWall(wall);
    expect(frame.near).toBeGreaterThan(0);
    expect(frame.far).toBeGreaterThan(frame.near);
    expect(frame.far).toBeGreaterThan(1000);
  });

  it("frames a wall on a diagonal the same way — length and normal both rotate", () => {
    // A 3-4-5 wall: length 500cm, running from (0,0) to (300,400).
    const diagonal: WallSegment = {
      x1: 0,
      y1: 0,
      x2: 300,
      y2: 400,
      heightCm: 240,
      outwardNormal: { x: 0.8, z: -0.6 }, // unit-length, perpendicular to (300,400)
    };
    const frame = frameForWall(diagonal, 0);
    expect(frame.right - frame.left).toBeCloseTo(500);
    expect(frame.top - frame.bottom).toBeCloseTo(240);
    expect(frame.lookAt).toEqual({ x: 150, y: 120, z: 200 });
  });
});
