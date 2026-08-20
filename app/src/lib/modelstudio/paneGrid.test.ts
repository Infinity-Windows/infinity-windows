// Pane-grid editing: shared mullion lines mean a pane's dims are its
// column/row's dims, splits stay physical, and a corner survives splits.

import { describe, expect, it } from "vitest";
import {
  applyPanePreset,
  setColumnWidthMm,
  setRowHeightMm,
  slideCountOf,
  specToUnitConfig,
  splitColumn,
  splitRow,
  type UnitConfig,
} from "./units";
import type { ProjectMarkSpec } from "../install/specs";

const CFG: UnitConfig = {
  kind: "window",
  heightMm: 2000,
  panels: [
    { widthMm: 800, mechanism: "fixed" },
    { widthMm: 1200, mechanism: "slider", direction: "left" },
  ],
  cornerAfterPanel: 0,
};

describe("specToUnitConfig with drawing-read panels", () => {
  const base: ProjectMarkSpec = {
    mark_code: "16", style: "Fixed Window", glass: null, color: null,
    size_code: null, width_in: 313.5, height_in: 179.5, operation: "Fixed",
    tempered: null, egress: null, u_factor: null, shgc: null, grids: null,
    screen: null, product_line: null, extra: null, image_page: null,
    image_bbox: null, planset_id: null, confirmed: false, source: "ai",
    id: "s16", project_id: "p", created_at: "", updated_at: "",
  };

  it("prefers extra.panels — window 16 arrives with its exact five widths", () => {
    const spec: ProjectMarkSpec = {
      ...base,
      extra: {
        panels: [
          { width_in: 30.25, op: "F" },
          { width_in: 88.5, op: "F" },
          { width_in: 90, op: "F" },
          { width_in: 87.75, op: "F" },
          { width_in: 17, op: "F" },
        ],
        corner: { after_panel: 0, side: "left" },
      },
    };
    const cfg = specToUnitConfig(spec)!;
    expect(cfg.panels).toHaveLength(5);
    expect(cfg.panels[0].widthMm).toBeCloseTo(30.25 * 25.4, 1);
    expect(cfg.panels.every((p) => p.mechanism === "fixed")).toBe(true);
    expect(cfg.cornerAfterPanel).toBe(0);
  });

  it("marks X panels operable and derives a side-only corner", () => {
    const spec: ProjectMarkSpec = {
      ...base,
      operation: "XO",
      extra: {
        panels: [
          { width_in: 36, op: "X" },
          { width_in: 36, op: "O" },
          { width_in: 36, op: "O" },
        ],
        corner: { side: "right" },
      },
    };
    const cfg = specToUnitConfig(spec)!;
    expect(cfg.panels[0].mechanism).toBe("slider");
    expect(cfg.panels[1].mechanism).toBe("fixed");
    expect(cfg.cornerAfterPanel).toBe(1); // right side ⇒ before the last panel
  });

  it("falls back to operation splitting when the drawing gave no panels", () => {
    const cfg = specToUnitConfig({ ...base, operation: "XO", width_in: 72, height_in: 48 })!;
    expect(cfg.panels).toHaveLength(2);
    expect(cfg.panels[0].widthMm).toBeCloseTo(cfg.panels[1].widthMm, 6);
  });

  // Studio 100x #47: a spec's free-text color/finish prefills frameColor —
  // both the drawn-panels path and the operation-splitting fallback.
  it("reads frameColor from the spec's color field on import", () => {
    expect(specToUnitConfig({ ...base, color: "Black (Aluminum Profile Color)" })!.frameColor).toBe(
      "black",
    );
    expect(specToUnitConfig({ ...base, color: "Dark Bronze" })!.frameColor).toBe("bronze");
    expect(
      specToUnitConfig({
        ...base,
        color: "Black (Aluminum Profile Color)",
        operation: "XO",
        width_in: 72,
        height_in: 48,
      })!.frameColor,
    ).toBe("black");
  });

  it("leaves frameColor unset for white, blank, or an unrecognized finish", () => {
    expect(specToUnitConfig({ ...base, color: "White" })!.frameColor).toBeUndefined();
    expect(specToUnitConfig({ ...base, color: null })!.frameColor).toBeUndefined();
    expect(specToUnitConfig({ ...base, color: "Anodized Silver" })!.frameColor).toBeUndefined();
  });
});

describe("pane grid ops", () => {
  it("typing a pane's width resizes its whole column; total follows", () => {
    const next = setColumnWidthMm(CFG, 1, 900);
    expect(next.panels[1].widthMm).toBe(900);
    expect(next.panels[0].widthMm).toBe(800);
  });

  it("typing a pane's height resizes its row without squashing the others", () => {
    const grid = splitRow(CFG, 0); // 2 rows of 1000
    const next = setRowHeightMm(grid, 1, 600);
    expect(next.rows).toEqual([{ heightMm: 1000 }, { heightMm: 600 }]);
    expect(next.heightMm).toBe(1600); // total follows
  });

  it("splitColumn halves the pane, keeps the mechanism, shifts the corner", () => {
    const next = splitColumn(CFG, 0);
    expect(next.panels.map((p) => p.widthMm)).toEqual([400, 400, 1200]);
    expect(next.panels[1].mechanism).toBe("fixed");
    // The corner was after column 0; the split pushes it to after column 1.
    expect(next.cornerAfterPanel).toBe(1);
    // A split RIGHT of the corner leaves it alone.
    expect(splitColumn(CFG, 1).cornerAfterPanel).toBe(0);
  });

  it("splitRow starts a grid from a flat unit", () => {
    const next = splitRow(CFG, 0);
    expect(next.rows).toEqual([{ heightMm: 1000 }, { heightMm: 1000 }]);
    expect(next.heightMm).toBe(2000);
  });
});

describe("pane presets (pairs)", () => {
  const three: UnitConfig = {
    kind: "window",
    heightMm: 1800,
    panels: [
      { widthMm: 900, mechanism: "fixed" },
      { widthMm: 900, mechanism: "fixed" },
      { widthMm: 900, mechanism: "fixed" },
    ],
  };

  it("middle-pair: selected pane slides left, its neighbour slides right", () => {
    const next = applyPanePreset(three, 1, "middle-pair");
    expect(next.panels[1]).toMatchObject({ mechanism: "slider", direction: "left" });
    expect(next.panels[2]).toMatchObject({ mechanism: "slider", direction: "right" });
    expect(next.panels[0].mechanism).toBe("fixed");
  });

  it("french-pair hinges at the outer stiles", () => {
    const next = applyPanePreset(three, 0, "french-pair");
    expect(next.panels[0]).toMatchObject({ mechanism: "casement", direction: "left" });
    expect(next.panels[1]).toMatchObject({ mechanism: "casement", direction: "right" });
  });

  it("splits a single-panel unit in half first; last-column picks clamp back", () => {
    const one: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 1600, mechanism: "fixed" }],
    };
    const next = applyPanePreset(one, 0, "middle-pair");
    expect(next.panels).toHaveLength(2);
    expect(next.panels.map((p) => p.widthMm)).toEqual([800, 800]);
    expect(next.panels[0].direction).toBe("left");
    expect(next.panels[1].direction).toBe("right");
    // Selecting the LAST column pairs with the neighbour on its left.
    const last = applyPanePreset(three, 2, "french-pair");
    expect(last.panels[1].direction).toBe("left");
    expect(last.panels[2].direction).toBe("right");
  });
});

describe("slideCountOf", () => {
  it("clamps to 1–8 and only applies to sliders", () => {
    const s = (slideCount?: number) =>
      slideCountOf({ widthMm: 900, mechanism: "slider", direction: "left", slideCount });
    expect(s()).toBe(1);
    expect(s(3)).toBe(3);
    expect(s(0)).toBe(1);
    expect(s(99)).toBe(8);
    expect(s(Number.NaN)).toBe(1);
    expect(slideCountOf({ widthMm: 900, mechanism: "casement", slideCount: 5 })).toBe(1);
  });
});
