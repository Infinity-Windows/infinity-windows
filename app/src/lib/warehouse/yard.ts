// The yard (warehouse redesign wave 3, owner call 2026-09-06): the warehouse
// home page is a picture of the boxes, not a list of buttons. Every box is
// drawn as a box, sized by what it holds and striped by job, the building
// first and biggest, crates riding inside the box that holds them. "Where is
// window 16" lights the box up. Pure over already-fetched rows, so the
// picture is testable without a screen.

import { containerHue, groupByJob, type StorageContainer, type StoragePackage } from "../storage";

export type YardKind = "building" | "conex" | "bay" | "truck" | "trailer" | "crate";

export interface YardJobStripe {
  projectId: string | null;
  jobCode: string;
  count: number;
  /** 0–359, stable per job code, so BLACK22 is the same colour on every box. */
  hue: number;
}

export interface YardTile {
  id: string;
  name: string;
  serial: string;
  kind: YardKind;
  /** Packages stored directly in this box (crates inside count on the crate). */
  inside: number;
  jobs: YardJobStripe[];
  /** Days the longest-sitting package has been here; 0 when empty. */
  oldestDays: number;
  /** Crates and other boxes sitting inside this one. */
  children: YardTile[];
  /** Lit up because Find's answer points here. */
  glow: boolean;
}

export function yardKind(c: Pick<StorageContainer, "kind">): YardKind {
  const k = (c.kind ?? "conex").toLowerCase();
  if (k === "building" || k === "bay" || k === "truck" || k === "trailer" || k === "crate") return k;
  return "conex";
}

/** Order the yard is read in: the building, then conexes and bays by number,
 *  then trucks and trailers, then loose crates. Names sort numerically so
 *  Conex 7 comes before Conex 12. */
const KIND_ORDER: Record<YardKind, number> = {
  building: 0,
  conex: 1,
  bay: 2,
  truck: 3,
  trailer: 4,
  crate: 5,
};

function byYardOrder(a: YardTile, b: YardTile): number {
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function daysSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function yardTiles(
  containers: readonly StorageContainer[],
  packages: readonly StoragePackage[],
  jobCodeById: Map<string, string>,
  now: Date,
  glowIds: ReadonlySet<string> = new Set(),
): YardTile[] {
  const active = containers.filter((c) => c.active !== false);
  const stored = packages.filter((p) => p.status === "stored" && p.container_id);

  const tileOf = (c: StorageContainer): YardTile => {
    const inside = stored.filter((p) => p.container_id === c.id);
    const jobs: YardJobStripe[] = groupByJob(inside)
      .map((g) => {
        const code = g.projectId ? (jobCodeById.get(g.projectId) ?? "?") : "Boneyard";
        return { projectId: g.projectId, jobCode: code, count: g.packages.length, hue: containerHue(code) };
      })
      .sort((a, b) => b.count - a.count || a.jobCode.localeCompare(b.jobCode));
    return {
      id: c.id,
      name: c.name,
      serial: c.serial,
      kind: yardKind(c),
      inside: inside.length,
      jobs,
      oldestDays: inside.reduce((worst, p) => Math.max(worst, daysSince(p.bound_at, now)), 0),
      children: [],
      glow: glowIds.has(c.id),
    };
  };

  const tiles = new Map<string, YardTile>();
  for (const c of active) tiles.set(c.id, tileOf(c));
  const roots: YardTile[] = [];
  for (const c of active) {
    const t = tiles.get(c.id)!;
    const parent = c.parent_container_id ? tiles.get(c.parent_container_id) : null;
    if (parent) {
      parent.children.push(t);
      // A lit crate lights the box around it: that is where you walk to.
      if (t.glow) parent.glow = true;
    } else roots.push(t);
  }
  for (const t of tiles.values()) t.children.sort(byYardOrder);
  return roots.sort(byYardOrder);
}

/** Which boxes a Find answer points at — the box holding each hit, or the
 *  box itself when the answer IS a box. */
export function glowFromHits(
  hits: readonly { pkg: Pick<StoragePackage, "container_id" | "status"> }[],
  containerId?: string | null,
): Set<string> {
  const out = new Set<string>();
  if (containerId) out.add(containerId);
  for (const h of hits) if (h.pkg.status === "stored" && h.pkg.container_id) out.add(h.pkg.container_id);
  return out;
}

/** One line under the yard: how much is here and how many boxes hold it. */
export function yardSummary(tiles: readonly YardTile[]): string {
  const boxes = tiles.length;
  const inside = tiles.reduce(
    (n, t) => n + t.inside + t.children.reduce((m, c) => m + c.inside, 0),
    0,
  );
  const jobs = new Set<string>();
  for (const t of tiles) {
    for (const j of t.jobs) jobs.add(j.jobCode);
    for (const c of t.children) for (const j of c.jobs) jobs.add(j.jobCode);
  }
  if (boxes === 0) return "No boxes yet — add the first conex to start the yard.";
  return `${inside} package${inside === 1 ? "" : "s"} in ${boxes} box${boxes === 1 ? "" : "es"}${jobs.size > 0 ? ` · ${jobs.size} job${jobs.size === 1 ? "" : "s"}` : ""}`;
}
