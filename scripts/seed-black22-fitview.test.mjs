#!/usr/bin/env node
// Test for scripts/lib/fitview-seed.mjs, seed-black22-fitview.mjs's merge
// helper. Dependency-free and offline: the helper is pure, split into its
// own lib module precisely so it can be imported without also running the
// script's top-level I/O (fixture read, DB calls, process.exit on plan
// mode). See scripts/supabase-key.test.mjs for the same convention.

import assert from "node:assert/strict";
import { mergeFitviewSeed } from "./lib/fitview-seed.mjs";

const building = { height: 3.6, footprints: [] };
const windows = [{ id: "1A" }];

// --- a fresh seed (no previous row) writes exactly the four fields ---------

const fresh = mergeFitviewSeed(null, 24.5, 3.6, building, windows);
assert.deepEqual(fresh, {
  dividers: [],
  wallOpenings: [],
  fitview: {
    longSideM: 24.5,
    wallHeightM: 3.6,
    source: "window-viewer win-2423 hand trace",
    model: { building, windows },
  },
});

// --- the footgun this closes: a re-run must not wipe a key it doesn't know
// about (wave N's northDeg, set by hand in the tracer since the last seed) --

const prevFeatures = {
  dividers: [{ id: "d1" }], // a Plan Model editor annotation, irrelevant here
  fitview: {
    longSideM: 24.5,
    wallHeightM: 3.6,
    northDeg: 12.5,
    source: "window-viewer win-2423 hand trace",
    model: { building: { height: 3, footprints: [] }, windows: [] },
  },
};
const merged = mergeFitviewSeed(prevFeatures, 24.5, 3.6, building, windows);
assert.equal(
  merged.fitview.northDeg,
  12.5,
  "a re-run must carry an unknown fitview key (northDeg) forward",
);
// This script's own fields still refresh to the fixture's current values.
assert.deepEqual(merged.fitview.model, { building, windows });
assert.equal(merged.fitview.source, "window-viewer win-2423 hand trace");

// --- a top-level key this script doesn't own (features.modelstudio) survives
// a merge the same way — the fix is generic, not northDeg-specific ---------

const withStudio = mergeFitviewSeed(
  { modelstudio: { floors: ["x"] }, fitview: { longSideM: 1, wallHeightM: 1, source: "s", model: {} } },
  24.5,
  3.6,
  building,
  windows,
);
assert.deepEqual(withStudio.modelstudio, { floors: ["x"] });

console.log("scripts/seed-black22-fitview.mjs: all assertions passed");
