// The four warehouse inventory numbers — and the four lists behind them.
//
// The hub used to count with four separate `head: true` queries and show no
// list at all, so a number could never be opened and never had to agree with
// anything. Now one query fetches the inventory scope once and everything —
// each card's count, each list's rows — is derived from the definitions below.
// A count and its list cannot disagree, because neither is written twice.

import type { WindowStatus } from "./types";

/**
 * Statuses that leave the inventory scope entirely: a unit on the truck or in
 * the wall is no longer the warehouse's problem. Mirrors the old dashboard
 * "total" filter, and is what api.listInventory() asks the server to exclude.
 */
export const NOT_IN_INVENTORY: WindowStatus[] = ["installed", "loaded"];

export type InventoryViewId = "on-hand" | "putaway" | "staged" | "damaged";

/** The minimum a row needs for the view definitions to place it. */
export interface InventoryUnitLike {
  status: WindowStatus;
}

export interface InventoryViewDef {
  id: InventoryViewId;
  /** Label under the number on the hub card, and on the list's tab. */
  label: string;
  /** Heading of the list page. */
  title: string;
  /** One plain sentence saying exactly what this number counts. */
  blurb: string;
  /** Shown in place of a blank screen when the list is empty. */
  empty: string;
  /** Extra class the hub card and tab carry (warn / danger colouring). */
  tone?: "warn" | "danger";
  /** The single definition of membership. Counts and rows both use it. */
  match: (unit: InventoryUnitLike) => boolean;
}

export const INVENTORY_VIEWS: InventoryViewDef[] = [
  {
    id: "on-hand",
    label: "on hand",
    title: "On hand",
    blurb:
      "Every window we are still holding — anything not yet installed and not yet on a truck. Includes windows waiting to be put away, staged for a job, and held as damaged.",
    empty: "Nothing on hand — every window is on a truck or in a wall.",
    match: (u) => !NOT_IN_INVENTORY.includes(u.status),
  },
  {
    id: "putaway",
    label: "need putaway",
    title: "Need putaway",
    blurb:
      "Windows that have arrived but have not been given a rack and slot yet. Until one is put away, nobody can be told where to find it.",
    empty: "Nothing needs putting away.",
    tone: "warn",
    match: (u) => u.status === "inbound",
  },
  {
    id: "staged",
    label: "staged",
    title: "Staged for a job",
    blurb:
      "Windows already picked and set aside on a job's staging shelf, waiting for the truck.",
    empty: "Nothing is staged for a job right now.",
    match: (u) => u.status === "staged",
  },
  {
    id: "damaged",
    label: "damaged",
    title: "Damaged / on hold",
    blurb:
      "Windows held back because they arrived or were found damaged. These need a replacement ordered before the job can finish.",
    empty: "Nothing is damaged — every window we hold is good to install.",
    tone: "danger",
    match: (u) => u.status === "damaged",
  },
];

const VIEW_BY_ID = new Map(INVENTORY_VIEWS.map((v) => [v.id, v]));

/** Resolve a URL segment to a view, or null when it isn't one of the four. */
export function parseInventoryView(raw: string | undefined): InventoryViewDef | null {
  return raw ? (VIEW_BY_ID.get(raw as InventoryViewId) ?? null) : null;
}

/** The rows behind one number. */
export function filterInventory<T extends InventoryUnitLike>(
  units: T[],
  view: InventoryViewId,
): T[] {
  const def = VIEW_BY_ID.get(view);
  return def ? units.filter(def.match) : [];
}

export type InventoryCounts = Record<InventoryViewId, number>;

/** Every card's number, from the same rows the lists are filtered from. */
export function inventoryCounts(units: InventoryUnitLike[]): InventoryCounts {
  const out = {} as InventoryCounts;
  for (const view of INVENTORY_VIEWS) {
    out[view.id] = units.filter(view.match).length;
  }
  return out;
}

/** Enough of a unit to sort a pick-friendly list. */
export interface SortableUnit {
  window_id: string;
  locations?: { address: string } | null;
}

/**
 * Walk order: units that have a slot first, grouped by slot address so a
 * warehouse person walks the rack once; units with no slot fall to the bottom,
 * because those are the ones somebody has to go hunting for.
 */
export function sortInventory<T extends SortableUnit>(units: T[]): T[] {
  return [...units].sort((a, b) => {
    const aAddr = a.locations?.address ?? "";
    const bAddr = b.locations?.address ?? "";
    if (Boolean(aAddr) !== Boolean(bAddr)) return aAddr ? -1 : 1;
    const byAddr = aAddr.localeCompare(bAddr);
    return byAddr !== 0 ? byAddr : a.window_id.localeCompare(b.window_id);
  });
}

/** Enough of an issue to tie it back to a physical unit. */
export interface UnitIssueLike {
  /** The unit's row id (issues.window_id points at windows.id). */
  window_id: string | null;
  kind: string;
  status: string;
}

/**
 * Unit ids that have an open damage issue, so a damaged row can offer the
 * report instead of leaving the crew to search for it.
 */
export function unitsWithOpenDamage(issues: UnitIssueLike[]): Set<string> {
  const out = new Set<string>();
  for (const i of issues) {
    if (i.kind === "damage" && i.status === "open" && i.window_id) out.add(i.window_id);
  }
  return out;
}
