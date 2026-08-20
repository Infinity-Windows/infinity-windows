// Synthetic geometries only — a box, an L, two disconnected loops, and the
// cross-wall drop cases the owner's drag spec calls out by name. No vendor
// model involved (see flatElevations.ts's header on why).

import { describe, expect, it } from "vitest";
import {
  BUILDING_GAP_PX,
  dropTarget,
  flatLayout,
  wallWalkOrder,
  WALL_GAP_PX,
  type FlatCorner,
  type FlatLayoutWallInput,
  type FlatWall,
} from "./flatElevations";

/** A closed rectangle's corners+walls, ids prefixed so two boxes never
 * collide when combined in one test. */
function box(prefix: string, w: number, h: number, heightCm = 250) {
  const corners: FlatCorner[] = [
    { id: `${prefix}a`, x: 0, y: 0 },
    { id: `${prefix}b`, x: w, y: 0 },
    { id: `${prefix}c`, x: w, y: h },
    { id: `${prefix}d`, x: 0, y: h },
  ];
  const ids = corners.map((c) => c.id);
  const walls: FlatWall[] = ids.map((id, i) => ({
    id: `${prefix}w${i}`,
    corner1: id,
    corner2: ids[(i + 1) % ids.length],
    heightCm,
  }));
  return { corners, walls };
}

describe("wallWalkOrder", () => {
  it("walks a box in order, none reversed", () => {
    const { corners, walls } = box("r", 1000, 600);
    const walked = wallWalkOrder(corners, walls);
    expect(walked.map((w) => w.id)).toEqual(["rw0", "rw1", "rw2", "rw3"]);
    expect(walked.every((w) => !w.reversed)).toBe(true);
    expect(walked.every((w) => w.loop === 0)).toBe(true);
  });

  it("walks an L-shaped perimeter as one loop", () => {
    const corners: FlatCorner[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 1200, y: 0 },
      { id: "c", x: 1200, y: 600 },
      { id: "d", x: 600, y: 600 },
      { id: "e", x: 600, y: 1200 },
      { id: "f", x: 0, y: 1200 },
    ];
    const ids = corners.map((c) => c.id);
    const walls: FlatWall[] = ids.map((id, i) => ({
      id: `w${i}`,
      corner1: id,
      corner2: ids[(i + 1) % ids.length],
      heightCm: 260,
    }));
    const walked = wallWalkOrder(corners, walls);
    expect(walked).toHaveLength(6);
    expect(walked.map((w) => w.id)).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);
    expect(walked.every((w) => w.loop === 0 && !w.reversed)).toBe(true);
  });

  it("numbers two disconnected loops as two buildings", () => {
    const boxA = box("a", 1000, 600);
    const boxB = box("b", 800, 500);
    const walked = wallWalkOrder(
      [...boxA.corners, ...boxB.corners],
      [...boxA.walls, ...boxB.walls],
    );
    expect(walked).toHaveLength(8);
    const loopOf = (id: string) => walked.find((w) => w.id === id)?.loop;
    expect(["aw0", "aw1", "aw2", "aw3"].map(loopOf)).toEqual([0, 0, 0, 0]);
    expect(["bw0", "bw1", "bw2", "bw3"].map(loopOf)).toEqual([1, 1, 1, 1]);
    // Each building's own walls stay contiguous and in walk order — a
    // multi-mass building must never interleave (the map's flat view had
    // exactly this bug before it grouped polygon-major).
    expect(walked.map((w) => w.id)).toEqual([
      "aw0", "aw1", "aw2", "aw3", "bw0", "bw1", "bw2", "bw3",
    ]);
  });

  it("reconstructs an OPEN chain in order even when the walk starts mid-run", () => {
    // a-b, b-c, c-d, given to the walk as [b-c, a-b, c-d] — deliberately
    // starting from the middle wall.
    const corners: FlatCorner[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 500, y: 0 },
      { id: "c", x: 1000, y: 0 },
      { id: "d", x: 1000, y: 400 },
    ];
    const walls: FlatWall[] = [
      { id: "bc", corner1: "b", corner2: "c", heightCm: 250 },
      { id: "ab", corner1: "a", corner2: "b", heightCm: 250 },
      { id: "cd", corner1: "c", corner2: "d", heightCm: 250 },
    ];
    const walked = wallWalkOrder(corners, walls);
    expect(walked.map((w) => w.id)).toEqual(["ab", "bc", "cd"]);
    expect(walked.every((w) => !w.reversed)).toBe(true);
  });

  it("flags a wall stored backwards as reversed, and still closes the loop", () => {
    const { corners, walls } = box("r", 1000, 600);
    // r-w2 is naturally (c,d); store it (d,c) instead — same wall, opposite
    // stored direction, the way a hand-drawn wall could land either way.
    const backwards = walls.map((w) =>
      w.id === "rw2" ? { ...w, corner1: w.corner2, corner2: w.corner1 } : w,
    );
    const walked = wallWalkOrder(corners, backwards);
    expect(walked.map((w) => w.id)).toEqual(["rw0", "rw1", "rw2", "rw3"]);
    expect(walked.find((w) => w.id === "rw2")?.reversed).toBe(true);
    expect(walked.filter((w) => w.id !== "rw2").every((w) => !w.reversed)).toBe(true);
  });

  it("ignores a wall whose corner id doesn't exist, rather than throwing", () => {
    const corners: FlatCorner[] = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 500, y: 0 },
    ];
    const walls: FlatWall[] = [{ id: "ghost", corner1: "a", corner2: "missing", heightCm: 250 }];
    expect(wallWalkOrder(corners, walls)).toEqual([]);
  });
});

describe("flatLayout", () => {
  const wallInput = (
    id: string,
    lengthCm: number,
    opts: Partial<FlatLayoutWallInput> = {},
  ): FlatLayoutWallInput => ({
    id,
    lengthCm,
    heightCm: 250,
    loop: 0,
    reversed: false,
    items: [],
    ...opts,
  });

  it("sizes panels by lengthCm/heightCm × scale, left to right", () => {
    const layout = flatLayout([wallInput("w0", 1000), wallInput("w1", 400, { heightCm: 300 })], 0.1);
    expect(layout.scale).toBe(0.1);
    expect(layout.panels[0]).toMatchObject({ wallId: "w0", x: 0, width: 100, height: 25 });
    expect(layout.panels[1]).toMatchObject({
      wallId: "w1",
      x: 100 + WALL_GAP_PX,
      width: 40,
      height: 30,
    });
    expect(layout.maxHeight).toBe(30);
    expect(layout.totalWidth).toBe(100 + WALL_GAP_PX + 40);
  });

  it("opens a wider gap between two buildings than between two walls", () => {
    const layout = flatLayout(
      [wallInput("w0", 500, { loop: 0 }), wallInput("w1", 500, { loop: 1 })],
      1,
    );
    expect(layout.panels[1].x).toBe(500 + BUILDING_GAP_PX);
    expect(BUILDING_GAP_PX).toBeGreaterThan(WALL_GAP_PX);
  });

  it("places an item at its true offset and size, measured down from the top", () => {
    const layout = flatLayout(
      [
        wallInput("w0", 1000, {
          heightCm: 250,
          items: [
            {
              id: "u1",
              name: "Window 1",
              kind: "window",
              offsetFromCorner1Cm: 200,
              widthCm: 120,
              heightCm: 150,
              sillCm: 90,
            },
          ],
        }),
      ],
      1,
    );
    const item = layout.panels[0].items[0];
    expect(item.rect.x).toBe(200); // offset from THIS wall's own left edge
    expect(item.rect.width).toBe(120);
    expect(item.rect.height).toBe(150);
    // top-of-panel is the wall's head; sill 90 + height 150 = 240 up from
    // the floor, so the rect starts 250 - 240 = 10 down from the panel top.
    expect(item.rect.y).toBe(10);
  });

  it("flips an item's offset for a wall walked in reverse", () => {
    const layout = flatLayout(
      [
        wallInput("w0", 1000, {
          reversed: true,
          items: [
            {
              id: "u1",
              name: "Door 1",
              kind: "door",
              offsetFromCorner1Cm: 200, // 200 from corner1 in STORED direction
              widthCm: 100,
              heightCm: 210,
              sillCm: 0,
            },
          ],
        }),
      ],
      1,
    );
    // Displayed left = length - rawLeft - width = 1000 - 200 - 100 = 700.
    expect(layout.panels[0].items[0].rect.x).toBe(700);
  });
});

describe("dropTarget", () => {
  /** Two same-building panels: [0,500) then a WALL_GAP_PX gap, then
   * [500+gap, 500+gap+300) — scale 1 so px === cm for readable assertions. */
  const layout = flatLayout(
    [
      { id: "w0", lengthCm: 500, heightCm: 250, loop: 0, reversed: false, items: [] },
      { id: "w1", lengthCm: 300, heightCm: 250, loop: 0, reversed: false, items: [] },
    ],
    1,
  );

  it("returns null for an empty layout", () => {
    expect(dropTarget(flatLayout([], 1), 50, 100)).toBeNull();
  });

  it("lands inside the wall the drag is over", () => {
    const t = dropTarget(layout, 380, 100); // item spans [380,480], well inside w0
    expect(t).toEqual({ wallId: "w0", offsetCm: 380 });
  });

  it("clamps to the wall's start when dragged past its left edge", () => {
    const t = dropTarget(layout, -200, 100);
    expect(t).toEqual({ wallId: "w0", offsetCm: 0 });
  });

  it("clamps to the wall's end minus the item's width, not off the end", () => {
    // Left edge 450 + item width 100 → centered exactly on w0's end (500),
    // so it's still w0's drag, just one that would overhang past its wall.
    const t = dropTarget(layout, 450, 100);
    expect(t?.wallId).toBe("w0");
    expect(t?.offsetCm).toBe(400); // 500 - 100
  });

  it("re-homes onto the adjacent panel once the drag crosses the boundary", () => {
    // Item centered well inside w1's span once its left edge passes 470.
    const t = dropTarget(layout, 470 + 60, 100);
    expect(t?.wallId).toBe("w1");
    // 470+60=530, w1 starts at 500+WALL_GAP_PX=514, so local left = 16.
    expect(t?.offsetCm).toBe(530 - (500 + WALL_GAP_PX));
  });

  it("a drag left in the gap between panels still lands on the nearer wall, not stuck", () => {
    const gapMid = 500 + WALL_GAP_PX / 2 - 50; // left edge so the CENTER sits mid-gap
    const t = dropTarget(layout, gapMid, 100);
    expect(["w0", "w1"]).toContain(t?.wallId);
    expect(t?.offsetCm).toBeGreaterThanOrEqual(0);
  });
});
