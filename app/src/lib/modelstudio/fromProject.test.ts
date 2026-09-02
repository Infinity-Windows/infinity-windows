// The seed must never mint coincident twin walls: adjacent masses trace the
// same boundary, and seeding it once per mass left a solid wall in front of
// every window on the shared line ("window hiding behind the wall").

import { describe, expect, it } from "vitest";
import {
  buildStudioFloorsSeed,
  buildStudioPull,
  buildStudioSeed,
  catalogByMarkFrom,
  formatPullToast,
  markKeyOf,
  resolveMarkConfig,
  type PullToastStats,
} from "./fromProject";
import { indexSpecsByMark } from "../install/specs";
import type { ProjectMarkSpec } from "../install/specs";
import { unitMarkLabel } from "./unitIdentity";
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

  describe("unpinned-spec fallback (Mad Moose, 2026-08-31)", () => {
    // adapter.ts's buildFitViewJob only puts a PINNED opening into
    // job.windows — by design, for the fit-view MAP. A job can carry a
    // traced outline and a full extracted schedule (real inch sizes, ten
    // marks) with not a single pin placed yet, and this used to walk an
    // EMPTY job.windows and report "0 placed" though nothing was wrong.

    it("places every specced mark, real spec sizes, even with zero pins", () => {
      const marks = Array.from({ length: 10 }, (_, i) =>
        spec(`${i + 1}`, 30 + i, 60, "Fixed"),
      );
      const out = buildStudioPull(jobWith([]) as never, marks, new Set());
      expect(out.placements).toHaveLength(10);
      expect(out.noWall).toBe(0);
      expect(out.alreadyPlaced).toBe(0);
      for (const m of marks) {
        const p = out.placements.find((pl) => pl.itemName === m.mark_code);
        expect(p).toBeDefined();
        expect(p!.fromSpec).toBe(true);
        expect(p!.config.panels[0].widthMm).toBeCloseTo(m.width_in! * 25.4, 0);
        expect(p!.config.heightMm).toBeCloseTo(m.height_in! * 25.4, 0);
        expect(p!.floorIndex).toBe(0);
      }
    });

    it("is deterministic — the same job pulls the same positions twice", () => {
      const marks = Array.from({ length: 6 }, (_, i) => spec(`${i + 1}`, 32, 48, "Fixed"));
      const a = buildStudioPull(jobWith([]) as never, marks, new Set());
      const b = buildStudioPull(jobWith([]) as never, marks, new Set());
      expect(a.placements.map((p) => [p.itemName, p.xCm, p.yCm, p.floorIndex, p.rotation])).toEqual(
        b.placements.map((p) => [p.itemName, p.xCm, p.yCm, p.floorIndex, p.rotation]),
      );
    });

    it("never doubles a mark that's already pinned — only the unpinned rest fall back", () => {
      // Mark "3" is pinned (in job.windows); marks 1, 2 and 4 have specs
      // but no pin. Mark 3 must land ONCE, from its real placement.
      const out = buildStudioPull(
        jobWith([win("3", 4)]) as never,
        [spec("1", 30, 48, "Fixed"), spec("2", 30, 48, "Fixed"), spec("3", 30, 48, "Fixed"), spec("4", 30, 48, "Fixed")],
        new Set(),
      );
      expect(out.placements).toHaveLength(4);
      expect(out.placements.filter((p) => p.itemName === "3")).toHaveLength(1);
      const three = out.placements.find((p) => p.itemName === "3")!;
      expect(three.fromSpec).toBeUndefined();
      for (const id of ["1", "2", "4"]) {
        const p = out.placements.find((pl) => pl.itemName === id)!;
        expect(p.fromSpec).toBe(true);
      }
    });

    it("a spec with no usable width/height is left out, not guessed", () => {
      const noSize: ProjectMarkSpec = { ...spec("9", 30, 48, "Fixed"), width_in: null, height_in: null };
      const out = buildStudioPull(jobWith([]) as never, [noSize], new Set());
      expect(out.placements).toHaveLength(0);
    });

    it("a pull with NO traced walls at all counts the marks as noWall, not silently dropped", () => {
      const out = buildStudioPull(
        { building: { footprints: [] }, windows: [] } as never,
        [spec("1", 30, 48, "Fixed")],
        new Set(),
      );
      expect(out.placements).toHaveLength(0);
      expect(out.noWall).toBe(1);
    });

    it("still snaps onto the studio's real walls when a frame is given", () => {
      const walls = [
        { x1: 0, y1: 0, x2: 1000, y2: 0 },
        { x1: 1000, y1: 0, x2: 1000, y2: 600 },
        { x1: 1000, y1: 600, x2: 0, y2: 600 },
        { x1: 0, y1: 600, x2: 0, y2: 0 },
      ];
      const out = buildStudioPull(
        jobWith([]) as never,
        [spec("1", 30, 48, "Fixed"), spec("2", 30, 48, "Fixed")],
        new Set(),
        new Map(),
        { walls, floorIndex: 0 },
      );
      expect(out.placements).toHaveLength(2);
      for (const p of out.placements) {
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
  });

  describe("interior walls from the hand-read model (Mad Moose, 2026-09-02)", () => {
    // The owner: "i drew the interior walls, add the 3 missing on the
    // interior wall." Real Mad Moose numbers (project 08c60cce-…): the
    // studio plan Isaac saved (cm, x east / y south) with the bay wall and
    // the office glass wall drawn by hand over the plan underlay, and the
    // hand-read fit-view model (centred metres) whose Add-1/2/3 sit on the
    // glass wall — elevation key s9 (two stories × 4 exterior edges =
    // s0…s7, then s8 bay wall, s9 glass wall).
    const MM_FOOTPRINT = [
      { x: -15.94, z: 12.25 },
      { x: 15.92, z: 12.17 },
      { x: 15.94, z: -12.25 },
      { x: -15.83, z: -12.25 },
    ];
    const BAY_WALL = {
      name: "Bay wall", x1: 1.23, z1: -12.17, x2: 1.35, z2: 12.19,
      story: 1, heightM: 3.35, elevM: 0, interior: true,
    };
    const GLASS_WALL = {
      name: "Office glass wall", x1: 5.45, z1: -0.09, x2: 5.51, z2: -12.08,
      story: 1, heightM: 3.35, elevM: 0, interior: true,
    };
    const ADDS = [
      { id: "Add-1", elev: "s9", x: 0.11, y: 0.03, w: 3288, h: 2425 },
      { id: "Add-2", elev: "s9", x: 3.66, y: 0.03, w: 4457, h: 2425 },
      { id: "Add-3", elev: "s9", x: 8.31, y: 0.03, w: 3416, h: 2425 },
    ];
    const readModel = (windows: unknown[] = ADDS, interiorWalls = [BAY_WALL, GLASS_WALL]) => ({
      building: {
        footprints: [MM_FOOTPRINT],
        stories: [
          { n: 1, elevM: 0, heightM: 3.35, footprints: [MM_FOOTPRINT] },
          { n: 2, elevM: 3.35, heightM: 4.27, footprints: [MM_FOOTPRINT] },
        ],
        interiorWalls,
      },
      windows,
    });
    // The plans job: same traced outline, and NO pinned Adds (a pin is a
    // point on the exterior outline; a partition unit can never have one).
    const plansJob = (windows: unknown[] = []) => ({
      building: { footprints: [MM_FOOTPRINT] },
      windows,
    });
    const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });
    const EXTERIOR = [
      seg(-1594, 1225, 137, 1221),
      seg(137, 1221, 1592, 1217),
      seg(1592, 1217, 1594, -1225),
      seg(1594, -1225, 131, -1225),
      seg(131, -1225, -1583, -1225),
      seg(-1583, -1225, -1594, 1225),
    ];
    const BAY_DRAWN = [seg(137, 1221, 134, -22), seg(134, -22, 131, -1225)];
    const GLASS_DRAWN = seg(549, -1204, 549, -22);
    const CROSS_DRAWN = seg(549, -22, 134, -22);
    const STUDIO_WALLS = [...EXTERIOR, ...BAY_DRAWN, GLASS_DRAWN, CROSS_DRAWN];
    const addSpecs = ADDS.map((a) => spec(a.id, a.w / 25.4, a.h / 25.4, "Fixed"));
    const onSeg = (p: { xCm: number; yCm: number }, s: { x1: number; y1: number; x2: number; y2: number }) => {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy);
      const t = ((p.xCm - s.x1) * dx + (p.yCm - s.y1) * dy) / (len * len);
      const d = Math.hypot(p.xCm - (s.x1 + dx * t), p.yCm - (s.y1 + dy * t));
      return t >= 0 && t <= 1 && d < 1;
    };

    it("lands all three Adds on the glass wall Isaac drew, in order, from the read plans", () => {
      const out = buildStudioPull(
        plansJob() as never,
        addSpecs,
        new Set(),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
        readModel() as never,
      );
      expect(out.alreadyPlaced).toBe(0);
      expect(out.noWall).toBe(0);
      expect(out.placements.map((p) => p.itemName)).toEqual(["Add-1", "Add-2", "Add-3"]);
      for (const p of out.placements) {
        expect(p.fromRead).toBe(true);
        expect(p.fromSpec).toBeUndefined(); // the spread never touched them
        expect(p.newWall).toBeUndefined();
        expect(p.floorIndex).toBe(0);
        // ON the x=549 run, strictly inside its span — never an exterior wall.
        expect(p.xCm).toBeCloseTo(549, 0);
        expect(p.yCm).toBeGreaterThan(-1204);
        expect(p.yCm).toBeLessThan(-22);
        expect(EXTERIOR.some((s) => onSeg(p, s))).toBe(false);
        // Rotation aligned to a north–south wall.
        expect(Math.abs(Math.cos(p.rotation))).toBeLessThan(0.01);
        // Real spec size, parametric.
        expect(p.config.panels).toHaveLength(1);
      }
      // Add-1 is the southern unit (nearest y=−22), Add-3 the northern.
      const [a1, a2, a3] = out.placements;
      expect(a1.yCm).toBeGreaterThan(a2.yCm);
      expect(a2.yCm).toBeGreaterThan(a3.yCm);
      // Read positions along the wall: Add-2 centred 5.9 m from the
      // south end, Add-3 10 m — the glass wall's own numbers, in cm.
      expect(a2.yCm).toBeCloseTo(-22 - 598 + 13, -2);
      expect(a3.yCm).toBeCloseTo(-22 - 1011 + 13, -2);
    });

    it("brings the glass wall with the Adds when it hasn't been drawn yet", () => {
      const walls = STUDIO_WALLS.filter((w) => w !== GLASS_DRAWN);
      const out = buildStudioPull(
        plansJob() as never,
        addSpecs,
        new Set(),
        new Map(),
        { walls, floorIndex: 0 },
        readModel() as never,
      );
      expect(out.placements.map((p) => p.itemName)).toEqual(["Add-1", "Add-2", "Add-3"]);
      const withWall = out.placements.filter((p) => p.newWall);
      expect(withWall).toHaveLength(1); // emitted ONCE for the wall
      const nw = withWall[0].newWall!;
      // The read wall (5.45,−0.09)→(5.51,−12.08) m, in studio cm.
      expect(Math.hypot(nw.x1 - 549, nw.y1 - -9)).toBeLessThan(15);
      expect(Math.hypot(nw.x2 - 551, nw.y2 - -1208)).toBeLessThan(15);
      for (const p of out.placements) {
        expect(p.fromRead).toBe(true);
        expect(onSeg(p, nw)).toBe(true);
        // Not stolen by the parallel bay wall 4.1 m west.
        expect(BAY_DRAWN.some((s) => onSeg(p, s))).toBe(false);
      }
    });

    describe("a read Add only ever lands on an INTERIOR wall", () => {
      // A narrow building where an EXTERIOR wall runs parallel to the read
      // partition and closer to it than half the snap radius: the read wall
      // sits at x = 8 m, the east exterior wall at x = 9.5 m — 1.5 m away,
      // well inside the 3 m a read Add may snap across. Nearest-wall alone
      // therefore lands the Add outside the building while the status line
      // says it went on the owner's interior walls.
      const NARROW_FP = [
        { x: 0, z: 0 },
        { x: 9.5, z: 0 },
        { x: 9.5, z: 10 },
        { x: 0, z: 10 },
      ];
      const READ_PARTITION = {
        name: "Office wall", x1: 8, z1: 2, x2: 8, z2: 8,
        story: 1, heightM: 3, elevM: 0, interior: true,
      };
      // Centre lands 2.5 m along the partition → (8 m, 4.5 m) = (800, 450) cm.
      const READ_ADD = { id: "Add-9", elev: "s4", x: 2, y: 0.9, w: 1000, h: 1200 };
      const narrowRead = {
        building: { footprints: [NARROW_FP], interiorWalls: [READ_PARTITION] },
        windows: [READ_ADD],
      };
      const narrowPlans = { building: { footprints: [NARROW_FP] }, windows: [] };
      const NARROW_EXTERIOR = [
        seg(0, 0, 950, 0),
        seg(950, 0, 950, 1000),
        seg(950, 1000, 0, 1000),
        seg(0, 1000, 0, 0),
      ];
      const pullNarrow = (walls: { x1: number; y1: number; x2: number; y2: number }[]) =>
        buildStudioPull(
          narrowPlans as never,
          [],
          new Set(),
          new Map(),
          { walls, floorIndex: 0 },
          narrowRead as never,
        );

      it("brings its own wall rather than landing on the exterior wall 1.5 m away", () => {
        const out = pullNarrow(NARROW_EXTERIOR);
        expect(out.placements).toHaveLength(1);
        const [p] = out.placements;
        expect(p.fromRead).toBe(true);
        // The read partition came with it — NOT the exterior wall next door.
        expect(p.newWall).toBeDefined();
        expect(p.xCm).toBeCloseTo(800, 0);
        expect(p.yCm).toBeCloseTo(450, 0);
        expect(NARROW_EXTERIOR.some((s) => onSeg(p, s))).toBe(false);
      });

      it("lands on the partition once the owner draws it half a metre off", () => {
        const drawn = seg(850, 200, 850, 800);
        const out = pullNarrow([...NARROW_EXTERIOR, drawn]);
        expect(out.placements).toHaveLength(1);
        const [p] = out.placements;
        expect(p.fromRead).toBe(true);
        expect(p.newWall).toBeUndefined();
        expect(onSeg(p, drawn)).toBe(true);
        expect(p.xCm).toBeCloseTo(850, 0);
      });

      it("prefers the drawn partition even when an exterior wall is nearer", () => {
        // Drawn 2 m west of the read wall; the exterior wall is 1.5 m east.
        // Nearest-wall-wins would take the exterior one.
        const drawn = seg(600, 200, 600, 800);
        const out = pullNarrow([...NARROW_EXTERIOR, drawn]);
        expect(out.placements).toHaveLength(1);
        const [p] = out.placements;
        expect(p.fromRead).toBe(true);
        expect(p.newWall).toBeUndefined();
        expect(onSeg(p, drawn)).toBe(true);
        expect(p.xCm).toBeCloseTo(600, 0);
        expect(NARROW_EXTERIOR.some((s) => onSeg(p, s))).toBe(false);
      });
    });

    it("is add-only: an Add already placed is skipped and counted, the rest still land", () => {
      const out = buildStudioPull(
        plansJob() as never,
        addSpecs,
        new Set(["Add-2"]),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
        readModel() as never,
      );
      expect(out.alreadyPlaced).toBe(1);
      expect(out.placements.map((p) => p.itemName)).toEqual(["Add-1", "Add-3"]);
      for (const p of out.placements) {
        expect(p.fromRead).toBe(true);
        expect(onSeg(p, GLASS_DRAWN)).toBe(true);
      }
    });

    it("without a read model the pull is exactly what it was: Adds spread along the exterior", () => {
      const before = buildStudioPull(
        plansJob() as never,
        addSpecs,
        new Set(),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
      );
      const withNull = buildStudioPull(
        plansJob() as never,
        addSpecs,
        new Set(),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
        null,
      );
      expect(withNull).toEqual(before);
      expect(before.placements.map((p) => p.itemName)).toEqual(["Add-1", "Add-2", "Add-3"]);
      for (const p of before.placements) {
        expect(p.fromSpec).toBe(true);
        expect(p.fromRead).toBeUndefined();
        // The old (wrong-wall) guess: an exterior wall, never the glass wall.
        expect(EXTERIOR.some((s) => onSeg(p, s))).toBe(true);
        expect(onSeg(p, GLASS_DRAWN)).toBe(false);
      }
    });

    it("ignores read windows on EXTERIOR walls — pins own exterior placement", () => {
      // "9" is read on s0 (an exterior edge) with a spec; "Ghost" is read
      // on s0 with no spec. Neither may come through the read path: "9"
      // still gets its ordinary spread guess, "Ghost" is not placed at all.
      const out = buildStudioPull(
        plansJob() as never,
        [...addSpecs, spec("9", 60, 48, "Fixed")],
        new Set(),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
        readModel([
          ...ADDS,
          { id: "9", elev: "s0", x: 4, y: 0.9, w: 1524, h: 1219 },
          { id: "Ghost", elev: "s0", x: 8, y: 0.9, w: 1000, h: 1000 },
        ]) as never,
      );
      const names = out.placements.map((p) => p.itemName);
      expect(names).not.toContain("Ghost");
      expect(names.filter((n) => n === "9")).toHaveLength(1);
      const nine = out.placements.find((p) => p.itemName === "9")!;
      expect(nine.fromSpec).toBe(true);
      expect(nine.fromRead).toBeUndefined();
      expect(out.placements.filter((p) => p.fromRead)).toHaveLength(3);
    });

    it("a read Add whose exact id is pinned in the plans is left to the pin", () => {
      // Add-1 pinned on the plans (job.windows) → the read copy steps
      // aside; Add-2/3 are separate marks and still land from the read,
      // even though markKeyOf folds all three onto the base "ADD".
      const out = buildStudioPull(
        plansJob([{ id: "Add-1", elev: "s0", x: 2, y: 0.03, w: 3288, h: 2425 }]) as never,
        addSpecs,
        new Set(),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
        readModel() as never,
      );
      // The pinned copy lands from its pin, ONCE — the read path never
      // adds one, and neither does the spread (which used to, because it
      // compared a suffixed spec code against BASE marks and never matched).
      const pinned = out.placements.filter((p) => p.itemName === "Add-1");
      expect(pinned).toHaveLength(1);
      expect(pinned[0].fromRead).toBeUndefined();
      expect(pinned[0].fromSpec).toBeUndefined();
      expect(out.placements.filter((p) => p.fromRead).map((p) => p.itemName)).toEqual([
        "Add-2",
        "Add-3",
      ]);
    });

    it("a pinned Add is placed once, and its siblings still get their guess", () => {
      // No read model at all: Add-1 is pinned on the plans, Add-2 and Add-3
      // are not. Add-1 must not ALSO be guessed into the spread, and the
      // other two must not be dropped from it just because markKeyOf folds
      // all three onto the one base mark "ADD".
      const out = buildStudioPull(
        plansJob([{ id: "Add-1", elev: "s0", x: 2, y: 0.03, w: 3288, h: 2425 }]) as never,
        addSpecs,
        new Set(),
        new Map(),
        { walls: STUDIO_WALLS, floorIndex: 0 },
      );
      expect(out.placements.map((p) => p.itemName)).toEqual(["Add-1", "Add-2", "Add-3"]);
      expect(out.placements[0].fromSpec).toBeUndefined();
      expect(out.placements[1].fromSpec).toBe(true);
      expect(out.placements[2].fromSpec).toBe(true);
    });

    it("with no studio frame, a read Add sits at the read model's own coordinates", () => {
      const out = buildStudioPull(
        plansJob() as never,
        addSpecs,
        new Set(),
        new Map(),
        undefined,
        readModel() as never,
      );
      expect(out.placements.map((p) => p.itemName)).toEqual(["Add-1", "Add-2", "Add-3"]);
      for (const p of out.placements) {
        expect(p.fromRead).toBe(true);
        expect(p.newWall).toBeUndefined();
        // On the read glass wall (5.45,−0.09)→(5.51,−12.08) m, in cm.
        expect(onSeg(p, seg(545, -9, 551, -1208))).toBe(true);
      }
    });
  });

  it("markKeyOf folds every dialect onto the base mark", () => {
    expect(markKeyOf("16-2")).toBe("16");
    expect(markKeyOf("16B")).toBe("16");
    expect(markKeyOf("12@L3")).toBe("12");
  });

  it("keeps same-size marks un-crossed through the pull (Mad Moose: marks 1/7/8 all 167.5x143.5in)", () => {
    // Real Mad Moose shapes (project 08c60cce-29f6-4b52-bd0c-2bc2c02a79a9):
    // three unrelated marks that happen to share one CAD size. Nothing in
    // buildStudioPull may key a placement by its size — only by its own
    // mark/itemName — or two same-size marks would silently swap identities
    // the moment they landed on the same wall.
    const specs = [
      spec("1", 167.5, 143.5, "Fixed / Double Swing Door"),
      spec("7", 167.5, 143.5, ""),
      spec("8", 167.5, 143.5, "Fixed"),
    ];
    const windows = [win("1", 0), win("7", 5), win("8", 10)];
    const out = buildStudioPull(
      { building: { footprints: [rect(0, 0, 30, 6)] }, windows } as never,
      specs,
      new Set(),
    );
    expect(out.placements).toHaveLength(3);
    // Every placement keeps ITS OWN mark, in the order it was walked —
    // no dedup/size-keyed map could have merged or reordered these three
    // identically-sized configs into each other.
    expect(out.placements.map((p) => p.itemName)).toEqual(["1", "7", "8"]);
    // And unitMarkLabel (what the badge actually renders) is equally
    // faithful to each placement's own itemName — size plays no part.
    for (const p of out.placements) {
      expect(unitMarkLabel(p.itemName)).toBe(p.itemName);
    }
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

describe("buildStudioFloorsSeed (every traced story → a studio floor)", () => {
  it("two stories become two floor plans, walls per story", () => {
    const job = {
      building: {
        footprints: [rect(0, 0, 10, 6)],
        stories: [
          { n: 1, elevM: 0, heightM: 3, footprints: [rect(0, 0, 10, 6), rect(12, 0, 16, 4)] },
          { n: 2, elevM: 3, heightM: 2.5, footprints: [rect(0, 0, 10, 6)] },
        ],
      },
      windows: [],
    };
    const floors = buildStudioFloorsSeed(job as never);
    expect(floors).toHaveLength(2);
    const f1 = JSON.parse(floors[0]) as { floorplan: { walls: unknown[] } };
    const f2 = JSON.parse(floors[1]) as { floorplan: { walls: unknown[] } };
    expect(f1.floorplan.walls).toHaveLength(8); // two separate masses
    expect(f2.floorplan.walls).toHaveLength(4);
  });

  it("no stories array → one ground floor", () => {
    const floors = buildStudioFloorsSeed(job([rect(0, 0, 8, 5)]) as never);
    expect(floors).toHaveLength(1);
    expect(
      (JSON.parse(floors[0]) as { floorplan: { walls: unknown[] } }).floorplan.walls,
    ).toHaveLength(4);
  });
});

describe("catalogByMarkFrom", () => {
  it("keys a unit by its BASE mark, read off the name", () => {
    const flat: UnitConfig = { kind: "window", heightMm: 1500, panels: [{ widthMm: 900, mechanism: "fixed" }] };
    const map = catalogByMarkFrom([
      { name: "Window 16", config: flat },
      { name: "Door 3 · BLACK22", config: { ...flat, kind: "door" } },
    ]);
    expect(map.get("16")).toBe(flat);
    expect(map.get("3")?.kind).toBe("door");
  });

  it("skips a unit whose name doesn't start with Window/Door", () => {
    const flat: UnitConfig = { kind: "window", heightMm: 1500, panels: [{ widthMm: 900, mechanism: "fixed" }] };
    const map = catalogByMarkFrom([{ name: "Untitled unit", config: flat }]);
    expect(map.size).toBe(0);
  });
});

describe("resolveMarkConfig", () => {
  it("prefers the catalog unit over the spec-derived draft", () => {
    const catalogCfg: UnitConfig = { kind: "window", heightMm: 4559, panels: [{ widthMm: 8000, mechanism: "fixed" }] };
    const catalogByMark = new Map([["16", catalogCfg]]);
    const specIndex = indexSpecsByMark([spec("16", 72, 60, "XO")]);
    expect(resolveMarkConfig("16", specIndex, catalogByMark)).toBe(catalogCfg);
  });

  it("falls back to the spec when the mark has no catalog unit", () => {
    const specIndex = indexSpecsByMark([spec("3", 72, 60, "XO")]);
    const config = resolveMarkConfig("3", specIndex, new Map());
    expect(config?.panels).toHaveLength(2); // XO = slider + fixed
  });

  it("resolves to null when neither a catalog unit nor a usable spec exists", () => {
    expect(resolveMarkConfig("99", new Map(), new Map())).toBeNull();
  });
});

describe("formatPullToast", () => {
  const base: PullToastStats = {
    placedHere: 0,
    specPlacedHere: 0,
    readPlacedHere: 0,
    healed: 0,
    shifted: 0,
    lengthened: 0,
    wallsAdded: 0,
    raised: 0,
    autoScale: null,
    alreadyPlaced: 0,
    otherFloors: 0,
    noWall: 0,
  };

  it("Mad Moose: all ten placed from specs reads as a plain, honest guess", () => {
    expect(formatPullToast({ ...base, placedHere: 10, specPlacedHere: 10 })).toBe(
      "Pulled 10 marks — 10 placed from specs (no pins yet; positions are a starting point).",
    );
  });

  it("an all-pinned pull keeps the original wording unchanged", () => {
    expect(formatPullToast({ ...base, placedHere: 4 })).toBe(
      "Pull from plans: 4 placed.",
    );
  });

  it("a mix of pinned and unpinned marks reports both", () => {
    expect(
      formatPullToast({ ...base, placedHere: 7, specPlacedHere: 3, alreadyPlaced: 2 }),
    ).toBe(
      "Pulled 7 marks — 4 placed from pins · 3 placed from specs (no pins yet; positions are a starting point) · 2 already placed.",
    );
  });

  it("Mad Moose 2026-09-02: the three Adds on the drawn glass wall say where they came from", () => {
    // Marks 1–10 already sit on the exterior; the pull adds only the Adds.
    expect(
      formatPullToast({ ...base, placedHere: 3, readPlacedHere: 3, alreadyPlaced: 10 }),
    ).toBe(
      "Pull from plans: 3 placed on your interior walls from the read plans · 10 already placed.",
    );
  });

  it("read-placed units sit alongside pins and spec guesses without changing their wording", () => {
    expect(
      formatPullToast({ ...base, placedHere: 8, specPlacedHere: 2, readPlacedHere: 3 }),
    ).toBe(
      "Pulled 8 marks — 3 placed from pins · 3 placed on your interior walls from the read plans · 2 placed from specs (no pins yet; positions are a starting point).",
    );
  });

  it("with nothing read-placed the wording is exactly what it was", () => {
    expect(
      formatPullToast({ ...base, placedHere: 4, readPlacedHere: 0, wallsAdded: 1 }),
    ).toBe("Pull from plans: 4 placed · 1 wall added from the plans.");
  });
});
