// Pure helpers for the warehouse-to-jobsite leg of the tracking chain.
//
// Load-out batch-selects a project's in-warehouse (or staged) units onto the
// truck ('loaded'); jobsite unload reports each unit's condition (good ->
// 'on_site', ready to install; damaged -> held). The reorder rollup surfaces shortfalls
// per type (damaged units + still-missing deliveries) so office can reorder.
//
// These are extracted here so selection math and the rollup counting are
// unit-testable without a DB or React, mirroring the server RPCs
// (load_units / unload_units / list_reorder_needs).

import type { WindowStatus } from "./types";

export interface LoadoutUnitLike {
  id: string;
  status: WindowStatus;
}

/** Statuses that are eligible to be loaded onto the truck (warehouse-ready). */
const LOADABLE: WindowStatus[] = ["in_warehouse", "staged"];

/** True when a unit can be loaded out for a run. */
export function isLoadable(unit: LoadoutUnitLike): boolean {
  return LOADABLE.includes(unit.status);
}

/** The subset of units that can be loaded onto the truck. */
export function loadableUnits<T extends LoadoutUnitLike>(units: T[]): T[] {
  return units.filter(isLoadable);
}

/**
 * Toggle a unit id in a selection set, returning a NEW set (so React state
 * updates stay immutable). Adding an id selects it; toggling again deselects.
 */
export function toggleSelected(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Resolve the batch to actually load: only currently-loadable ids that are also
 * selected, de-duplicated and preserving unit order. Anything selected that is
 * no longer loadable (already loaded / installed / gone) is dropped, so the
 * client never asks the server to load an ineligible unit.
 */
export function selectedLoadableIds(
  units: LoadoutUnitLike[],
  selected: Set<string>,
): string[] {
  return loadableUnits(units)
    .filter((u) => selected.has(u.id))
    .map((u) => u.id);
}

// --- Reorder rollup ---------------------------------------------------------

export interface ReorderUnitLike {
  id: string;
  window_type_id: string;
  status: WindowStatus;
}

export interface MissingIssueLike {
  /** The physical unit the missing issue is about. */
  window_id: string | null;
  kind: string;
  status: string;
}

export interface ReorderNeedRow {
  window_type_id: string;
  missing_count: number;
  damaged_count: number;
}

/**
 * Roll a project's units + open issues into a per-type reorder need, mirroring
 * the list_reorder_needs RPC: damaged units (status 'damaged') plus still-
 * missing deliveries (an open 'missing' issue pointing at a unit of that type).
 * Only types with a shortfall appear. Used to sanity-check the RPC output and to
 * derive totals in the UI without another round-trip.
 */
export function computeReorderNeeds(
  units: ReorderUnitLike[],
  issues: MissingIssueLike[],
): ReorderNeedRow[] {
  const typeByUnitId = new Map<string, string>();
  const damaged = new Map<string, number>();
  for (const u of units) {
    typeByUnitId.set(u.id, u.window_type_id);
    if (u.status === "damaged") {
      damaged.set(u.window_type_id, (damaged.get(u.window_type_id) ?? 0) + 1);
    }
  }

  const missing = new Map<string, number>();
  for (const i of issues) {
    if (i.kind !== "missing" || i.status !== "open" || !i.window_id) continue;
    const tid = typeByUnitId.get(i.window_id);
    if (!tid) continue;
    missing.set(tid, (missing.get(tid) ?? 0) + 1);
  }

  const typeIds = new Set<string>([...damaged.keys(), ...missing.keys()]);
  return [...typeIds]
    .map((window_type_id) => ({
      window_type_id,
      missing_count: missing.get(window_type_id) ?? 0,
      damaged_count: damaged.get(window_type_id) ?? 0,
    }))
    .sort((a, b) => a.window_type_id.localeCompare(b.window_type_id));
}

/** Total units needing reorder across all types (missing + damaged). */
export function totalReorder(rows: { missing_count: number; damaged_count: number }[]): number {
  return rows.reduce((sum, r) => sum + r.missing_count + r.damaged_count, 0);
}
