// Pure helpers for scripts/seed-madmoose-fitview.mjs, split out (same
// reason as fitview-seed.mjs) so the test can import them without the
// script's top-level I/O and plan-mode process.exit running as a side
// effect.

/**
 * Patch the LIVE building instead of replacing it: heights come from the
 * elevations, geometry stays the owner's. Stories are patched by index
 * (elevM/heightM only) so a story's own footprints — including the traced
 * interior partition — ride through untouched. Pure; tested.
 */
export function patchBuilding(liveBuilding, patch) {
  const b = JSON.parse(JSON.stringify(liveBuilding ?? {}));
  b.height = patch.height;
  if (Array.isArray(b.stories)) {
    b.stories = b.stories.map((s, i) => {
      const p = patch.stories[i];
      return p ? { ...s, elevM: p.elevM, heightM: p.heightM } : s;
    });
  }
  return b;
}

/**
 * Merge this seed's fitview write onto the row's existing features. Unlike
 * mergeFitviewSeed (BLACK22), this NEVER resets dividers/wallOpenings and
 * never replaces keys it doesn't own — MADMOOSE has live Plan Model and
 * Studio data riding in the same column. Pure; tested.
 */
export function mergeMadmooseFeatures(prevFeaturesRaw, building, windows, wallHeightM) {
  const prev =
    prevFeaturesRaw && typeof prevFeaturesRaw === "object" ? prevFeaturesRaw : {};
  const prevFitview =
    prev.fitview && typeof prev.fitview === "object" ? prev.fitview : {};
  return {
    ...prev,
    fitview: {
      ...prevFitview,
      wallHeightM,
      source: "claude-cad-read mm2 (2026-08-31)",
      model: { building, windows },
    },
  };
}

/** Fill-missing-only pane grid for one spec row (wave-G contract). Pure. */
export function extraWithPaneGrid(extraRaw, grid) {
  const extra = extraRaw && typeof extraRaw === "object" ? extraRaw : {};
  if (extra.pane_grid) return null; // already present — never overwrite
  return { ...extra, pane_grid: grid };
}


/**
 * Base windows plus the Add units, deduped by id (a re-apply after an Add
 * already landed must not double it; adds win over a same-id base entry).
 * Pure; tested.
 */
export function combineWindows(base, adds) {
  const byId = new Map();
  for (const w of base || []) byId.set(w.id, w);
  for (const w of adds || []) byId.set(w.id, w);
  return [...byId.values()];
}
