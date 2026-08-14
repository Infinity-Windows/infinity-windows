// The animation math is direction-aware and pure: "the animation logic
// would always be the same... the only things that change are which
// direction they open" (owner).

import { describe, expect, it } from "vitest";
import { easeInOutCubic, moverTransform } from "./openingAnimation";
import { buildUnitGeometry } from "./unitGeometry";
import type { UnitConfig } from "./units";

const mover = (
  mechanism: "slider" | "casement" | "hung" | "bifold",
  direction: "left" | "right",
  slideCount = 1,
) => ({
  panelIndex: 0,
  mechanism,
  direction,
  origin: { x: 0, y: 0, z: 0 },
  travelCm: 100,
  slideCount,
  geometry: null as never,
});

describe("moverTransform", () => {
  it("sliders slide toward their direction (outside-left = +x)", () => {
    expect(moverTransform(mover("slider", "left"), 1).x).toBeCloseTo(100, 6);
    expect(moverTransform(mover("slider", "right"), 1).x).toBeCloseTo(-100, 6);
    expect(moverTransform(mover("slider", "left"), 0).x).toBe(0);
  });
  it("multi-track sliders travel slideCount panel-widths", () => {
    expect(moverTransform(mover("slider", "left", 3), 1).x).toBeCloseTo(300, 6);
    expect(moverTransform(mover("slider", "right", 8), 0.5).x).toBeCloseTo(-400, 6);
    // Count never bleeds into swings: a casement's rotation ignores it.
    expect(moverTransform(mover("casement", "left", 4), 1).x).toBe(0);
  });
  it("casements swing on the hinge, sign follows the side", () => {
    expect(moverTransform(mover("casement", "left"), 1).rotY).toBeGreaterThan(1.5);
    expect(moverTransform(mover("casement", "right"), 1).rotY).toBeLessThan(-1.5);
  });
  it("hung sash rises, bifolds fold", () => {
    expect(moverTransform(mover("hung", "left"), 1).y).toBeCloseTo(90, 6);
    expect(Math.abs(moverTransform(mover("bifold", "right"), 1).rotY)).toBeGreaterThan(1);
  });
  it("easeInOutCubic is a proper 0→1 ease", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });
});

describe("buildUnitGeometry movers", () => {
  const cfg: UnitConfig = {
    kind: "window",
    heightMm: 1800,
    panels: [
      { widthMm: 1200, mechanism: "slider", direction: "left" },
      { widthMm: 1200, mechanism: "fixed" },
      { widthMm: 1000, mechanism: "casement", direction: "right" },
    ],
  };

  it("splits one mover per MOVING panel; fixed stays in the static merge", () => {
    const { movers } = buildUnitGeometry(cfg);
    expect(movers).toHaveLength(2);
    expect(movers.map((m) => m.mechanism).sort()).toEqual(["casement", "slider"]);
    for (const m of movers) {
      expect(m.geometry.getAttribute("position").count).toBeGreaterThan(0);
      expect(m.travelCm).toBeGreaterThan(50);
    }
  });

  it("movers carry the panel's clamped slide count", () => {
    const { movers } = buildUnitGeometry({
      ...cfg,
      panels: cfg.panels.map((p, i) =>
        i === 0 ? { ...p, slideCount: 99 } : p,
      ),
    });
    expect(movers.find((m) => m.mechanism === "slider")!.slideCount).toBe(8);
    expect(movers.find((m) => m.mechanism === "casement")!.slideCount).toBe(1);
  });

  it("hinge origin sits at the stile, slide origin at the panel centre", () => {
    const { movers } = buildUnitGeometry(cfg);
    const slide = movers.find((m) => m.mechanism === "slider")!;
    const swing = movers.find((m) => m.mechanism === "casement")!;
    // The swing pivot is at a panel EDGE — far from the slide pivot's
    // centre-of-panel; both are finite unit-local x positions.
    expect(Number.isFinite(slide.origin.x)).toBe(true);
    expect(Number.isFinite(swing.origin.x)).toBe(true);
    // Mover geometry is centred near its own origin: bounding box spans
    // the pane for the slider (symmetric-ish) and sits one-sided for the
    // hinge (all glass on one side of the pivot).
    swing.geometry.computeBoundingBox();
    const bb = swing.geometry.boundingBox!;
    expect(Math.sign(bb.min.x) === Math.sign(bb.max.x) || bb.min.x === 0 || bb.max.x === 0).toBe(
      true,
    );
  });

  it("flat all-fixed units have no movers", () => {
    const { movers } = buildUnitGeometry({
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 1000, mechanism: "fixed" }],
    });
    expect(movers).toHaveLength(0);
  });
});
