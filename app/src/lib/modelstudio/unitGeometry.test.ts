// Corner (90°) units — window 16's shape: five panels wrapping a building
// corner after the first 30¼" panel. The longer run stays on its wall (the
// "main" leg), the short leg turns down the neighbouring wall.

import { describe, expect, it } from "vitest";
import { buildUnitGeometry, cornerGeometryInfo } from "./unitGeometry";
import { cornerLegs, unitSvg, type UnitConfig } from "./units";

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

describe("unitSvg corner marker", () => {
  it("draws the 90° label the way the spec sheet does", () => {
    expect(unitSvg(WINDOW_16)).toContain("90°");
    expect(unitSvg({ ...WINDOW_16, cornerAfterPanel: null })).not.toContain("90°");
  });
});
