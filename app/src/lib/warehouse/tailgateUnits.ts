// The tailgate, unit first (warehouse redesign wave 4, owner call
// 2026-09-06): one row per window or door, not per box. Tick a unit and every
// expected piece arrives; identical units are one row with a count; the dots
// say which pieces are here. Then one button puts everything that arrived
// into the box you used last. Pure over the delivery's job groups, so the
// rows are testable without a truck.

import type { JobGroup, SlotRow } from "./deliveryReceiving";

export type PieceState = "expected" | "arrived" | "stored";

export interface UnitRow {
  key: string;
  jobKey: string;
  projectId: string | null;
  pendingJobName: string | null;
  jobLabel: string;
  mark: string;
  /** "BLACK22 · #16" or "Sunset Ridge 4 · #5050". */
  title: string;
  /** "3 pieces · frame, glass, hardware" or "sealed crate". */
  sub: string;
  /** Identical units on this truck sharing the mark (clone sets); 1 when not. */
  twins: number;
  pieces: { id: string; state: PieceState }[];
  expectedIds: string[];
  looseIds: string[];
  total: number;
  arrived: number;
  stored: number;
}

export type Tick = "none" | "some" | "all";

export function tickOf(row: UnitRow): Tick {
  if (row.total === 0 || row.arrived + row.stored === 0) return "none";
  if (row.expectedIds.length === 0) return "all";
  return "some";
}

function pieceStates(slot: SlotRow): { id: string; state: PieceState }[] {
  const expected = new Set(slot.expectedIds);
  const loose = new Set(slot.looseIds);
  return slot.allIds.map((id) => ({
    id,
    state: expected.has(id) ? "expected" : loose.has(id) ? "arrived" : "stored",
  }));
}

export function tailgateUnits(groups: readonly JobGroup[], jobTitle: (projectId: string) => string | null): UnitRow[] {
  const out: UnitRow[] = [];
  for (const g of groups) {
    const jobLabel = g.projectId ? (jobTitle(g.projectId) ?? "Job") : (g.pendingJobName ?? "?");
    const byMark = new Map<string, SlotRow[]>();
    for (const r of g.rows) {
      const list = byMark.get(r.mark) ?? [];
      list.push(r);
      byMark.set(r.mark, list);
    }
    for (const [mark, slots] of byMark) {
      const pieces = slots.flatMap(pieceStates);
      const expectedIds = slots.flatMap((s) => s.expectedIds);
      const looseIds = slots.flatMap((s) => s.looseIds);
      const boxSlots = slots.filter((s) => !s.isCrate);
      // Clone sets: every box slot of an identical set carries the same
      // number of packages; that number is how many twins are on the truck.
      const twins = boxSlots.length > 0 ? Math.max(1, ...boxSlots.map((s) => s.allIds.length)) : 1;
      const labels = slots
        .map((s) => (s.isCrate ? "crate pieces" : s.partType))
        .filter((x): x is string => Boolean(x));
      const perUnit = twins > 1 ? Math.round(pieces.length / twins) : pieces.length;
      const sub =
        slots.length === 1 && slots[0].isCrate
          ? slots[0].label.replace(/^.*— /, "")
          : `${perUnit} piece${perUnit === 1 ? "" : "s"}${labels.length ? ` · ${[...new Set(labels)].join(", ")}` : ""}`;
      out.push({
        key: `${g.key}|${mark}`,
        jobKey: g.key,
        projectId: g.projectId,
        pendingJobName: g.pendingJobName,
        jobLabel,
        mark,
        title: `${jobLabel} · #${mark}`,
        sub,
        twins,
        pieces,
        expectedIds,
        looseIds,
        total: pieces.length,
        arrived: pieces.filter((p) => p.state === "arrived").length,
        stored: pieces.filter((p) => p.state === "stored").length,
      });
    }
  }
  return out;
}

/** Everything on this truck that arrived and is not put away yet. */
export function looseOnTruck(rows: readonly UnitRow[]): string[] {
  return rows.flatMap((r) => r.looseIds);
}

/** The delivery's headline: "31 of 54 arrived · 23 still missing". */
export function truckHeadline(rows: readonly UnitRow[]): string {
  const total = rows.reduce((n, r) => n + r.total, 0);
  const here = rows.reduce((n, r) => n + r.arrived + r.stored, 0);
  const missing = total - here;
  if (total === 0) return "Nothing expected on this truck yet.";
  // "pieces here", not "arrived": the delivery page's own header already
  // says "N of M expected boxes arrived", and two lines saying the same
  // words would read as a stutter (and trip a strict text match).
  return `${here} of ${total} pieces here${missing > 0 ? ` · ${missing} still missing` : " · all here"}`;
}
