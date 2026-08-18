// Where is it, really? — the inherited-location chain, as pure functions
// (warehouse ticket 04, ADR-0004).
//
// Nothing stores its own location: a package borrows its place from the
// container holding it, and a crate borrows its place from the conex it sits
// in. These helpers walk that chain (one level of nesting, matching the
// database trigger) so every screen derives the same answer from the same
// rows — the client-side mirror of what move_container relies on.

import type { StorageContainer, StoragePackage } from "../storage";

/** Where a package physically is, spelled out link by link. */
export interface PlaceChain {
  /** The container the package sits in, if any. */
  container: StorageContainer | null;
  /** The container THAT one sits in (crate → conex), if any. */
  parent: StorageContainer | null;
  /** Rack-slot id when the package (or its outermost container) sits at one. */
  locationId: string | null;
  /** The location itself, when the caller passed the lookup in. */
  location?: PlaceLocation | null;
  /** No container and no slot — the cannot-find-it pile. */
  loose: boolean;
}

/** Enough of a location to name it. Staging bays are zone 'J'. */
export interface PlaceLocation {
  id: string;
  address: string;
  zone?: string;
  rack?: string;
}

/**
 * The lookup the labels need, built straight off a locations query — the rows
 * `api.listLocations()` returns already satisfy `PlaceLocation`.
 *
 * One function so every screen builds the map the same way. The staged-for-a-job
 * label shipped invisible for weeks not because anybody built this wrong, but
 * because nobody built it at all: the tests handed `placeLabel` a map made by
 * hand, and no real screen ever made one.
 */
export function toLocationsById(locations: PlaceLocation[]): Map<string, PlaceLocation> {
  return new Map(locations.map((l) => [l.id, l]));
}

export function placeChain(
  pkg: Pick<StoragePackage, "container_id" | "location_id">,
  containersById: Map<string, StorageContainer>,
  locationsById?: Map<string, PlaceLocation>,
): PlaceChain {
  const container = pkg.container_id ? (containersById.get(pkg.container_id) ?? null) : null;
  const parent = container?.parent_container_id
    ? (containersById.get(container.parent_container_id) ?? null)
    : null;
  // The outermost holder is what actually stands somewhere: parent beats
  // container beats the package's own slot.
  const locationId =
    parent?.location_id ?? container?.location_id ?? pkg.location_id ?? null;
  return {
    container,
    parent,
    locationId,
    location: locationId ? (locationsById?.get(locationId) ?? null) : null,
    loose: !container && !pkg.location_id,
  };
}

/** "Crate 7 — inside Conex 3" — the chain as one human line. */
export function placeLabel(chain: PlaceChain): string {
  if (chain.container && chain.parent) {
    return `${chain.container.name} — inside ${chain.parent.name}`;
  }
  if (chain.container) return chain.container.name;
  const loc = chain.location;
  // Zone 'J' is a job staging bay, and its rack IS the job code, character
  // for character (see 20260729220000). Naming the job is the whole point of
  // staging — "on J-BLACK22-A" makes somebody decode it.
  if (loc?.zone === "J") {
    return `staged for ${loc.rack ?? "a job"} — ${loc.address}`;
  }
  if (loc) return `on ${loc.address}`;
  if (chain.locationId) return "on a shelf";
  return "loose — no container, no slot";
}

/**
 * "Where is it" as one sentence — the chain and the label in a single call,
 * so a screen cannot half-supply it.
 *
 * The locations lookup is REQUIRED here, unlike `placeChain`'s optional third
 * argument. `placeChain` keeps it optional because callers that only read
 * `.loose` never need it. But anything showing the SENTENCE does: without the
 * lookup a staged package reads "on a shelf" and the installer has to decode a
 * slot address. Required means a screen that forgets to load locations fails to
 * build instead of quietly printing the wrong thing.
 */
export function placeWhere(
  pkg: Pick<StoragePackage, "container_id" | "location_id">,
  containersById: Map<string, StorageContainer>,
  locationsById: Map<string, PlaceLocation>,
): string {
  return placeLabel(placeChain(pkg, containersById, locationsById));
}

/**
 * Would nesting `child` inside `parent` break the one-level rule? Mirrors the
 * database trigger so the picker can grey out illegal choices instead of
 * letting the server bounce them.
 */
export function canNest(
  childId: string,
  parentId: string,
  containers: StorageContainer[],
): boolean {
  if (childId === parentId) return false;
  const parent = containers.find((c) => c.id === parentId);
  if (!parent || parent.parent_container_id) return false; // parent is itself inside something
  return !containers.some((c) => c.parent_container_id === childId); // child holds others
}

/**
 * Every package that moves when this container moves: its own stored
 * packages plus those in containers nested inside it. The count a move
 * confirmation shows — one action, N packages.
 */
export function ridesAlong(
  containerId: string,
  packages: StoragePackage[],
  containers: StorageContainer[],
): StoragePackage[] {
  const childIds = new Set(
    containers.filter((c) => c.parent_container_id === containerId).map((c) => c.id),
  );
  return packages.filter(
    (p) =>
      p.status === "stored" &&
      p.container_id != null &&
      (p.container_id === containerId || childIds.has(p.container_id)),
  );
}
