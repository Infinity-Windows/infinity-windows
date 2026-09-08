// Sending a whole job to the job site, and closing its material story
// (owner ask 2026-09-06). "On job site" is the checked-out state — checking
// out already clears the box and records the job — so this file only decides
// WHICH pieces go: every piece of the job that is physically here, grouped
// by unit so a person can hold a unit back, then handed to the same
// checkout every screen uses. The finalize rule lives here too, mirrored on
// the server (finalize_job_materials, 20260999000000): nothing may still be
// in a box.
import type { StorageContainer, StoragePackage } from "../storage";
import { CATALOG } from "../i18n/catalog";
import { translate, type Lang } from "../i18n/translate";
import type { TFn } from "../i18n/context";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

/** A piece that is physically in the warehouse: arrived or in a box. */
export function isHere(p: Pick<StoragePackage, "status">): boolean {
  return p.status === "received" || p.status === "stored";
}

export interface SitePiece {
  id: string;
  serial: string;
  /** Where it sits: the box's name, or "not in a box yet". */
  where: string;
  /** Pooled copies ride as one row ("×N"); null for a serial piece. */
  pieces: number | null;
}

export interface SiteUnit {
  /** The window number, or LOOSE for pieces with no unit. */
  key: string;
  label: string;
  pieces: SitePiece[];
  /** Pieces here, counting a pooled row by what rides in it. */
  here: number;
  /** Where the unit's pieces sit, distinct, for the person pulling them. */
  places: string[];
}

export const LOOSE = "LOOSE";

const markOf = (p: StoragePackage): string | null =>
  (p.package_marks ?? [])[0]?.mark_code ?? p.mfr_mark ?? null;

/** The job's units that are here, in window order, loose pieces last. */
export function siteUnits(
  packages: readonly StoragePackage[],
  projectId: string,
  boxesById: ReadonlyMap<string, Pick<StorageContainer, "name">>,
  t: TFn = englishT,
): SiteUnit[] {
  const units = new Map<string, SiteUnit>();
  for (const p of packages) {
    if (p.project_id !== projectId || !isHere(p)) continue;
    const mark = markOf(p);
    const key = mark ?? LOOSE;
    const u = units.get(key) ?? {
      key,
      label: mark ? t("warehouse.sendToSite.windowMark", { mark }) : t("warehouse.sendToSite.loosePieces"),
      pieces: [],
      here: 0,
      places: [],
    };
    const where = p.container_id
      ? (boxesById.get(p.container_id)?.name ?? t("warehouse.sendToSite.aBox"))
      : t("warehouse.sendToSite.notInBoxYet");
    const pooled = p.tracking === "pooled" ? Math.max(1, p.piece_count ?? 1) : null;
    u.pieces.push({ id: p.id, serial: p.serial, where, pieces: pooled });
    u.here += pooled ?? 1;
    if (!u.places.includes(where)) u.places.push(where);
    units.set(key, u);
  }
  return [...units.values()].sort((a, b) => {
    if (a.key === LOOSE) return 1;
    if (b.key === LOOSE) return -1;
    return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** The package ids that go, given which units the person is keeping back. */
export function idsToSend(units: readonly SiteUnit[], staying: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const u of units) if (!staying.has(u.key)) for (const p of u.pieces) out.push(p.id);
  return out;
}

/** "Move 24 units (61 pieces) to the job site · 2 units stay". */
export function sendSummary(units: readonly SiteUnit[], staying: ReadonlySet<string>, t: TFn = englishT): string {
  const going = units.filter((u) => !staying.has(u.key));
  const pieces = going.reduce((n, u) => n + u.here, 0);
  const named = going.filter((u) => u.key !== LOOSE).length;
  const stay = units.length - going.length;
  if (going.length === 0) return t("warehouse.sendToSite.nothingPicked");
  const head =
    named > 0
      ? t(named === 1 ? "warehouse.sendToSite.moveUnit.one" : "warehouse.sendToSite.moveUnit.many", {
          n: named,
          pieces,
          pieceWord: t(pieces === 1 ? "warehouse.sendToSite.pieceWord.one" : "warehouse.sendToSite.pieceWord.many"),
        })
      : t(pieces === 1 ? "warehouse.sendToSite.moveLoose.one" : "warehouse.sendToSite.moveLoose.many", { pieces });
  return stay > 0
    ? `${head} · ${t(stay === 1 ? "warehouse.sendToSite.stay.one" : "warehouse.sendToSite.stay.many", { n: stay })}`
    : head;
}

/**
 * Why the job cannot be finalized yet, or null when it can. Deliberately
 * English-only, always — this is "the same words the server refuses with"
 * (finalize_job_materials, 20260999000000): a stale screen and a fresh one
 * must read identically, and the server's own error text is not bilingual.
 * Translating one side would make them disagree, which is the one thing
 * this function exists to prevent. Revisit together if the RPC's message
 * ever grows a Spanish half.
 */
export function leftoverBlock(
  packages: readonly StoragePackage[],
  projectId: string,
  boxesById: ReadonlyMap<string, Pick<StorageContainer, "name">>,
): string | null {
  const byPlace = new Map<string, number>();
  let n = 0;
  for (const p of packages) {
    if (p.project_id !== projectId || !isHere(p)) continue;
    const place = p.container_id ? (boxesById.get(p.container_id)?.name ?? "a box") : "not in a box yet";
    byPlace.set(place, (byPlace.get(place) ?? 0) + 1);
    n += 1;
  }
  if (n === 0) return null;
  const line = [...byPlace.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([place, k]) => `${place} ×${k}`)
    .join(", ");
  return `${n} package${n === 1 ? " is" : "s are"} still in the warehouse (${line}). Send them to the job site or move them to the Boneyard first.`;
}

/** Jobs whose material story is closed — hidden from the main warehouse,
 *  listed in history. Works against any project shape a page holds. */
export function finalizedProjectIds(
  projects: readonly { id: string; materials_finalized_at?: string | null }[],
): Set<string> {
  return new Set(projects.filter((p) => !!p.materials_finalized_at).map((p) => p.id));
}

/** Drop the finalized jobs' packages from what the warehouse counts and
 *  draws. Boneyard stock (no job) is always kept. */
export function hideFinalized<T extends { project_id: string | null }>(
  packages: readonly T[],
  finalized: ReadonlySet<string>,
): T[] {
  if (finalized.size === 0) return [...packages];
  return packages.filter((p) => !(p.project_id && finalized.has(p.project_id)));
}

export interface HistoryRow {
  projectId: string;
  jobCode: string;
  name: string;
  finalizedAt: string;
  /** Distinct window numbers the job's material carries. */
  units: number;
  /** Pieces that went to the job site. */
  onSite: number;
}

/** One row per finalized job, newest close first. */
export function historyRows(
  projects: readonly { id: string; job_code: string; name: string; materials_finalized_at?: string | null }[],
  packages: readonly StoragePackage[],
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const j of projects) {
    if (!j.materials_finalized_at) continue;
    const mine = packages.filter((p) => p.project_id === j.id);
    const marks = new Set<string>();
    for (const p of mine) {
      const m = markOf(p);
      if (m) marks.add(m);
    }
    rows.push({
      projectId: j.id,
      jobCode: j.job_code,
      name: j.name,
      finalizedAt: j.materials_finalized_at,
      units: marks.size,
      onSite: mine.filter((p) => p.status === "checked_out").length,
    });
  }
  return rows.sort((a, b) => b.finalizedAt.localeCompare(a.finalizedAt));
}
