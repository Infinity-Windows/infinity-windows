// The pane_grid rescan law (wave G, receipts precedent): a mark that already
// has a pane_grid on file keeps it through every future specs extraction run,
// confirmed row or not. `extractAndSaveMarkSpecs` (lib/install/api.ts) upserts
// the WHOLE `extra` column on every unconfirmed mark's re-extract — that part
// is existing, unchanged behavior — so without this carve-out a second vision
// pass reading the SAME drawing slightly differently would silently replace a
// grid a foreman may already be relying on. `preservePaneGrid` is the pure
// piece of that law: given what a fresh extraction draft found and whatever
// pane_grid already sits on the row, decide what `extra` gets saved.

import { describe, expect, it } from "vitest";
import { preservePaneGrid } from "./api";
import { madMooseMark7Grid } from "./specs";

describe("preservePaneGrid", () => {
  it("fills pane_grid when the row has none yet (first extraction)", () => {
    const draftExtra = { pane_grid: madMooseMark7Grid, qty: "1" };
    expect(preservePaneGrid(draftExtra, undefined)).toEqual(draftExtra);
    expect(preservePaneGrid(draftExtra, null)).toEqual(draftExtra);
  });

  it("never overwrites an existing pane_grid, even with a different new read", () => {
    const staleFlatGrid = { columns: [{ segments: [{ op: "F" as const }] }] };
    const draftExtra = { pane_grid: staleFlatGrid, qty: "1" };
    const result = preservePaneGrid(draftExtra, madMooseMark7Grid);
    expect(result?.pane_grid).toBe(madMooseMark7Grid);
    expect(result?.pane_grid).not.toEqual(staleFlatGrid);
  });

  it("preserves the existing grid even when this run's draft found none", () => {
    // e.g. a deterministic-text-only rescan whose draft never touched extra.
    expect(preservePaneGrid(null, madMooseMark7Grid)).toEqual({
      pane_grid: madMooseMark7Grid,
    });
  });

  it("leaves every other extra key from this run untouched", () => {
    const draftExtra = { qty: "2", corner: { after_panel: 0, side: "left" } };
    const result = preservePaneGrid(draftExtra, madMooseMark7Grid);
    expect(result).toEqual({
      qty: "2",
      corner: { after_panel: 0, side: "left" },
      pane_grid: madMooseMark7Grid,
    });
  });

  it("is a no-op pass-through (including null) when there is nothing on file", () => {
    expect(preservePaneGrid(null, undefined)).toBeNull();
  });
});
