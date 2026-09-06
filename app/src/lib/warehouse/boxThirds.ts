// A box you can see into (warehouse redesign wave 3): front, middle, back,
// drawn from the door end, and a row for what nobody has placed yet. The
// area column is a pointer, not a place (ADR-0006) — a finer "front-left"
// still counts as front here, because the picture is three thirds and the
// thing to answer is "which end do I walk to". Pure, so the grouping is
// testable without a screen.

import type { StoragePackage } from "../storage";

export type Third = "front" | "middle" | "back";
export const THIRDS: readonly Third[] = ["front", "middle", "back"];

export interface BoxThirdsGroups {
  front: StoragePackage[];
  middle: StoragePackage[];
  back: StoragePackage[];
  /** Stored here but never pointed at a third. */
  unplaced: StoragePackage[];
}

export function thirdOf(area: string | null | undefined): Third | null {
  if (!area) return null;
  const a = area.toLowerCase();
  if (a.startsWith("front")) return "front";
  if (a.startsWith("middle")) return "middle";
  if (a.startsWith("back")) return "back";
  return null;
}

export function groupByThird(stored: readonly StoragePackage[]): BoxThirdsGroups {
  const g: BoxThirdsGroups = { front: [], middle: [], back: [], unplaced: [] };
  for (const p of stored) {
    const t = thirdOf(p.area);
    if (t) g[t].push(p);
    else g.unplaced.push(p);
  }
  return g;
}

/** Whether a box's kind has a door end to count from. The building has the
 *  compass instead (ADR-0006) and keeps its own picker for now. */
export function hasThirds(kind: string | null | undefined): boolean {
  const k = (kind ?? "conex").toLowerCase();
  return k !== "building";
}
