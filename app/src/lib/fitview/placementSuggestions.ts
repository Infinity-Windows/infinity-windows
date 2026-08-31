// Pure logic for vision placement's suggestion lifecycle (wave V-A). No DOM,
// no network, no React — traceRenderer.ts works in plan-image PIXELS and
// knows nothing about normalized pin coordinates or the database; MapsTrace.tsx
// is the boundary that converts between the two and persists the result. This
// module is that boundary's logic, kept apart from both so it can be tested
// against real numbers instead of a mounted tracer.
//
// The two laws this file exists to keep testable:
//
//   CAD-WINS. `resolvePlacements` only ever returns a suggestion for a mark
//   that was in the KNOWN list handed to extract-placement; anything else is
//   `unknownMarks`, never fabricated into a placement.
//
//   RESCAN NEVER OVERWRITES A CONFIRMED PLACEMENT. `filterUnconfirmed` is the
//   client-side mirror of apply_placement_suggestions' SQL guard
//   (`pin_x is null`) — belt and suspenders: the database is the real
//   enforcement, this just keeps a stale suggestion from ever being sent for
//   a mark the foreman already placed.

import { normalizeMarkCode } from "./adapter";

/** A raw {mark, x, y, page, confidence} row as extract-placement returns it. */
export interface RawPlacementRow {
  mark: string;
  x: number;
  y: number;
  page: number;
  confidence: number;
}

/** One still-unplaced opening, as much as this module needs to know about it. */
export interface UnplacedMark {
  id: string;
  code: string;
}

/** A raw placement resolved to a real opening id. */
export interface ResolvedPlacement {
  openingId: string;
  markCode: string;
  x: number;
  y: number;
  page: number;
  confidence: number;
}

export interface ResolvePlacementsResult {
  suggestions: ResolvedPlacement[];
  /** Known marks the read never located on any floor-plan page. */
  notFoundMarks: string[];
}

/**
 * Match extract-placement's raw rows back to real openings by normalized mark
 * code, and report which known marks were never found. A raw row that
 * doesn't match any `unplaced` mark is silently dropped (defensive only —
 * extract-placement already enforces the known-marks allowlist server-side,
 * so this should never trigger in practice).
 */
export function resolvePlacements(
  unplaced: UnplacedMark[],
  rawPlacements: RawPlacementRow[],
): ResolvePlacementsResult {
  const byCode = new Map(unplaced.map((o) => [normalizeMarkCode(o.code), o]));
  const found = new Set<string>();
  const suggestions: ResolvedPlacement[] = [];

  for (const row of rawPlacements) {
    const key = normalizeMarkCode(row.mark);
    const opening = byCode.get(key);
    if (!opening) continue;
    found.add(key);
    suggestions.push({
      openingId: opening.id,
      markCode: opening.code,
      x: row.x,
      y: row.y,
      page: row.page,
      confidence: row.confidence,
    });
  }

  const notFoundMarks = unplaced
    .map((o) => o.code)
    .filter((code) => !found.has(normalizeMarkCode(code)));

  return { suggestions, notFoundMarks };
}

/**
 * THE LAW, client-side mirror: drop any suggestion aimed at an opening that
 * already has a real pin. `pinnedOpeningIds` is every opening id whose
 * pin_x is already set — the one signal (see the migration comment on
 * apply_placement_suggestions) that means "a human has settled this mark".
 */
export function filterUnconfirmed<T extends { openingId: string }>(
  pinnedOpeningIds: ReadonlySet<string>,
  suggestions: T[],
): T[] {
  return suggestions.filter((s) => !pinnedOpeningIds.has(s.openingId));
}

/** Normalized (0..1) pin -> plan-image pixel coordinates, for seeding a
 * suggested dot into the vendored tracer's own coordinate space. */
export function normalizedToPixel(
  norm: { x: number; y: number },
  imageWidthPx: number,
  imageHeightPx: number,
): { x: number; y: number } {
  return { x: norm.x * imageWidthPx, y: norm.y * imageHeightPx };
}

/** Plan-image pixel -> normalized (0..1) pin, for persisting a confirmed
 * (possibly dragged) dot back to project_openings.pin_x/pin_y. Clamped: a
 * drag that lands a hair outside the rendered image must never write an
 * out-of-range pin the database's own check constraint would then refuse. */
export function pixelToNormalized(
  px: { x: number; y: number },
  imageWidthPx: number,
  imageHeightPx: number,
): { x: number; y: number } {
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  if (!(imageWidthPx > 0) || !(imageHeightPx > 0)) return { x: 0, y: 0 };
  return {
    x: Math.round(clamp01(px.x / imageWidthPx) * 1000) / 1000,
    y: Math.round(clamp01(px.y / imageHeightPx) * 1000) / 1000,
  };
}

/**
 * The plain-English line after a Find placements run. THE BUG this shape
 * fixes (Mad Moose, wave V-A): apply_placement_suggestions can legitimately
 * save fewer rows than extract-placement found — the rescan law skips any
 * mark that already has a real pin, and a database that hasn't caught up to
 * the placement-suggestions migration yet degrades the write to a silent 0
 * (see isMissingPlacementFunction in install/api.ts). A single "placed"
 * number can't distinguish "found and saved" from "found and NOT saved" —
 * `suggested` (extract-placement's own match count) and `saved` (apply_
 * placement_suggestions' actual row count) are kept as two separate numbers
 * for exactly that reason: there is no single count left that can lie about
 * whether the write actually landed.
 *
 * `unavailable` keeps a SECOND lie from replacing the first: a gap between
 * suggested and saved has two unrelated causes (a mark already has a real
 * pin, or the write path itself isn't live on this database yet), and they
 * call for opposite next steps — one means "nothing to do", the other means
 * "try again once the deploy catches up". Attributing an unavailable-caused
 * 0 to "already have real pins" would tell a foreman the marks are handled
 * when they still need saving.
 */
export function placementResultSummary(counts: {
  suggested: number;
  saved: number;
  notFound: number;
  unknown: number;
  unavailable?: boolean;
}): string {
  const gap = counts.suggested - counts.saved;
  const base = counts.unavailable
    ? `Suggested ${counts.suggested} — ${counts.saved} saved — placements aren't set up on this database yet`
    : gap > 0
      ? `Suggested ${counts.suggested} — only ${counts.saved} saved — ${gap} already have real pins`
      : `Suggested ${counts.suggested} — ${counts.saved} saved`;
  const tail: string[] = [];
  if (counts.notFound > 0) {
    tail.push(`${counts.notFound} not found`);
  }
  if (counts.unknown > 0) {
    tail.push(
      counts.unknown === 1
        ? "1 callout on the plan isn't in the schedule"
        : `${counts.unknown} callouts on the plan aren't in the schedule`,
    );
  }
  return tail.length > 0 ? `${base} — ${tail.join("; ")}` : `${base}.`;
}

/**
 * Which toast kind a Find placements run earns — separate from the message
 * text so the ONE rule that matters ("a zero-write must never read as
 * success") can't be lost in string formatting. Success covers "nothing to
 * save" too (suggested 0): that is a clean no-op, not a failure. Only a real
 * write that saved NONE of what it found — the exact Mad Moose shape, 10
 * suggested / 0 saved — earns "error".
 */
export function placementToastKind(counts: {
  suggested: number;
  saved: number;
}): "success" | "error" {
  return counts.suggested > 0 && counts.saved === 0 ? "error" : "success";
}

/** Confirm-all's own toast, singular/plural handled once here rather than at
 * every call site. */
export function confirmAllSummary(count: number): string {
  return `${count} placement${count === 1 ? "" : "s"} confirmed`;
}
