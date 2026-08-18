// The planning panel's row model (ticket 15), pure so it can be tested
// without mounting the 2,700-line job page.
//
// One row per scheduled window: what is declared, what exists, what is here,
// and whether the Mint button has anything honest to do.

import type { StoragePackage } from "../storage";
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
}

export function markPlanRow(
  packages: StoragePackage[],
  projectId: string,
  markCode: string,
): MarkPlanRow {
  const r = unitParts(packages, projectId, markCode);
  return {
    markCode,
    declared: r.expectedTotal,
    labeled: r.rows.length,
    here: r.presentIndexes.length,
    onTheWay: r.onTheWayIndexes.length,
    totalsDisagree: r.totalsDisagree,
  };
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
