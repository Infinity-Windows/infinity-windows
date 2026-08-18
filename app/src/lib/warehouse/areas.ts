// Areas: where inside the box (ticket 14, ADR-0006).
//
// The option list is decided by what KIND of box the package is in, and the
// difference is the whole point: a conex gets re-parked facing whichever way
// the driver dropped it, so a compass inside one is a confident wrong answer
// waiting to happen. The door end is the front wherever it is parked. Only
// the building — the one container that never moves — earns the compass.

import { containerKind, type StorageContainer } from "../storage";

/** Options for a box that travels: door-relative, park it any way you like. */
export const MOVABLE_AREAS = ["front", "middle", "back"] as const;

/** Options inside the building, which never moves — the compass holds. */
export const BUILDING_AREAS = [
  "north", "northeast", "east", "southeast",
  "south", "southwest", "west", "northwest", "middle",
] as const;

const LABELS: Record<string, string> = {
  front: "Front (door end)",
  middle: "Middle",
  back: "Back",
  north: "North",
  northeast: "NorthEast",
  east: "East",
  southeast: "SouthEast",
  south: "South",
  southwest: "SouthWest",
  west: "West",
  northwest: "NorthWest",
};

/** The choices a foreman gets for a package sitting in this container. */
export function areaOptions(
  container: Pick<StorageContainer, "kind"> | null | undefined,
): readonly string[] {
  if (!container) return [];
  return containerKind(container) === "building" ? BUILDING_AREAS : MOVABLE_AREAS;
}

/** "front" -> "Front (door end)". Unknown values pass through rather than
 * crash — a row written by a newer bundle still reads as itself. */
export function areaLabel(area: string): string {
  return LABELS[area] ?? area;
}

/** The short form for a place sentence: "Conex 7 — front". */
export function areaSuffix(area: string | null | undefined): string {
  return area ? ` — ${areaLabel(area).toLowerCase().replace(" (door end)", "")}` : "";
}
