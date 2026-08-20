// Which modeled unit(s) a ?mark=/?pkg= deep link should glow (Studio 100x
// #16 — job-building glow). Same translucent-orange box ContainerViewer
// already draws for a warehouse zone (0xff5a36 @ 0.28), aimed at a specific
// unit's mesh bounds instead of a zone rectangle; the box math itself lives
// in JobModelViewer.tsx next to the three.js scene it touches. PURE here:
// only the "which unit(s)" decision, twin-aware like every other mark match
// in this app (liveOverlay.ts, fromProject.ts).

import { normalizeMarkCode } from "../fitview/adapter";
import type { StoragePackage } from "../storage";
import { markKeyOf } from "./fromProject";

/**
 * The mark a `?pkg=SERIAL` deep link resolves to, so JobModelViewer never
 * has to know package_marks' shape itself. First mark wins — the same
 * convention PackageSheet's reprint button already uses (a package that
 * carries more than one mark is a data problem for tagging to fix, not
 * something a glow link should try to disambiguate). Null when the package
 * has nothing tagged yet — nothing to point at.
 */
export function markOfPackage(
  pkg: Pick<StoragePackage, "package_marks"> | null | undefined,
): string | null {
  const code = pkg?.package_marks?.[0]?.mark_code?.trim();
  return code ? code : null;
}

/**
 * Which of a job's modeled unit names (StudioItem `itemName`s, as loaded
 * into the scene) a mark query should glow.
 *
 * An EXACT opening code ("16-1", dialect-normalized) glows only that one
 * twin — the precise case, when the link came from a specific opening.
 * Failing that, a BASE mark ("16", what a package is tagged with per
 * liveOverlay.ts's own convention) glows every unit sharing it: one for an
 * ordinary window, both twins for a pair nobody targeted more precisely.
 * Never both tiers at once — an exact hit is always the more specific
 * answer the caller meant.
 */
export function unitsForMark(itemNames: readonly string[], code: string): string[] {
  const trimmed = code.trim();
  if (!trimmed) return [];
  const exact = itemNames.filter((n) => normalizeMarkCode(n) === normalizeMarkCode(trimmed));
  if (exact.length > 0) return exact;
  const base = markKeyOf(trimmed);
  return itemNames.filter((n) => markKeyOf(n) === base);
}
