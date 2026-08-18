// "Do I have everything for this window?" — the completeness read model
// (warehouse ticket 03).
//
// Everything here is READ off the manufacturer's part numbers stored at
// tagging (ticket 02): the label's "#16 2/3" says piece 2 of 3, so the first
// package to arrive declares how many pieces the window ships as. Nothing is
// ever assumed — a window whose labels carry no numbers gets "what's tagged
// is all we know", never a guessed parts list (CONTEXT.md: completeness is
// read off the labels, never assumed).
//
// Pure functions over already-fetched packages: the opening sheet reuses the
// hub's package query, so this stays testable in Node and free of Supabase.

import type { StoragePackage } from "../storage";

export interface UnitPartsReport {
  /** Every non-blank package tagged with this mark on this job, reading order:
   * numbered parts first (by index), unnumbered after, ties by serial. */
  rows: StoragePackage[];
  /** How many pieces the window ships as — the one total the labels agree on,
   * or null when no label carried a number. */
  expectedTotal: number | null;
  /** Two labels claim different totals. The app refuses to pick a side; a
   * foreman settles it (grill Q28). No completeness is claimed meanwhile. */
  totalsDisagree: boolean;
  /** Distinct part numbers physically HERE, sorted. A minted label — printed
   * for material that has not arrived (ticket 15) — raises the expected total
   * the moment it is declared, but never counts as present: "2 of 4 here"
   * with two labels on a boat would be the app lying about a shelf. */
  presentIndexes: number[];
  /** Part numbers whose label exists but whose material has not arrived. */
  onTheWayIndexes: number[];
  /** Part numbers no label has claimed AT ALL — not here, not minted. Only
   * meaningful when a total is known and undisputed. "No label yet", NOT
   * "not arrived": the piece may be sitting right there unnumbered. */
  missingIndexes: number[];
  /** True/false when knowable; null when no total exists to judge against. */
  complete: boolean | null;
}

export function unitParts(
  packages: StoragePackage[],
  projectId: string,
  markCode: string,
): UnitPartsReport {
  const mark = markCode.trim().toUpperCase();
  const rows = packages
    .filter(
      (p) =>
        p.project_id === projectId &&
        (p.package_marks ?? []).some((m) => m.mark_code === mark),
    )
    .sort((a, b) => {
      const ai = a.part_index ?? Number.MAX_SAFE_INTEGER;
      const bi = b.part_index ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.serial.localeCompare(b.serial);
    });

  const totals = [...new Set(rows.map((p) => p.part_total).filter((t): t is number => t != null))];
  const totalsDisagree = totals.length > 1;
  const expectedTotal = totals.length === 1 ? totals[0] : null;

  const presentIndexes = [
    ...new Set(
      rows
        .filter((p) => p.status !== "minted")
        .map((p) => p.part_index)
        .filter((i): i is number => i != null),
    ),
  ].sort((a, b) => a - b);

  const onTheWayIndexes = [
    ...new Set(
      rows
        .filter((p) => p.status === "minted")
        .map((p) => p.part_index)
        .filter((i): i is number => i != null),
    ),
  ]
    .filter((i) => !presentIndexes.includes(i))
    .sort((a, b) => a - b);

  const missingIndexes =
    expectedTotal !== null && !totalsDisagree
      ? Array.from({ length: expectedTotal }, (_, i) => i + 1).filter(
          (i) => !presentIndexes.includes(i) && !onTheWayIndexes.includes(i),
        )
      : [];

  // Complete means physically HERE — a window whose glass is minted-but-on-a-
  // boat is not complete, however tidy its paperwork.
  const complete =
    expectedTotal !== null && !totalsDisagree
      ? presentIndexes.length === expectedTotal
      : null;

  return {
    rows,
    expectedTotal,
    totalsDisagree,
    presentIndexes,
    onTheWayIndexes,
    missingIndexes,
    complete,
  };
}

export type PartsTone = "ok" | "warn" | "muted";

/**
 * The one-line verdict above the rows. Green only when every numbered piece
 * is accounted for; amber when something is knowably absent or the labels
 * fight; muted when there is nothing to judge against.
 */
export function partsHeadline(r: UnitPartsReport): { text: string; tone: PartsTone } {
  if (r.rows.length === 0) {
    return { text: "Nothing tagged for this window yet", tone: "muted" };
  }
  if (r.totalsDisagree) {
    return {
      text: "The labels disagree on how many parts this window has — a foreman should settle it",
      tone: "warn",
    };
  }
  if (r.expectedTotal === null) {
    const n = r.rows.length;
    return {
      text: `${n} package${n === 1 ? "" : "s"} here · labels carry no part numbers`,
      tone: "muted",
    };
  }
  if (r.complete) {
    return { text: `${r.expectedTotal} of ${r.expectedTotal} · all here`, tone: "ok" };
  }
  // Labels exist for everything that is not here: the declared-and-waiting
  // state, normal before a delivery. Muted, not amber — the alarm belongs to
  // parts NOBODY has printed a label for.
  if (r.missingIndexes.length === 0 && r.onTheWayIndexes.length > 0) {
    return {
      text: `${r.presentIndexes.length} of ${r.expectedTotal} here · ${r.onTheWayIndexes.length} on the way`,
      tone: "muted",
    };
  }
  const missing = r.missingIndexes.join(", ");
  return {
    text:
      `${r.presentIndexes.length} of ${r.expectedTotal} here · no label yet for part${
        r.missingIndexes.length === 1 ? "" : "s"
      } ${missing}` +
      (r.onTheWayIndexes.length > 0 ? ` · ${r.onTheWayIndexes.length} on the way` : ""),
    tone: "warn",
  };
}
