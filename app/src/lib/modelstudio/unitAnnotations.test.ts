// The glyph layout is pure: arrows follow the panel's direction, casements
// point their sight-lines at the hinge, fixed panes read "F", labels obey
// the marks-always / dims-on-selection rule, and corner units split their
// glyphs across both legs.

import { describe, expect, it } from "vitest";
import { annotationLayout } from "./unitAnnotations";
import type { UnitConfig } from "./units";

const CFG: UnitConfig = {
  kind: "window",
  heightMm: 2000,
  panels: [
    { widthMm: 900, mechanism: "slider", direction: "left" },
    { widthMm: 900, mechanism: "fixed" },
    { widthMm: 900, mechanism: "casement", direction: "right" },
  ],
};

describe("annotationLayout", () => {
  it("maps mechanisms to the trade glyphs, in outside-view order", () => {
    const [leg] = annotationLayout(CFG, { mark: "16", dims: false });
    expect(leg.glyphs.map((g) => g.kind)).toEqual([
      "arrow-left",
      "fixed",
      "hinge-right",
    ]);
    // Outside-view x: first panel starts at the left edge.
    expect(leg.glyphs[0].x).toBe(0);
    expect(leg.glyphs[1].x).toBeCloseTo(90, 6);
  });

  it("multi-track sliders carry their ×n count; singles stay clean", () => {
    const multi: UnitConfig = {
      ...CFG,
      panels: [
        { widthMm: 900, mechanism: "slider", direction: "left", slideCount: 3 },
        { widthMm: 900, mechanism: "slider", direction: "right" },
        { widthMm: 900, mechanism: "casement", direction: "left", slideCount: 4 },
      ],
    };
    const [leg] = annotationLayout(multi, { dims: false });
    expect(leg.glyphs[0].count).toBe(3);
    expect(leg.glyphs[1].count).toBeUndefined(); // ×1 draws no badge
    expect(leg.glyphs[2].count).toBeUndefined(); // swings never count
  });

  it("puts one glyph per pane CELL when rows split the unit", () => {
    const grid: UnitConfig = {
      ...CFG,
      rows: [{ heightMm: 1000 }, { heightMm: 1000 }],
    };
    const [leg] = annotationLayout(grid, { dims: false });
    expect(leg.glyphs).toHaveLength(6); // 3 columns × 2 rows
  });

  it("marks always, measurements only when dims is on", () => {
    const off = annotationLayout(CFG, { mark: "16", dims: false })[0];
    expect(off.labels.map((l) => l.kind)).toEqual(["mark"]);
    const on = annotationLayout(CFG, { mark: "16", dims: true })[0];
    expect(on.labels.filter((l) => l.kind === "panedim")).toHaveLength(3);
    expect(on.labels.filter((l) => l.kind === "wl")).toHaveLength(1);
    expect(on.labels.filter((l) => l.kind === "mark")).toHaveLength(1);
    // Pane widths print in the map's tape style.
    expect(on.labels.find((l) => l.kind === "panedim")!.text).toMatch(/"$/);
  });

  it("corner units carry glyphs on both legs, mark on the main leg only", () => {
    const corner: UnitConfig = { ...CFG, cornerAfterPanel: 0 };
    const legs = annotationLayout(corner, { mark: "16", dims: false });
    expect(legs.map((l) => l.leg)).toEqual(["main", "wrap"]);
    expect(legs[0].glyphs).toHaveLength(2);
    expect(legs[1].glyphs).toHaveLength(1);
    expect(legs[0].labels.some((l) => l.kind === "mark")).toBe(true);
    expect(legs[1].labels.some((l) => l.kind === "mark")).toBe(false);
  });
});
