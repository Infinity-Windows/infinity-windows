// Shared "what does this installer do next" wiring for the spam-through loop.
// Maps DB openings into the pure dispatch shape and defers to nextForInstaller
// (ready-first, then sequence/area) so MyWork and the post-install modal agree
// on the single next window. Pure given its inputs — unit-tested.

import { nextForInstaller, type DispatchOpening } from "../dispatch";
import { openingReadiness } from "./fit";
import type { ProjectOpening } from "./types";

/** Grouping key used to keep same-room/page openings together. */
export function areaKey(o: ProjectOpening): string {
  return o.label?.trim() || `page ${o.page_number}`;
}

/** Map a DB opening into the pure dispatch opening shape. */
export function toDispatchOpening(o: ProjectOpening): DispatchOpening {
  const r = openingReadiness(o);
  return {
    id: o.id,
    opening_code: o.opening_code,
    window_type_id: o.window_type_id,
    difficulty:
      o.window_types?.learned_difficulty ??
      o.window_types?.outcome_difficulty ??
      o.window_types?.difficulty_rating ??
      null,
    area: areaKey(o),
    ready: r.status === "ready",
    blocked: r.status === "blocked",
    assigned_to: o.assigned_to,
    sequence: o.sequence,
  };
}

/**
 * Overlay live session-blocks onto the pure dispatch shape. openingReadiness
 * only knows the opening row; a unit whose NEWEST session ended in a Block
 * (grilled Q4, 2026-08-17) must never be recommended — a recommendation that
 * sends someone to a window waiting on hardware burns trust on day one.
 */
export function applySessionBlocks(
  list: DispatchOpening[],
  blockedIds: ReadonlySet<string>,
): DispatchOpening[] {
  if (blockedIds.size === 0) return list;
  return list.map((d) =>
    blockedIds.has(d.id) ? { ...d, ready: false, blocked: true } : d,
  );
}

/**
 * The single next opening an installer should start after finishing one.
 * Excludes already-installed openings and (optionally) a just-completed opening
 * whose local cache may still read as not-installed, then defers to the pure
 * nextForInstaller ordering. Returns null when the installer is all caught up.
 * Session-blocked units (see applySessionBlocks) sort out of the running.
 */
export function pickNextOpening(
  openings: ProjectOpening[],
  excludeId?: string,
  blockedIds: ReadonlySet<string> = new Set(),
): ProjectOpening | null {
  const candidates = openings.filter(
    (o) => o.status !== "installed" && o.id !== excludeId,
  );
  if (candidates.length === 0) return null;
  const byId = new Map(candidates.map((o) => [o.id, o]));
  const next = nextForInstaller(
    applySessionBlocks(candidates.map(toDispatchOpening), blockedIds),
  );
  return next ? byId.get(next.id) ?? null : null;
}
