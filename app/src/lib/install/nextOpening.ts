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
 * The single next opening an installer should start after finishing one.
 * Excludes already-installed openings and (optionally) a just-completed opening
 * whose local cache may still read as not-installed, then defers to the pure
 * nextForInstaller ordering. Returns null when the installer is all caught up.
 */
export function pickNextOpening(
  openings: ProjectOpening[],
  excludeId?: string,
): ProjectOpening | null {
  const candidates = openings.filter(
    (o) => o.status !== "installed" && o.id !== excludeId,
  );
  if (candidates.length === 0) return null;
  const byId = new Map(candidates.map((o) => [o.id, o]));
  const next = nextForInstaller(candidates.map(toDispatchOpening));
  return next ? byId.get(next.id) ?? null : null;
}
