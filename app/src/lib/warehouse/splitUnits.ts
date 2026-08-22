// Splitting a unit warns and is counted (ticket 19, owner call: warn, never
// block — a frame on site while its glass waits is sometimes the job).
//
// Two readers of the same fact. At the moment of the tap: "you are taking 1
// of Window 16's 4 parts — the rest are in Conex 3", seen by whoever holds
// the phone. And standing on the warehouse page: which windows the warehouse
// is CURRENTLY holding in more than one place, seen by everyone else.
//
// The standing count deliberately looks only at material the warehouse still
// holds (received / stored). A window with two parts installed and one on a
// shelf is mid-install, not split — counting it forever would make the number
// meaningless. Same rule the four cards already use for "on hand".

import { hasPartNumber, type StorageContainer, type StoragePackage } from "../storage";
import type { PlaceLocation } from "./containment";
import { placeWhere } from "./containment";

/** One place, as a comparable key: the box, the shelf, or loose. */
function placeKey(p: StoragePackage): string {
  if (p.container_id) return `c:${p.container_id}`;
  if (p.location_id) return `l:${p.location_id}`;
  return "loose";
}

const ON_HAND = new Set(["received", "stored"]);

/** "at Conex 3" / "loose" / "in more than one place" — placeWhere hands back
 * bare names, and "at loose — no container" is not a sentence. Shared by
 * both directions of the split warning. */
function spotPhrase(places: string[]): string {
  if (places.length > 1) return "in more than one place";
  return places[0].startsWith("loose") ? "loose" : `at ${places[0]}`;
}

export interface SplitUnit {
  projectId: string | null;
  markCode: string;
  /** Distinct places its on-hand parts sit, by human label. */
  places: string[];
  partsOnHand: number;
}

/**
 * Every window whose ON-HAND parts sit in more than one place right now.
 * Boneyard stock counts too — projectId null groups its marks... except the
 * Boneyard HAS no marks, so in practice this is per-job windows only; the
 * grouping key keeps that honest rather than assuming it.
 */
export function splitUnits(
  packages: StoragePackage[],
  containersById: Map<string, StorageContainer>,
  locationsById: Map<string, PlaceLocation>,
): SplitUnit[] {
  const byUnit = new Map<string, StoragePackage[]>();
  for (const p of packages) {
    if (!ON_HAND.has(p.status)) continue;
    for (const m of p.package_marks ?? []) {
      const key = `${p.project_id ?? "boneyard"}|${m.mark_code}`;
      const list = byUnit.get(key) ?? [];
      list.push(p);
      byUnit.set(key, list);
    }
  }

  const out: SplitUnit[] = [];
  for (const [key, rows] of byUnit) {
    const keys = new Set(rows.map(placeKey));
    if (keys.size < 2) continue;
    const [projectId, markCode] = key.split("|");
    const places = [...new Set(rows.map((p) => placeWhere(p, containersById, locationsById)))];
    out.push({
      projectId: projectId === "boneyard" ? null : projectId,
      markCode,
      places,
      partsOnHand: rows.length,
    });
  }
  return out.sort((a, b) =>
    a.markCode.localeCompare(b.markCode, undefined, { numeric: true }),
  );
}

/**
 * The lines shown above the confirm button when a pick splits a unit: for
 * each window losing only SOME of its on-hand parts, where the rest stay.
 * Empty when nothing splits, which is the common case and stays silent.
 */
export function splitLines(
  pickedIds: Set<string>,
  packages: StoragePackage[],
  containersById: Map<string, StorageContainer>,
  locationsById: Map<string, PlaceLocation>,
): string[] {
  const marksTouched = new Map<string, { projectId: string | null; mark: string }>();
  for (const p of packages) {
    if (!pickedIds.has(p.id)) continue;
    for (const m of p.package_marks ?? []) {
      marksTouched.set(`${p.project_id ?? "boneyard"}|${m.mark_code}`, {
        projectId: p.project_id ?? null,
        mark: m.mark_code,
      });
    }
  }

  const lines: string[] = [];
  for (const [key, unit] of marksTouched) {
    const siblings = packages.filter(
      (p) =>
        ON_HAND.has(p.status) &&
        `${p.project_id ?? "boneyard"}|` !== "" &&
        (p.project_id ?? "boneyard") === (unit.projectId ?? "boneyard") &&
        (p.package_marks ?? []).some((m) => m.mark_code === unit.mark),
    );
    const staying = siblings.filter((p) => !pickedIds.has(p.id));
    const taking = siblings.length - staying.length;
    if (staying.length === 0 || taking === 0) continue;

    const where = [...new Set(staying.map((p) => placeWhere(p, containersById, locationsById)))];
    lines.push(
      `Window ${unit.mark} — taking ${taking} of its ${siblings.length} part${
        siblings.length === 1 ? "" : "s"
      } here; the other ${staying.length} stay${staying.length === 1 ? "s" : ""} ${spotPhrase(where)}.`,
    );
    void key;
  }
  return lines;
}

/**
 * The same warning, the other direction (owner call: it belongs at check-in
 * too, not just checkout/set-aside). Storing a package INTO a container when
 * its on-hand siblings — same job, same window number — already sit
 * somewhere else: "Part 2 of 4 — the other 3 parts are at Conex 3" when the
 * label carries a part number, "Window 16 — ..." when it does not. Never
 * blocks: splitting on purpose (a frame on site while glass waits) is
 * exactly why the checkout side doesn't block either.
 *
 * Takes the FULL packages list, not just the candidates being stored — a
 * sibling already sitting in a different container has to be found among
 * everything the warehouse holds, not just what's on this pick list.
 */
export function splitLinesOnStore(
  incomingIds: Set<string>,
  packages: StoragePackage[],
  destContainerId: string,
  containersById: Map<string, StorageContainer>,
  locationsById: Map<string, PlaceLocation>,
): string[] {
  const marksTouched = new Map<string, { projectId: string | null; mark: string }>();
  for (const p of packages) {
    if (!incomingIds.has(p.id)) continue;
    for (const m of p.package_marks ?? []) {
      marksTouched.set(`${p.project_id ?? "boneyard"}|${m.mark_code}`, {
        projectId: p.project_id ?? null,
        mark: m.mark_code,
      });
    }
  }

  const lines: string[] = [];
  for (const unit of marksTouched.values()) {
    const sameUnit = (p: StoragePackage) =>
      (p.project_id ?? "boneyard") === (unit.projectId ?? "boneyard") &&
      (p.package_marks ?? []).some((m) => m.mark_code === unit.mark);

    // Already on hand somewhere else, and not itself part of this store —
    // the whole reason this store would leave the window split.
    const elsewhere = packages.filter(
      (p) =>
        sameUnit(p) &&
        ON_HAND.has(p.status) &&
        !incomingIds.has(p.id) &&
        p.container_id !== destContainerId,
    );
    if (elsewhere.length === 0) continue;

    // Named off the incoming package itself when it carries a part number —
    // regardless of ITS current status, so a checked-out piece coming back
    // in still reads as "Part 2 of 4" rather than falling back to the
    // window number just because it wasn't counted as on-hand a moment ago.
    const incoming = packages.filter((p) => incomingIds.has(p.id) && sameUnit(p));
    const piece = incoming.find(hasPartNumber);
    const label = piece ? `Part ${piece.part_index} of ${piece.part_total}` : `Window ${unit.mark}`;
    const where = [...new Set(elsewhere.map((p) => placeWhere(p, containersById, locationsById)))];
    lines.push(
      `${label} — the other ${elsewhere.length} part${elsewhere.length === 1 ? "" : "s"} ${
        elsewhere.length === 1 ? "is" : "are"
      } ${spotPhrase(where)}.`,
    );
  }
  return lines;
}
