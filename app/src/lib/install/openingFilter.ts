// The job map's filter chips.
//
// Extracted from ProjectMap so the "Mine" rule can be tested directly. Mine is
// the one chip that depends on who is looking, and it is the answer to the
// question an installer actually opens the map with: which of these forty
// identical dots are the ones I have to install.

import { openingUnitKind } from "./unitKind";
import type { ProjectOpening } from "./types";

export type PlanFilter = "all" | "mine" | "open" | "windows" | "doors" | "done";

export const FILTERS: { id: PlanFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "open", label: "Open" },
  { id: "windows", label: "Windows" },
  { id: "doors", label: "Doors" },
  { id: "done", label: "Done" },
];

export function matchesPlanFilter(
  opening: ProjectOpening,
  filter: PlanFilter,
  viewerId: string | null | undefined,
): boolean {
  switch (filter) {
    case "mine":
      // No signed-in id means nothing is mine, rather than everything.
      return !!viewerId && opening.assigned_to === viewerId;
    case "open":
      return opening.status !== "installed";
    case "done":
      return opening.status === "installed";
    case "windows":
      return openingUnitKind(opening) === "window";
    case "doors":
      return openingUnitKind(opening) === "door";
    default:
      return true;
  }
}

/**
 * Chips to show. Mine is hidden unless the viewer has work on this job, so a
 * foreman never taps into a guaranteed empty list.
 */
export function visibleFilters(
  openings: readonly ProjectOpening[],
  viewerId: string | null | undefined,
): { id: PlanFilter; label: string }[] {
  const hasOwnWork =
    !!viewerId && openings.some((opening) => opening.assigned_to === viewerId);
  return FILTERS.filter((entry) => entry.id !== "mine" || hasOwnWork);
}

/** Falls back to All when the current chip is about to disappear. */
export function resolveFilter(
  filter: PlanFilter,
  available: readonly { id: PlanFilter }[],
): PlanFilter {
  return available.some((entry) => entry.id === filter) ? filter : "all";
}