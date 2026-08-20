// The planning panel's row model (ticket 15), pure so it can be tested
// without mounting the 2,700-line job page.
//
// One row per scheduled window: what is declared, what exists, what is here,
// and whether the Mint button has anything honest to do.

import type { StoragePackage } from "../storage";
import type { UnitConfig } from "../modelstudio/units";
import { unitParts } from "./unitParts";

export interface MarkPlanRow {
  markCode: string;
  /** The one total the labels agree on, or null when nothing is declared. */
  declared: number | null;
  /** Labels that exist for this window, any stage. */
  labeled: number;
  /** Physically here (received/stored — not minted, not checked out). */
  here: number;
  onTheWay: number;
  /** The labels disagree about the total; minting is refused until settled. */
  totalsDisagree: boolean;
  /** suggestedPackageCount's read of the mark's resolved model, or null
   * when no config resolved (no catalog unit, no spec) — see that function. */
  suggestedCount: number | null;
}

export function markPlanRow(
  packages: StoragePackage[],
  projectId: string,
  markCode: string,
  config: UnitConfig | null = null,
): MarkPlanRow {
  const r = unitParts(packages, projectId, markCode);
  return {
    markCode,
    declared: r.expectedTotal,
    labeled: r.rows.length,
    here: r.presentIndexes.length,
    onTheWay: r.onTheWayIndexes.length,
    totalsDisagree: r.totalsDisagree,
    suggestedCount: config ? suggestedPackageCount(config) : null,
  };
}

/**
 * A STARTING POINT for "arrives as N pieces" when minting labels for a
 * mark — a heuristic read off the Studio model, never a rule: real packing
 * varies by manufacturer, job and truck, and the foreman minting labels
 * always has the last word (the input this feeds stays editable).
 *
 * The heuristic (documented here because it is exactly this, no more): one
 * frame, plus one glass piece per panel (every panel in a UnitConfig is a
 * glazed pane), plus one hardware/parts box when the unit isn't all-fixed —
 * a slider, hung, bifold or casement panel usually ships its track/balance/
 * hinge hardware as its own piece. All-fixed units never need that piece.
 */
export function suggestedPackageCount(config: UnitConfig): number {
  const hasMovingPanel = config.panels.some((p) => p.mechanism !== "fixed");
  const FRAME = 1;
  const HARDWARE = hasMovingPanel ? 1 : 0;
  return FRAME + config.panels.length + HARDWARE;
}

/** The label line printed on a pre-bound sticker: "BLACK22 · W16 · 2 of 4". */
export function bindLine(
  jobCode: string | null,
  markCode: string,
  partIndex: number | null,
  partTotal: number | null,
): string {
  const job = jobCode ?? "job";
  const part =
    partIndex != null && partTotal != null ? ` · ${partIndex} of ${partTotal}` : "";
  return `${job} · W${markCode}${part}`;
}
