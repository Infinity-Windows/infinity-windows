// Corner (90°) units — window 16's shape: five panels wrapping a building
// corner after the first 30¼" panel. The longer run stays on its wall (the
// "main" leg), the short leg turns down the neighbouring wall.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { StudioItem } from "./core";
import {
  applyUnitGeometry,
  buildUnitGeometry,
  cornerGeometryInfo,
  FRAME_COLOR_HEXES,
  UNIT_GEOMETRY_DEFAULTS,
} from "./unitGeometry";
import { configFromTiers, cornerLegs, unitSvg, type UnitConfig, type UnitTier } from "./units";

/** Window 16, exactly as the drawing dimensions it (mm). */
const WINDOW_16: UnitConfig = {
  kind: "window",
  heightMm: 4559,
  panels: [768, 2248, 2286, 2229, 432].map((widthMm) => ({
    widthMm,
    mechanism: "fixed" as const,
  })),
  cornerAfterPanel: 0,
};

describe("cornerLegs / cornerGeometryInfo", () => {
  it("splits window 16 into its 30¼\" wrap and its four-panel main run", () => {
    const legs = cornerLegs(WINDOW_16)!;
    expect(legs.left).toHaveLength(1);
    expect(legs.right).toHaveLength(4);
    const info = cornerGeometryInfo(WINDOW_16)!;
    expect(info.mainWcm).toBeCloseTo(719.5, 1); // 2248+2286+2229+432 mm in cm
    expect(info.wrapWcm).toBeCloseTo(76.8, 1);
    expect(info.sideSign).toBe(1); // wrap at the outside-left end
  });

  it("returns null for flat units and out-of-range corners", () => {
    expect(cornerGeometryInfo({ ...WINDOW_16, cornerAfterPanel: null })).toBeNull();
    expect(cornerGeometryInfo({ ...WINDOW_16, cornerAfterPanel: 4 })).toBeNull();
    expect(cornerLegs({ ...WINDOW_16, cornerAfterPanel: -1 })).toBeNull();
  });

  it("wraps at the outside-right end when the right leg is shorter", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 2000,
      panels: [
        { widthMm: 2000, mechanism: "fixed" },
        { widthMm: 600, mechanism: "fixed" },
      ],
      cornerAfterPanel: 0,
    };
    expect(cornerGeometryInfo(cfg)!.sideSign).toBe(-1);
  });
});

describe("buildUnitGeometry corner legs", () => {
  it("extends the wrap leg perpendicular (local +z) at the corner end", () => {
    const { geometry } = buildUnitGeometry(WINDOW_16);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    // Main leg spans x around the origin…
    expect(bb.max.x).toBeGreaterThan(350);
    expect(bb.min.x).toBeLessThan(-350);
    // …and the wrap leg pushes z well past a flat unit's depth (10 cm).
    expect(bb.max.z).toBeGreaterThan(70);
    // Glass group is still group 1 with real area.
    expect(geometry.groups.length).toBe(2);
  });

  it("keeps flat units flat", () => {
    const { geometry } = buildUnitGeometry({ ...WINDOW_16, cornerAfterPanel: null });
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeLessThan(10);
  });
});

describe("pane grids (rows share mullion lines)", () => {
  it("rowHeightsCm normalizes drift so the grid always fills the unit", async () => {
    const { rowHeightsCm } = await import("./units");
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 2000,
      panels: [{ widthMm: 1000, mechanism: "fixed" }],
      rows: [{ heightMm: 600 }, { heightMm: 600 }], // sums to 1200, not 2000
    };
    const rows = rowHeightsCm(cfg);
    expect(rows).toHaveLength(2);
    expect(rows[0] + rows[1]).toBeCloseTo(200, 6);
    expect(rowHeightsCm({ ...cfg, rows: null })).toEqual([200]);
  });

  it("a 2×3 grid builds one glass cell per pane", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 2000,
      panels: [
        { widthMm: 1000, mechanism: "fixed" },
        { widthMm: 1000, mechanism: "fixed" },
      ],
      rows: [{ heightMm: 700 }, { heightMm: 700 }, { heightMm: 600 }],
    };
    const { geometry } = buildUnitGeometry(cfg);
    // Glass group is group 1; each merged BoxGeometry contributes 24 verts.
    const glass = geometry.groups[1];
    const glassVerts = geometry.getAttribute("position").count - glass.start / 1;
    void glassVerts;
    // 2 columns × 3 rows = 6 cells; flat single-row would be 2.
    const index = geometry.getIndex()!;
    const glassTriangles = (index.count - glass.start) / 3;
    expect(glassTriangles).toBe(6 * 12); // 12 triangles per box
  });

  it("unitSvg draws the shared row break lines", async () => {
    const { unitSvg } = await import("./units");
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 2000,
      panels: [{ widthMm: 1000, mechanism: "fixed" }],
      rows: [{ heightMm: 1000 }, { heightMm: 1000 }],
    };
    const withRows = unitSvg(cfg);
    const flat = unitSvg({ ...cfg, rows: null });
    expect((withRows.match(/<line/g) ?? []).length).toBeGreaterThan(
      (flat.match(/<line/g) ?? []).length,
    );
  });
});

describe("frame color (Studio 100x #47)", () => {
  const flat: UnitConfig = {
    kind: "window",
    heightMm: 1500,
    panels: [{ widthMm: 1200, mechanism: "fixed" }],
  };
  const hexOf = (m: THREE.Material) => (m as THREE.MeshLambertMaterial).color.getHex();

  it("defaults to white, byte-for-byte the old hardcoded hex", () => {
    const { materials } = buildUnitGeometry(flat);
    expect(hexOf(materials[0])).toBe(0xf4f1ec);
    expect(hexOf(materials[1])).toBe(0x9fc4d4);
    // Explicit "white" renders identically to leaving it unset.
    const explicit = buildUnitGeometry({ ...flat, frameColor: "white" });
    expect(hexOf(explicit.materials[0])).toBe(0xf4f1ec);
  });

  it("bronze and black each pick a distinct, non-default frame hex", () => {
    const bronze = buildUnitGeometry({ ...flat, frameColor: "bronze" });
    const black = buildUnitGeometry({ ...flat, frameColor: "black" });
    expect(hexOf(bronze.materials[0])).toBe(FRAME_COLOR_HEXES.bronze.frame);
    expect(hexOf(black.materials[0])).toBe(FRAME_COLOR_HEXES.black.frame);
    expect(FRAME_COLOR_HEXES.bronze.frame).not.toBe(FRAME_COLOR_HEXES.white.frame);
    expect(FRAME_COLOR_HEXES.black.frame).not.toBe(FRAME_COLOR_HEXES.white.frame);
    expect(FRAME_COLOR_HEXES.bronze.frame).not.toBe(FRAME_COLOR_HEXES.black.frame);
  });
});

describe("unitSvg corner marker", () => {
  it("draws the 90° label the way the spec sheet does", () => {
    expect(unitSvg(WINDOW_16)).toContain("90°");
    expect(unitSvg({ ...WINDOW_16, cornerAfterPanel: null })).not.toContain("90°");
  });
});

// Studio 100x #22: multi-tier units stack straight up through frozen floor
// shells above (ACCEPTED v1 occlusion limit, documented at buildUnitGeometry's
// buildTier). These tests cover the stacking math itself, not occlusion.
describe("buildUnitGeometry — multi-tier stacking (Studio 100x #22)", () => {
  const flatTier = (heightMm: number, widthMm = 1200): UnitConfig => ({
    kind: "window",
    heightMm,
    panels: [{ widthMm, mechanism: "fixed" }],
  });

  it("stacks a tier directly on top of the one below it — no gap, no overlap", () => {
    const h1 = 1500;
    const h2 = 1000;
    const multi = configFromTiers(
      { kind: "window" },
      [
        { panels: [{ widthMm: 1200, mechanism: "fixed" }], heightMm: h1, cornerAfterPanel: null, story: 1 },
        { panels: [{ widthMm: 1200, mechanism: "fixed" }], heightMm: h2, cornerAfterPanel: null, story: 2 },
      ],
    );
    const { geometry } = buildUnitGeometry(multi);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;

    const solo1 = buildUnitGeometry(flatTier(h1));
    solo1.geometry.computeBoundingBox();
    const bb1 = solo1.geometry.boundingBox!;
    const solo2 = buildUnitGeometry(flatTier(h2));
    solo2.geometry.computeBoundingBox();
    const bb2 = solo2.geometry.boundingBox!;

    // Tier 0 (the base) renders exactly where a flat unit of its own
    // height always has — the base tier's sill/position never moves.
    expect(bb.min.y).toBeCloseTo(bb1.min.y, 6);
    // Tier 1 stacks directly on tier 0's top: the SAME local span a flat
    // unit of its own height has, shifted up by tier 0's full height —
    // not tier 0's half-height, not any gap or overlap.
    expect(bb.max.y).toBeCloseTo(bb1.max.y + (bb2.max.y - bb2.min.y), 6);
    expect(bb.max.y - bb1.max.y).toBeCloseTo(h2 / 10, 6); // tier 1's own height, in cm
  });

  it("three tiers stack in order — total height is the sum of all three", () => {
    const heights = [1500, 1200, 1000];
    const multi = configFromTiers(
      { kind: "window" },
      heights.map((heightMm, i) => ({
        panels: [{ widthMm: 1200, mechanism: "fixed" as const }],
        heightMm,
        cornerAfterPanel: null,
        story: i + 1,
      })),
    );
    const { geometry } = buildUnitGeometry(multi);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    const totalCm = heights.reduce((t, h) => t + h, 0) / 10;
    expect(bb.max.y - bb.min.y).toBeCloseTo(totalCm, 6);
  });

  it("each tier judges its OWN corner — a corner on tier 2 alone still extends the wrap leg", () => {
    const cornerPanels = [768, 2248, 2286, 2229, 432].map((widthMm) => ({
      widthMm,
      mechanism: "fixed" as const,
    }));
    const flatBase: UnitTier = { panels: cornerPanels, heightMm: 1500, cornerAfterPanel: null, story: 1 };
    const cornerTop: UnitTier = { panels: cornerPanels, heightMm: 1500, cornerAfterPanel: 0, story: 2 };
    const cfg = configFromTiers({ kind: "window" }, [flatBase, cornerTop]);
    // The top-level flat mirror (tier 0) has NO corner — proves the wrap
    // leg below comes from reading the TIER's own value, never the
    // top-level config.cornerAfterPanel mirror.
    expect(cfg.cornerAfterPanel).toBeNull();
    const { geometry } = buildUnitGeometry(cfg);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(70);
  });

  it("a corner on the BASE tier alone still wraps, even with a flat tier above it", () => {
    const cornerPanels = [768, 2248, 2286, 2229, 432].map((widthMm) => ({
      widthMm,
      mechanism: "fixed" as const,
    }));
    const cornerBase: UnitTier = { panels: cornerPanels, heightMm: 1500, cornerAfterPanel: 0, story: 1 };
    const flatTop: UnitTier = {
      panels: [{ widthMm: 1200, mechanism: "fixed" }],
      heightMm: 1200,
      cornerAfterPanel: null,
      story: 2,
    };
    const cfg = configFromTiers({ kind: "window" }, [cornerBase, flatTop]);
    const { geometry } = buildUnitGeometry(cfg);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(70);
  });

  it("neither tier has a corner — the whole stack stays flat", () => {
    const cfg = configFromTiers(
      { kind: "window" },
      [
        { panels: [{ widthMm: 1200, mechanism: "fixed" }], heightMm: 1200, cornerAfterPanel: null, story: 1 },
        { panels: [{ widthMm: 1200, mechanism: "fixed" }], heightMm: 1200, cornerAfterPanel: null, story: 2 },
      ],
    );
    const { geometry } = buildUnitGeometry(cfg);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.z).toBeLessThan(10);
  });

  it("a mover on an upper tier carries that tier's index and is pivoted at its stacked centre", () => {
    const h1 = 1500;
    const h2 = 1000;
    const cfg = configFromTiers(
      { kind: "window" },
      [
        { panels: [{ widthMm: 1200, mechanism: "fixed" }], heightMm: h1, cornerAfterPanel: null, story: 1 },
        {
          panels: [{ widthMm: 1200, mechanism: "slider", direction: "left" }],
          heightMm: h2,
          cornerAfterPanel: null,
          story: 2,
        },
      ],
    );
    const { movers } = buildUnitGeometry(cfg);
    expect(movers).toHaveLength(1);
    expect(movers[0].tierIndex).toBe(1);
    // Pivoted at tier 1's own stacked CENTRE — half of tier 0's height
    // plus half of tier 1's own (where tier 1's boxes are actually
    // centred) — not at 0 (today's single-tier constant) and not at
    // tier 0's full height.
    expect(movers[0].origin.y).toBeCloseTo(h1 / 20 + h2 / 20, 6); // 75 + 50 = 125
  });

  it("a config with no tiers field builds identically to before — single-tier byte-for-byte", () => {
    const flat = flatTier(1500);
    const viaTiers = configFromTiers({ kind: "window" }, [
      { panels: flat.panels, heightMm: flat.heightMm, cornerAfterPanel: null, story: 1 },
    ]);
    expect("tiers" in viaTiers).toBe(false); // collapsed by configFromTiers
    const a = buildUnitGeometry(flat);
    const b = buildUnitGeometry(viaTiers);
    a.geometry.computeBoundingBox();
    b.geometry.computeBoundingBox();
    expect(b.geometry.boundingBox).toEqual(a.geometry.boundingBox);
  });

  it("only the base tier honors a pane grid — a tier above it is always one row in v1", () => {
    const cfg = configFromTiers(
      { kind: "window" },
      [
        { panels: [{ widthMm: 1000, mechanism: "fixed" }], heightMm: 2000, cornerAfterPanel: null, story: 1 },
        { panels: [{ widthMm: 1000, mechanism: "fixed" }], heightMm: 2000, cornerAfterPanel: null, story: 2 },
      ],
    );
    // configFromTiers carries no `rows` field yet — set it directly on
    // the flat mirror, the way UnitConfig.rows already documents.
    const withRows: UnitConfig = { ...cfg, rows: [{ heightMm: 1000 }, { heightMm: 1000 }] };
    const { geometry } = buildUnitGeometry(withRows);
    const glass = geometry.groups[1];
    const index = geometry.getIndex()!;
    const glassTriangles = (index.count - glass.start) / 3;
    // Tier 0: 1 column × 2 rows = 2 cells. Tier 1 (no rows support yet):
    // 1 column × 1 row = 1 cell. 3 cells × 12 triangles/box (BoxGeometry).
    expect(glassTriangles).toBe(3 * 12);
  });
});

// PRUNE pass: applyUnitGeometry used to be copy-pasted into ModelStudio.tsx,
// JobModelViewer.tsx, and elevationRender.ts. These three viewers differ
// only in which of `options` they set — Studio (the one editable scene)
// allows a per-item gap override, rebuilds moving-sash rigs, and repaints
// its overlay; the read-only viewers take every default. These tests pin
// that every option actually changes what it claims to, and that the
// defaults reproduce the two read-only viewers' old (unparameterized)
// behavior byte-for-byte.
describe("applyUnitGeometry (shared mounting core)", () => {
  const FLAT: UnitConfig = {
    kind: "window",
    heightMm: 1500,
    panels: [
      { widthMm: 900, mechanism: "fixed" },
      { widthMm: 900, mechanism: "fixed" },
    ],
  };
  // A fixed panel alongside the slider — an all-moving unit leaves its
  // tierGlass empty and trips an unrelated pre-existing crash in
  // buildUnitGeometry's mergeGeometries call (see the prune-pass task spawned
  // separately); not this cut's concern, so the fixture just avoids it.
  const SLIDING: UnitConfig = {
    kind: "window",
    heightMm: 1500,
    panels: [
      { widthMm: 900, mechanism: "fixed" },
      { widthMm: 900, mechanism: "slider", direction: "left" },
    ],
  };

  function mockItem(metadata: { frameGapMm?: number } | null = {}): StudioItem {
    const obj = new THREE.Object3D();
    return Object.assign(obj, {
      geometry: new THREE.BoxGeometry(1, 1, 1),
      material: null,
      halfSize: { x: 0, y: 0, z: 0, set: vi.fn() },
      metadata: metadata === null ? undefined : { ...metadata },
      redrawWall: vi.fn(),
    }) as unknown as StudioItem;
  }

  const geometryOf = (item: StudioItem) => item.geometry as unknown as THREE.BufferGeometry;
  const positionsOf = (geo: THREE.BufferGeometry) =>
    Array.from(geo.getAttribute("position").array);

  it("mounts the built geometry, refreshes halfSize, records the config, and redraws the wall", () => {
    const item = mockItem();
    applyUnitGeometry(item, FLAT);
    expect(positionsOf(geometryOf(item))).toEqual(
      positionsOf(buildUnitGeometry(FLAT, { mullionMm: UNIT_GEOMETRY_DEFAULTS.mullionMm }).geometry),
    );
    expect((item.halfSize as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalled();
    expect(item.metadata!.unitConfig).toBe(FLAT);
    expect(item.redrawWall).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on metadata when the item carries none — no crash on a bare item", () => {
    const item = mockItem(null);
    expect(() => applyUnitGeometry(item, FLAT)).not.toThrow();
  });

  it("with no options, always uses the shop default gap — even when the item has a stored override (JobModelViewer / elevationRender's old behavior)", () => {
    const item = mockItem({ frameGapMm: 999 });
    applyUnitGeometry(item, FLAT);
    expect(positionsOf(geometryOf(item))).toEqual(
      positionsOf(buildUnitGeometry(FLAT, { mullionMm: UNIT_GEOMETRY_DEFAULTS.mullionMm }).geometry),
    );
    expect(item.metadata!.frameGapMm).toBe(999); // left exactly as it was
  });

  it("allowStoredFrameGap reads the item's own override when no explicit frameGapMm is given", () => {
    const item = mockItem({ frameGapMm: 15 });
    applyUnitGeometry(item, FLAT, { allowStoredFrameGap: true });
    expect(positionsOf(geometryOf(item))).toEqual(
      positionsOf(buildUnitGeometry(FLAT, { mullionMm: 15 }).geometry),
    );
    expect(item.metadata!.frameGapMm).toBe(15); // read, not re-written
  });

  it("an explicit frameGapMm wins outright and is persisted back to metadata (ModelStudio's gap control)", () => {
    const item = mockItem({ frameGapMm: 15 });
    applyUnitGeometry(item, FLAT, { frameGapMm: 55, allowStoredFrameGap: true });
    expect(positionsOf(geometryOf(item))).toEqual(
      positionsOf(buildUnitGeometry(FLAT, { mullionMm: 55 }).geometry),
    );
    expect(item.metadata!.frameGapMm).toBe(55);
  });

  it("adds a two-rect holeRects reader for a corner unit, and clears it once the unit goes flat", () => {
    const item = mockItem();
    applyUnitGeometry(item, WINDOW_16);
    const withHoles = item as unknown as { holeRects?: () => unknown[] };
    expect(withHoles.holeRects).toBeInstanceOf(Function);
    expect(withHoles.holeRects!()).toHaveLength(2);

    applyUnitGeometry(item, { ...WINDOW_16, cornerAfterPanel: null });
    expect(withHoles.holeRects).toBeUndefined();
  });

  it("rebuildMovers off (the default) never touches the item's children, even for a unit with a moving panel", () => {
    const item = mockItem();
    applyUnitGeometry(item, SLIDING);
    const obj = item as unknown as THREE.Object3D;
    expect(obj.children.filter((c) => c.name === "unit-mover")).toHaveLength(0);
  });

  it("rebuildMovers replaces stale pivot groups with one fresh group per mover", () => {
    const item = mockItem();
    const obj = item as unknown as THREE.Object3D;
    const stale = new THREE.Group();
    stale.name = "unit-mover";
    obj.add(stale);

    applyUnitGeometry(item, SLIDING, { rebuildMovers: true });

    const movers = obj.children.filter((c) => c.name === "unit-mover");
    expect(movers).toHaveLength(1);
    expect(movers[0]).not.toBe(stale);
  });

  it("calls onApplied once metadata is set, and always before redrawWall", () => {
    const order: string[] = [];
    const item = mockItem();
    (item as { redrawWall: () => void }).redrawWall = vi.fn(() => order.push("redraw"));
    applyUnitGeometry(item, FLAT, {
      onApplied: (it) => {
        order.push("applied");
        expect(it.metadata!.unitConfig).toBe(FLAT); // metadata already set by this point
      },
    });
    expect(order).toEqual(["applied", "redraw"]);
  });
});
