// Pane-grid editing: shared mullion lines mean a pane's dims are its
// column/row's dims, splits stay physical, and a corner survives splits.

import { describe, expect, it } from "vitest";
import {
  setColumnWidthMm,
  setRowHeightMm,
  splitColumn,
  splitRow,
  type UnitConfig,
} from "./units";

const CFG: UnitConfig = {
  kind: "window",
  heightMm: 2000,
  panels: [
    { widthMm: 800, mechanism: "fixed" },
    { widthMm: 1200, mechanism: "slider", direction: "left" },
  ],
  cornerAfterPanel: 0,
};

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
