#!/usr/bin/env node
// Pure checks for the MADMOOSE hand-read seed: the fixture's arithmetic must
// agree with the CAD sheets, and the merge/patch helpers must never touch
// what they don't own. Run: node scripts/seed-madmoose-fitview.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  patchBuilding,
  mergeMadmooseFeatures,
  extraWithPaneGrid,
  combineWindows,
} from "./lib/madmoose-seed.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = JSON.parse(
  readFileSync(join(root, "app/src/lib/fitview/fixtures/madmoose-mm2.json"), "utf8"),
);

// --- fixture arithmetic vs the CAD sheets ---
assert.equal(fx.windows.length, 10, "ten marks");
assert.equal(new Set(fx.windows.map((w) => w.id)).size, 10, "unique mark ids");
assert.deepEqual(
  fx.paneGrids["1"], fx.paneGrids["7"],
  "marks 1 and 7 are the same drawing on CU-1 and CU-3",
);
for (const [mark, grid] of Object.entries(fx.paneGrids)) {
  const win = fx.windows.concat(fx.addWindows).find((w) => w.id === mark);
  const colSum = grid.columns.reduce((a, c) => a + c.width_in, 0);
  assert.ok(
    Math.abs(colSum * 25.4 - win.w) < 26,
    `mark ${mark}: grid columns (${colSum} in) must sum to the unit width (${win.w} mm)`,
  );
  for (const col of grid.columns) {
    const segSum = col.segments.reduce((a, s) => a + s.height_in, 0);
    assert.ok(
      Math.abs(segSum * 25.4 - win.h) < 26,
      `mark ${mark}: a column's segments (${segSum} in) must sum to the unit height (${win.h} mm)`,
    );
  }
}
const storefront = fx.paneGrids["1"];
const fCount = storefront.columns.flatMap((c) => c.segments).filter((s) => s.op === "F").length;
const doorCount = storefront.columns.flatMap((c) => c.segments).filter((s) => s.op === "door").length;
assert.equal(fCount, 8, "storefront: 8 fixed lites");
assert.equal(doorCount, 2, "storefront: 2 door leaves");
assert.equal(fx.windows.filter((w) => w.floor === "Level 2").length, 1, "only mark 9 is upstairs");

// --- patchBuilding keeps the owner's geometry ---
const live = {
  height: 6, width: 31.9, depth: 24.5,
  footprints: [[{ x: 0, z: 0 }], [{ x: 1, z: 1 }]],
  trace: { dots: { 1: { x: 5, y: 5 } } },
  stories: [
    { n: 1, name: "Ground", elevM: 0, heightM: 3, footprints: [["main"], ["partition"]] },
    { n: 2, name: "Level 2", elevM: 3, heightM: 3, footprints: [["main"]] },
  ],
};
const patched = patchBuilding(live, fx.buildingPatch);
assert.equal(patched.height, 7.62, "height corrected to the 25 ft parapet");
assert.equal(patched.stories[0].heightM, 3.35, "ground to the 11 ft subfloor");
assert.equal(patched.stories[1].elevM, 3.35, "level 2 starts at the subfloor");
assert.deepEqual(patched.stories[0].footprints, [["main"], ["partition"]],
  "the traced interior partition survives");
assert.deepEqual(patched.trace, live.trace, "the trace survives");
assert.equal(live.height, 6, "the live object itself is never mutated");

// --- mergeMadmooseFeatures owns only fitview.model/wallHeightM/source ---
const prev = {
  dividers: [{ a: 1 }],
  wallOpenings: [{ b: 2 }],
  modelstudio: { savedAt: "x" },
  fitview: { longSideM: 31.88, northDeg: 14, model: { building: live, windows: [] } },
};
const merged = mergeMadmooseFeatures(prev, patched, fx.windows, 7.62);
assert.deepEqual(merged.dividers, [{ a: 1 }], "dividers survive (unlike the BLACK22 seed)");
assert.deepEqual(merged.wallOpenings, [{ b: 2 }], "wallOpenings survive");
assert.deepEqual(merged.modelstudio, { savedAt: "x" }, "the Studio save survives");
assert.equal(merged.fitview.northDeg, 14, "a hand-set north survives (wave N law)");
assert.equal(merged.fitview.longSideM, 31.88, "the owner's calibration survives");
assert.equal(merged.fitview.model.windows.length, 10, "the ten windows land");
assert.equal(merged.fitview.wallHeightM, 7.62);

// --- pane grid fill-missing law ---
assert.equal(extraWithPaneGrid({ pane_grid: { columns: [] } }, fx.paneGrids["1"]), null,
  "an existing grid is never overwritten");
const fresh = extraWithPaneGrid({ qty: "1", panels: [1, 2] }, fx.paneGrids["5"]);
assert.deepEqual(fresh.panels, [1, 2], "existing extra keys survive");
assert.ok(fresh.pane_grid, "the grid lands where none existed");

// --- the Add units (MMV2A - CU) ---
assert.equal(fx.addWindows.length, 3, "three add units");
assert.equal(fx.addSpecs.length, 3, "three add specs");
for (const w of fx.addWindows) {
  assert.equal(w.elev, "s7", `${w.id} rides the lobby-facing glass wall (East 2)`);
  assert.ok(w.x >= 0 && w.x + w.w / 1000 <= 12.1, `${w.id} fits the East 2 wall (~12 m)`);
}
const combined = combineWindows(fx.windows, fx.addWindows);
assert.equal(combined.length, 13, "ten originals + three adds");
assert.equal(combineWindows(combined, fx.addWindows).length, 13, "re-apply never doubles an add");
for (const spec of fx.addSpecs) {
  const grid = fx.paneGrids[spec.mark_code];
  const colSum = grid.columns.reduce((a, c) => a + c.width_in, 0);
  assert.ok(Math.abs(colSum - spec.width_in) < 0.6, `${spec.mark_code} grid sums to its width`);
  assert.equal(grid.columns[0].segments[0].op, "door", `${spec.mark_code} leads with its French door`);
}
console.log("seed-madmoose-fitview: all assertions passed");
