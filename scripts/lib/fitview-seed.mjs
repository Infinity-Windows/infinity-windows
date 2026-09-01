// Pure helpers for scripts/seed-black22-fitview.mjs, split out so they can
// be imported by its test without pulling in the script's top-level I/O
// (fixture read, DB calls, process.exit on plan-mode) as a side effect.

/**
 * Merge a fresh seed's fitview write onto whatever `features` the row
 * already carries. Copies the merge pattern ModelStudio.tsx's save() uses
 * (`{ ...prev, modelstudio: body }`): spread the previous object, then apply
 * only the fields THIS writer owns. Protects a key this script has never
 * heard of — wave N's northDeg, set by hand in the tracer after a seed ran —
 * from a blind overwrite on a later --apply; the CLAUDE.md-documented
 * footgun. `dividers`/`wallOpenings` still reset to empty on every run —
 * this script has never carried those forward, and that stays unchanged.
 */
export function mergeFitviewSeed(prevFeaturesRaw, longSideM, buildingHeight, building, windows) {
  const prev =
    prevFeaturesRaw && typeof prevFeaturesRaw === "object" ? prevFeaturesRaw : {};
  const prevFitview =
    prev.fitview && typeof prev.fitview === "object" ? prev.fitview : {};
  return {
    ...prev,
    dividers: [],
    wallOpenings: [],
    fitview: {
      ...prevFitview,
      longSideM: +longSideM.toFixed(2),
      wallHeightM: buildingHeight,
      source: "window-viewer win-2423 hand trace",
      model: { building, windows },
    },
  };
}
