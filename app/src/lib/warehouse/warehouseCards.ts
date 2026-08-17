// The four warehouse numbers, redefined against LOCATION instead of status
// (warehouse ticket 06 — grill Q21, Q35-Q37 owner-confirmed 2026-08-17).
//
// The old cards read the unit system's `status` field, which mixes condition
// with location ("staged", "loaded") — the two-answers problem ADR-0004
// exists to kill. These read packages, which are already clean, plus the job
// schedule. The unit system is left completely alone: its statuses and shelf
// spots die in ticket 08, in the same PR that rebuilds the screens using them
// (Q35/Q37), so nothing the crew touches breaks in the meantime.
//
// Each number must be actionable TODAY — that was the bar for keeping a card
// at all, and why "staged" does not come back: it was never something anyone
// could do anything about.

import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { StorageContainer, StoragePackage } from "../storage";
import { placeChain } from "./containment";

export type CardId = "on-hand" | "not-tagged" | "loose" | "damaged";
export type CardTone = "ok" | "warn" | "danger" | undefined;

export interface CardDef {
  id: CardId;
  label: string;
  /** Plain words: what this counts and what to DO about it. Feeds the
   * "What is this?" fold — say the action, not the definition. */
  blurb: string;
  tone?: CardTone;
}

export const WAREHOUSE_CARDS: CardDef[] = [
  {
    id: "on-hand",
    label: "on hand",
    blurb:
      "Every package we are still holding — tagged and not yet taken out to a job. This is the warehouse's whole load.",
  },
  {
    id: "not-tagged",
    label: "not tagged",
    tone: "warn",
    blurb:
      "Windows on an active job's plans with no package tagged yet. Either the material hasn't arrived, or it's here and nobody stuck a sticker on it — and until somebody does, nobody can be told where it is. Tag things as you touch them and this number only goes down.",
  },
  {
    id: "loose",
    label: "loose",
    tone: "warn",
    blurb:
      "Tagged, so we know it exists — but in no conex, no crate and no shelf spot, so the app can't tell anyone where. Scan these into a container and they stop being lost.",
  },
  {
    id: "damaged",
    label: "damaged",
    tone: "danger",
    blurb:
      "Open damage reports — material that arrived broken or got broken here. Each one needs a replacement ordered before that window can be finished. Tap through to the issue to see the photo and who reported it.",
  },
];

export type CardCounts = Record<CardId, number>;

/** A mark on an active job's schedule — what SHOULD exist. */
export interface ScheduledMark {
  project_id: string;
  mark_code: string;
}

/**
 * Every mark on every active job — the "what should exist" side of the
 * not-tagged number.
 *
 * Reads project_marks (ticket 01), which is the marks table the schedule
 * syncs into, rather than project_mark_specs directly: one row per mark
 * already, no per-job round trips, and it is the same table bind_package
 * validates against — so a mark the crew CAN tag is exactly a mark this can
 * count. Active jobs only; a finished job's untagged windows are not today's
 * work.
 */
export async function listScheduledMarks(
  activeProjectIds: string[],
): Promise<ScheduledMark[]> {
  if (activeProjectIds.length === 0) return [];
  const { data, error } = await supabase
    .from("project_marks")
    .select("project_id, mark_code")
    .in("project_id", activeProjectIds);
  if (error) {
    // Before ticket 01's migration there is no such table — the card reads
    // zero and says nothing rather than crashing the hub.
    if (isMissingTable(error, "project_marks")) return [];
    throw error;
  }
  return (data ?? []) as ScheduledMark[];
}

/**
 * Count the four cards.
 *
 * `openDamageCount` is passed in rather than derived: damage lives on
 * `issues`, which point at a unit (`window_id`) and have no package column
 * yet — a package cannot be reported damaged today. Counting open damage
 * REPORTS is true in both eras and is the number a foreman actually acts on,
 * so this card survives the ticket-08 rebuild unchanged.
 */
export function warehouseCounts(
  packages: StoragePackage[],
  containers: StorageContainer[],
  scheduled: ScheduledMark[],
  openDamageCount: number,
): CardCounts {
  const byId = new Map(containers.map((c) => [c.id, c]));
  // Holding = tagged and not yet taken out. A checked-out package is the
  // job's problem now, not the warehouse's.
  const held = packages.filter((p) => p.status === "received" || p.status === "stored");

  const loose = held.filter((p) => placeChain(p, byId).loose).length;

  return {
    "on-hand": held.length,
    // Same function the list uses, so the number and its rows are one rule.
    "not-tagged": untaggedMarks(packages, scheduled).length,
    loose,
    damaged: openDamageCount,
  };
}

/**
 * The packages behind one number, so a count and its list can never disagree.
 *
 * Two cards return nothing on purpose and link elsewhere instead: "not
 * tagged" counts windows that have NO package (there are no rows to show),
 * and "damaged" counts issue reports, which live on the Issues screen.
 */
export function cardPackages(
  card: CardId,
  packages: StoragePackage[],
  containers: StorageContainer[],
): StoragePackage[] {
  const byId = new Map(containers.map((c) => [c.id, c]));
  const held = packages.filter((p) => p.status === "received" || p.status === "stored");
  switch (card) {
    case "on-hand":
      return held;
    case "loose":
      return held.filter((p) => placeChain(p, byId).loose);
    case "not-tagged":
    case "damaged":
      return [];
  }
}

/**
 * Where a card's number goes when tapped.
 *
 * Package-backed cards open on the storage hub, not the old /warehouse/:view
 * list — that screen reads the UNIT system, and these numbers no longer do.
 * Damage reports live on Issues.
 */
export function cardLink(card: CardId): string {
  return card === "damaged" ? "/issues" : `/storage?card=${card}`;
}

/** Scheduled marks with nothing tagged against them — the rows behind the
 * "not tagged" number, since it counts marks rather than packages. */
export function untaggedMarks(
  packages: StoragePackage[],
  scheduled: ScheduledMark[],
): ScheduledMark[] {
  const tagged = new Set<string>();
  for (const p of packages) {
    if (!p.project_id) continue;
    for (const m of p.package_marks ?? []) {
      tagged.add(`${p.project_id}::${m.mark_code.toUpperCase()}`);
    }
  }
  const seen = new Set<string>();
  const out: ScheduledMark[] = [];
  for (const s of scheduled) {
    const code = s.mark_code.trim().toUpperCase();
    const key = `${s.project_id}::${code}`;
    if (seen.has(key) || tagged.has(key)) continue;
    seen.add(key);
    out.push({ project_id: s.project_id, mark_code: code });
  }
  return out;
}
