import type { UnitConfig } from "./units";

/**
 * The unit config the panel editor shows for the SELECTED unit — DERIVED
 * for the editor, never written back to the item.
 *
 * Selection is read-only (owner, 2026-09-02, Mad Moose live pilot: tapping
 * one of the three Adds on the office glass wall mirrored its label
 * "Add-1" -> "I-bbA" and re-split its panels). A unit that carries a real
 * `panels` config shows its own, returned by IDENTITY so nothing about it
 * changes. A legacy generic saved before the 2026-08-13 metadata fix lost
 * its panels; it still needs W/H in the editor, so it gets a single fixed
 * panel sized to its current measured footprint.
 *
 * This helper only READS the measured size — it never calls `placeInRoom`
 * (which re-seats the unit on its nearest wall and can re-face it, the
 * mirror) or `applyUnitGeometry` (which re-splits the panels). The heal
 * that used to run here on SELECT now runs on the first real edit
 * (`applyUnitEdits`), where a mutation is exactly what the owner asked for.
 */
export interface EditableUnitSource {
  /** `item.metadata?.unitConfig` — the stored parametric config, if any. */
  unitConfig?: UnitConfig | null;
  /** `item.getHeight()` — measured height in cm. */
  getHeight(): number;
  /** `item.getWidth()` — measured width in cm. */
  getWidth(): number;
}

export function editableUnitConfig(item: EditableUnitSource): UnitConfig {
  const stored = item.unitConfig;
  if (stored?.panels?.length) return stored;
  return {
    kind: "window",
    heightMm: Math.max(200, Math.round(item.getHeight() * 10)),
    panels: [
      { widthMm: Math.max(200, Math.round(item.getWidth() * 10)), mechanism: "fixed" },
    ],
  };
}
