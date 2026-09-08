// Areas: where inside the box (ticket 14, ADR-0006).
//
// The option list is decided by what KIND of box the package is in, and the
// difference is the whole point: a conex gets re-parked facing whichever way
// the driver dropped it, so a compass inside one is a confident wrong answer
// waiting to happen. The door end is the front wherever it is parked. Only
// the building — the one container that never moves — earns the compass.

import { containerKind, type StorageContainer } from "../storage";
import { CATALOG } from "../i18n/catalog";
import { translate, type Lang } from "../i18n/translate";
import type { TFn } from "../i18n/context";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

/** Options for a box that travels: door-relative, park it any way you like. */
export const MOVABLE_AREAS = ["front", "middle", "back"] as const;

/** Finer zones inside a box that travels (owner call): each door-relative
 * third also splits left/right. Optional precision layered on top of
 * MOVABLE_AREAS, never a replacement for it — a foreman can always stop at
 * the plain three. The building doesn't get these; it already has the full
 * compass and never moves, so there's nothing rough about its answer. */
export const MOVABLE_ZONE_AREAS = [
  "front-left", "front-right",
  "middle-left", "middle-right",
  "back-left", "back-right",
] as const;

/** Options inside the building, which never moves — the compass holds. */
export const BUILDING_AREAS = [
  "north", "northeast", "east", "southeast",
  "south", "southwest", "west", "northwest", "middle",
] as const;

const LABELS: Record<string, string> = {
  front: "Front (door end)",
  middle: "Middle",
  back: "Back",
  "front-left": "Front Left",
  "front-right": "Front Right",
  "middle-left": "Middle Left",
  "middle-right": "Middle Right",
  "back-left": "Back Left",
  "back-right": "Back Right",
  north: "North",
  northeast: "NorthEast",
  east: "East",
  southeast: "SouthEast",
  south: "South",
  southwest: "SouthWest",
  west: "West",
  northwest: "NorthWest",
};

/** Same values, keyed by catalog key (S3b) — read through `t` when a caller
 * has one, so `areaLabel`'s English default (used by tests and by every
 * caller that predates this) never changes. */
const LABEL_KEYS: Record<string, string> = {
  front: "warehouse.area.front",
  middle: "warehouse.area.middle",
  back: "warehouse.area.back",
  "front-left": "warehouse.area.frontLeft",
  "front-right": "warehouse.area.frontRight",
  "middle-left": "warehouse.area.middleLeft",
  "middle-right": "warehouse.area.middleRight",
  "back-left": "warehouse.area.backLeft",
  "back-right": "warehouse.area.backRight",
  north: "warehouse.area.north",
  northeast: "warehouse.area.northeast",
  east: "warehouse.area.east",
  southeast: "warehouse.area.southeast",
  south: "warehouse.area.south",
  southwest: "warehouse.area.southwest",
  west: "warehouse.area.west",
  northwest: "warehouse.area.northwest",
};

/** The choices a foreman gets for a package sitting in this container. */
export function areaOptions(
  container: Pick<StorageContainer, "kind"> | null | undefined,
): readonly string[] {
  if (!container) return [];
  return containerKind(container) === "building" ? BUILDING_AREAS : MOVABLE_AREAS;
}

/** The optional finer zones for a box that travels — empty for the building,
 * which keeps only its compass (owner call: the extra precision is a
 * container thing, never forced on anyone). */
export function areaZoneOptions(
  container: Pick<StorageContainer, "kind"> | null | undefined,
): readonly string[] {
  if (!container) return [];
  return containerKind(container) === "building" ? [] : MOVABLE_ZONE_AREAS;
}

/** "front" -> "Front (door end)". Unknown values pass through rather than
 * crash — a row written by a newer bundle still reads as itself. A caller
 * with no `t` gets the same English text as before. */
export function areaLabel(area: string, t: TFn = englishT): string {
  const key = LABEL_KEYS[area];
  return key ? t(key as Parameters<TFn>[0]) : (LABELS[area] ?? area);
}

/** The short form for a place sentence: "Conex 7 — front". "front" gets its
 * own key rather than stripping English's "(door end)" punctuation out of
 * `areaLabel`, which would leave a Spanish parenthetical behind untouched. */
export function areaSuffix(area: string | null | undefined, t: TFn = englishT): string {
  if (!area) return "";
  const short = area === "front" ? t("warehouse.area.short.front") : areaLabel(area, t).toLowerCase();
  return ` — ${short}`;
}
