// The job load list (owner pick 27): "Make the load list" — every stored
// package for a job, grouped by container and ordered for pulling. Container
// IS the zone (storage_containers has no separate zone column, and this
// wave adds none), so grouping by container is the whole location story.
//
// Ticks are working state, not data — JobMaterials.tsx persists them to
// localStorage, the same draft pattern the delivery wizard uses for its own
// DRAFT_KEY. This module only groups, orders and counts.

import { partLabel, type StorageContainer, type StoragePackage } from "../storage";
import { markOf } from "./jobMaterials";

export interface LoadListRow {
  id: string;
  /** Crate-pool rows (piece_count != null) tick as one whole row. */
  isPool: boolean;
  pieceCount: number | null;
  picked: boolean;
}

export interface LoadListGroup {
  /** Empty string for "no container" — should not happen to a `stored`
   *  package, but a row is never trusted blind (see containerName below). */
  containerId: string;
  containerName: string;
  containerSerial: string;
  address: string | null;
  rows: LoadListRow[];
  pickedCount: number;
  totalCount: number;
  complete: boolean;
}

export interface LoadListSummary {
  groups: LoadListGroup[];
  pickedCount: number;
  totalCount: number;
}

type LoadListPackage = Pick<
  StoragePackage,
  | "id"
  | "container_id"
  | "piece_count"
  | "part_index"
  | "part_total"
  | "part_type"
  | "mfr_mark"
  | "package_marks"
>;

type LoadListContainer = Pick<StorageContainer, "id" | "name" | "serial" | "address">;

/**
 * Every `stored` package for a job, grouped by container (name, then within
 * it by mark then part label — the walk a person actually makes), with a
 * pick/total count per container and overall. `ticked` names which package
 * ids are currently checked; this function has no memory of its own.
 */
export function buildLoadList(
  packages: LoadListPackage[],
  containers: LoadListContainer[],
  ticked: ReadonlySet<string>,
): LoadListSummary {
  const containerById = new Map(containers.map((c) => [c.id, c]));
  const byContainer = new Map<string, LoadListPackage[]>();
  for (const p of packages) {
    const key = p.container_id ?? "";
    const list = byContainer.get(key);
    if (list) list.push(p);
    else byContainer.set(key, [p]);
  }

  const groups: LoadListGroup[] = [...byContainer.entries()].map(([containerId, pkgs]) => {
    const container = containerById.get(containerId);
    const sorted = [...pkgs].sort((a, b) => {
      const byMark = markOf(a as StoragePackage).localeCompare(
        markOf(b as StoragePackage),
        undefined,
        { numeric: true },
      );
      if (byMark !== 0) return byMark;
      return (partLabel(a) ?? "").localeCompare(partLabel(b) ?? "");
    });
    const rows: LoadListRow[] = sorted.map((p) => ({
      id: p.id,
      isPool: p.piece_count != null,
      pieceCount: p.piece_count ?? null,
      picked: ticked.has(p.id),
    }));
    const pickedCount = rows.filter((r) => r.picked).length;
    return {
      containerId,
      containerName: container?.name ?? "Not yet placed",
      containerSerial: container?.serial ?? "",
      address: container?.address ?? null,
      rows,
      pickedCount,
      totalCount: rows.length,
      complete: rows.length > 0 && pickedCount === rows.length,
    };
  });

  groups.sort((a, b) => {
    // A "stored" package always has a container — this bucket is the one
    // that should never exist, so it sorts last rather than alphabetically
    // among real containers.
    if (a.containerId === "" && b.containerId !== "") return 1;
    if (b.containerId === "" && a.containerId !== "") return -1;
    return a.containerName.localeCompare(b.containerName, undefined, { numeric: true });
  });

  const totalCount = groups.reduce((s, g) => s + g.totalCount, 0);
  const pickedCount = groups.reduce((s, g) => s + g.pickedCount, 0);
  return { groups, pickedCount, totalCount };
}

// ---------------------------------------------------------------- ticks

/** Same draft pattern as the delivery wizard's DRAFT_KEY: one key per job, so
 *  a refresh — or a walk out to the yard and back — keeps the working list. */
export function loadListStorageKey(projectId: string): string {
  return `infinity.loadlist.${projectId}`;
}

/** Null/corrupt/wrong-shape all read as "nothing ticked yet" rather than an
 *  error — a working list is allowed to just start over. */
export function parseTicked(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function serializeTicked(ticked: ReadonlySet<string>): string {
  return JSON.stringify([...ticked]);
}
