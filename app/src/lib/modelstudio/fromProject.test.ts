// The seed must never mint coincident twin walls: adjacent masses trace the
// same boundary, and seeding it once per mass left a solid wall in front of
// every window on the shared line ("window hiding behind the wall").

import { describe, expect, it } from "vitest";
import { buildStudioPull, buildStudioSeed, markKeyOf } from "./fromProject";
import type { ProjectMarkSpec } from "../install/specs";
import type { UnitConfig } from "./units";

interface Plan {
  corners: Record<string, { x: number; y: number }>;
  walls: { corner1: string; corner2: string }[];
}

function planOf(seed: { serialized: string }): Plan {
  return (JSON.parse(seed.serialized) as { floorplan: Plan }).floorplan;
}

function job(footprints: { x: number; z: number }[][]) {
  return { building: { footprints }, windows: [] };
}

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

function spec(mark: string, wIn: number, hIn: number, operation: string): ProjectMarkSpec {
  return {
    mark_code: mark, style: null, glass: null, color: null, size_code: null,
    width_in: wIn, height_in: hIn, operation, tempered: null, egress: null,
    u_factor: null, shgc: null, grids: null, screen: null, product_line: null,
    extra: null, image_page: null, image_bbox: null, planset_id: null,
    confirmed: true, source: "manual",
    id: mark, project_id: "p", created_at: "", updated_at: "",
  };
}

describe("buildStudioPull", () => {
  const jobWith = (windows: unknown[]) => ({
    building: { footprints: [rect(0, 0, 10, 6)] },
    windows,
  });
  const win = (id: string, x = 3) => ({
    id, elev: "s0", x, y: 0.9, w: 1800, h: 1500,
  });

  it("places EVERY window (no 8 cap), parametric from its spec", () => {
    const windows = Array.from({ length: 12 }, (_, i) => win(`${i + 1}`, i * 0.7));
    const out = buildStudioPull(
      jobWith(windows) as never,
      [spec("3", 72, 60, "XO")],
      new Set(),
    );
    expect(out.placements).toHaveLength(12);
    const three = out.placements.find((p) => p.itemName === "3")!;
    expect(three.config.panels).toHaveLength(2); // XO = slider + fixed
    expect(three.config.panels[0].mechanism).toBe("slider");
    // Un-specced marks still land parametric from their plan size.
    expect(out.placements[0].config.panels[0].widthMm).toBe(1800);
  });

  it("is ADD-ONLY: already-placed marks are skipped and counted", () => {
    const out = buildStudioPull(
      jobWith([win("1"), win("2")]) as never,
      [],
      new Set(["1"]),
    );
    expect(out.placements.map((p) => p.itemName)).toEqual(["2"]);
    expect(out.alreadyPlaced).toBe(1);
  });

  it("prefers the refined catalog unit over the raw spec", () => {
    const refined: UnitConfig = {
      kind: "window",
      heightMm: 4559,
      panels: [768, 2248, 2286, 2229, 432].map((widthMm) => ({
        widthMm, mechanism: "fixed" as const,
      })),
      cornerAfterPanel: 0,
    };
    const out = buildStudioPull(
      jobWith([win("16-1")]) as never,
      [spec("16", 313.5, 179.5, "Fixed")],
      new Set(),
      new Map([["16", refined]]),
    );
    expect(out.placements[0].config.panels).toHaveLength(5);
    expect(out.placements[0].config.cornerAfterPanel).toBe(0);
  });

  it("maps stories to floors with floor-relative sills", () => {
    const job = {
      building: {
        footprints: [rect(0, 0, 10, 6)],
        stories: [
          { n: 1, elevM: 0, heightM: 3, footprints: [rect(0, 0, 10, 6)] },
          { n: 2, elevM: 3, heightM: 2.5, footprints: [rect(0, 0, 10, 6)] },
        ],
      },
      // s4 = first edge of story 2's footprint; absolute sill 3.9 m.
      windows: [{ id: "up", elev: "s4", x: 3, y: 3.9, w: 1200, h: 1000 }],
    };
    const out = buildStudioPull(job as never, [], new Set());
    expect(out.placements).toHaveLength(1);
    expect(out.placements[0].floorIndex).toBe(1);
    // Floor-relative centre: (3.9 − 3.0) + 0.5 = 1.4 m.
    expect(out.placements[0].elevationCm).toBeCloseTo(140, 0);
  });

  it("slides a near-edge window inside its wall and flags too-small walls", () => {
    // s0 is 10 m. A 3 m window pinned at the very start must slide in;
    // a 12 m window can't fit and asks for the wall to grow.
    const out = buildStudioPull(
      jobWith([
        { id: "edge", elev: "s0", x: 0, y: 0.9, w: 3000, h: 1500 },
        { id: "toobig", elev: "s0", x: 1, y: 0.9, w: 12000, h: 1500 },
      ]) as never,
      [],
      new Set(),
    );
    const edge = out.placements.find((p) => p.itemName === "edge")!;
    expect(edge.shifted).toBe(true);
    // Centre sits at least half-width + margin from the wall start.
    expect(edge.xCm).toBeGreaterThanOrEqual(150 + 4);
    const toobig = out.placements.find((p) => p.itemName === "toobig")!;
    expect(toobig.lengthenWallCm).toBeGreaterThanOrEqual(200);
  });

  it("fits a corner unit by its MAIN leg — the wrap leg never inflates the wall demand", () => {
    // Window 16: main leg 7.195 m (the four panels after the corner), wrap
    // leg 0.768 m, total 7.963 m. A 7.5 m wall fits the main leg but NOT
    // the total — so any wall growth here means the wrap leg was wrongly
    // counted against the main wall.
    const corner16: UnitConfig = {
      kind: "window",
      heightMm: 4559,
      panels: [768, 2248, 2286, 2229, 432].map((widthMm) => ({
        widthMm, mechanism: "fixed" as const,
      })),
      cornerAfterPanel: 0,
    };
    const out = buildStudioPull(
      { building: { footprints: [rect(0, 0, 7.5, 6)] }, windows: [win("16-1", 0)] } as never,
      [],
      new Set(),
      new Map([["16", corner16]]),
    );
    const p = out.placements[0];
    expect(p.lengthenWallCm).toBeUndefined();
    // Pinned at x=0, the main leg's half-width (3.5975 m + 5 cm margin)
    // slides the centre in to ~3.65 m — a small legal shift, no growth.
    expect(p.shifted).toBe(true);
    expect(Math.abs(p.xCm - 364.75)).toBeLessThan(1);
  });

  it("snaps placements onto the studio's REAL walls when the frames drifted apart", () => {
    // The BLACK22 floaters: the saved studio plan was re-centred by the
    // vendor, so its walls live 30 m away from the plan's absolute frame.
    // Same 10×6 building, walls translated by (+3000, +1500) cm.
    const shift = { x: 3000, y: 1500 };
    const walls = [
      { x1: 0, y1: 0, x2: 1000, y2: 0 },
      { x1: 1000, y1: 0, x2: 1000, y2: 600 },
      { x1: 1000, y1: 600, x2: 0, y2: 600 },
      { x1: 0, y1: 600, x2: 0, y2: 0 },
    ].map((w) => ({
      x1: w.x1 + shift.x, y1: w.y1 + shift.y,
      x2: w.x2 + shift.x, y2: w.y2 + shift.y,
    }));
    const out = buildStudioPull(
      jobWith([win("a", 3), win("b", 7)]) as never,
      [],
      new Set(),
      new Map(),
      { walls, floorIndex: 0 },
    );
    expect(out.placements).toHaveLength(2);
    for (const p of out.placements) {
      // Landed ON a wall segment, not floating in the plan's old frame.
      const onWall = walls.some((w) => {
        const wx = w.x2 - w.x1;
        const wy = w.y2 - w.y1;
        const len = Math.hypot(wx, wy);
        const t = ((p.xCm - w.x1) * wx + (p.yCm - w.y1) * wy) / (len * len);
        const d = Math.hypot(p.xCm - (w.x1 + wx * t), p.yCm - (w.y1 + wy * t));
        return t >= 0 && t <= 1 && d < 1;
      });
      expect(onWall).toBe(true);
    }
  });

  it("snap survives a scale drift and adopts the wall's own angle", () => {
    // Studio walls at 2× the plan's size (an uncalibrated seed the owner
    // kept): windows still land on the walls, rotated to match them.
    const walls = [
      { x1: 0, y1: 0, x2: 2000, y2: 0 },
      { x1: 2000, y1: 0, x2: 2000, y2: 1200 },
      { x1: 2000, y1: 1200, x2: 0, y2: 1200 },
      { x1: 0, y1: 1200, x2: 0, y2: 0 },
    ];
    const out = buildStudioPull(
      jobWith([win("a", 3)]) as never,
      [],
      new Set(),
      new Map(),
      { walls, floorIndex: 0 },
    );
    const p = out.placements[0];
    // Landed ON one of the 2×-frame walls, inside its span.
    const hit = walls.find((w) => {
      const wx = w.x2 - w.x1;
      const wy = w.y2 - w.y1;
      const len = Math.hypot(wx, wy);
      const t = ((p.xCm - w.x1) * wx + (p.yCm - w.y1) * wy) / (len * len);
      const d = Math.hypot(p.xCm - (w.x1 + wx * t), p.yCm - (w.y1 + wy * t));
      return t >= 0 && t <= 1 && d < 1;
    });
    expect(hit).toBeTruthy();
    // Rotation is wall-aligned (an axis wall → rotation ≡ 0 mod π/2).
    const hx = hit!.x2 - hit!.x1;
    expect(
      Math.abs(hx !== 0 ? Math.sin(p.rotation) : Math.cos(p.rotation)),
    ).toBeLessThan(0.01);
  });

  it("a window with no plausible wall BRINGS its plan wall with it", () => {
    // One lonely far-away wall running the WRONG direction: nothing to
    // land on → the pull emits the plan's own edge as a NEW wall and
    // places the window on it — never skipped, never floating.
    const walls = [{ x1: 5000, y1: 5000, x2: 5000, y2: 5600 }];
    const out = buildStudioPull(
      jobWith([win("a", 3), win("b", 6)]) as never,
      [],
      new Set(),
      new Map(),
      { walls, floorIndex: 0 },
    );
    expect(out.placements).toHaveLength(2);
    expect(out.noWall).toBe(0);
    // Both windows share one elevation edge → the wall is emitted ONCE.
    const withWall = out.placements.filter((p) => p.newWall);
    expect(withWall).toHaveLength(1);
    const seg = withWall[0].newWall!;
    // Each window sits ON the emitted segment.
    for (const p of out.placements) {
      const dx = seg.x2 - seg.x1;
      const dy = seg.y2 - seg.y1;
      const len = Math.hypot(dx, dy);
      const t = ((p.xCm - seg.x1) * dx + (p.yCm - seg.y1) * dy) / (len * len);
      const d = Math.hypot(p.xCm - (seg.x1 + dx * t), p.yCm - (seg.y1 + dy * t));
      expect(d).toBeLessThan(1);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it("wall runs: a wide window fits ACROSS collinear jagged segments", () => {
    // A 10 m straight side drawn as four short collinear walls (a jagged
    // trace): a 5 m window centred at a joint must fit the RUN — no slide
    // to a single segment, no bogus wall growth.
    const walls = [
      { x1: 0, y1: 0, x2: 250, y2: 0 },
      { x1: 250, y1: 0, x2: 520, y2: 0 },
      { x1: 520, y1: 0, x2: 800, y2: 0 },
      { x1: 800, y1: 0, x2: 1000, y2: 0 },
      { x1: 1000, y1: 0, x2: 1000, y2: 600 },
    ];
    const out = buildStudioPull(
      jobWith([{ id: "wide", elev: "s0", x: 2.5, y: 0.9, w: 5000, h: 1500 }]) as never,
      [],
      new Set(),
      new Map(),
      { walls, floorIndex: 0 },
    );
    const p = out.placements[0];
    expect(p.lengthenWallCm).toBeUndefined();
    expect(p.newWall).toBeUndefined();
    expect(p.yCm).toBeCloseTo(0, 1); // on the merged run
    expect(p.xCm).toBeGreaterThan(250);
    expect(p.xCm).toBeLessThan(750);
  });

  it("counts windows whose wall key resolves nowhere", () => {
    const out = buildStudioPull(
      jobWith([{ id: "x", elev: "s99", x: 1, y: 1, w: 900, h: 900 }]) as never,
      [],
      new Set(),
    );
    expect(out.placements).toHaveLength(0);
    expect(out.noWall).toBe(1);
  });

  it("markKeyOf folds every dialect onto the base mark", () => {
    expect(markKeyOf("16-2")).toBe("16");
    expect(markKeyOf("16B")).toBe("16");
    expect(markKeyOf("12@L3")).toBe("12");
  });
});

describe("buildStudioSeed wall dedupe", () => {
  it("keeps a lone mass as 4 corners and 4 walls", () => {
    const plan = planOf(buildStudioSeed(job([rect(0, 0, 10, 6)])));
    expect(Object.keys(plan.corners)).toHaveLength(4);
    expect(plan.walls).toHaveLength(4);
  });

  it("merges the shared boundary of two adjacent masses into one wall", () => {
    // Two rooms side by side sharing the x=10 edge: 6 distinct corners,
    // 7 walls — NOT 8 corners and 8 walls with a twin on the shared line.
    const plan = planOf(
      buildStudioSeed(job([rect(0, 0, 10, 6), rect(10, 0, 18, 6)])),
    );
    expect(Object.keys(plan.corners)).toHaveLength(6);
    expect(plan.walls).toHaveLength(7);
  });

  it("snaps near-identical corners from imprecise traces", () => {
    // The second mass's shared corners are traced 1 cm off — still one wall.
    const plan = planOf(
      buildStudioSeed(
        job([
          rect(0, 0, 10, 6),
          [
            { x: 10.01, z: 0.01 },
            { x: 18, z: 0 },
            { x: 18, z: 6 },
            { x: 10.01, z: 5.99 },
          ],
        ]),
      ),
    );
    expect(Object.keys(plan.corners)).toHaveLength(6);
    expect(plan.walls).toHaveLength(7);
  });

  it("collapses zero-length segments left by the snap", () => {
    // A sliver polygon whose two ends snap to the same corner never emits a
    // zero-length wall (blueprint chokes on those).
    const plan = planOf(
      buildStudioSeed(
        job([
          [
            { x: 0, z: 0 },
            { x: 0.01, z: 0.01 },
            { x: 10, z: 0 },
            { x: 5, z: 6 },
          ],
        ]),
      ),
    );
    for (const w of plan.walls) {
      expect(w.corner1).not.toBe(w.corner2);
    }
  });
});
