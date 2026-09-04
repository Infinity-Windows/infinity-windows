// "Data off" — the unit is fine, its paperwork isn't.
//
// Wave E (transcripts program, owner grill 2026-09-03, Q12). The crew already
// had a free-text flag; what nobody could do was COUNT the times the record was
// wrong, because "wrong size" and "came mirrored" and "not what the plans show"
// all landed in one text box. This module is the vocabulary: five reasons, the
// words a person reads, and the one rule that keeps history honest — a flag
// raised before this shipped has no reason recorded, so it reads as "other"
// rather than being guessed at.
//
// Deliberately pure and free of React/Supabase: the map, the Data Tab, the
// estimating filter and the opening sheet all have to agree on what "data off"
// means, and they only can if they all read it from here.

import type { TKey } from "../i18n/catalog";

/** The five reasons a unit's record can be wrong. Mirrors the CHECK on
 *  project_openings.flag_kind (20260977000000). */
export const DATA_OFF_KINDS = [
  "wrong_size",
  "mirrored",
  "not_as_drawn",
  "not_on_plans",
  "other",
] as const;

export type DataOffKind = (typeof DATA_OFF_KINDS)[number];

/**
 * The four reasons an installer PICKS FROM on the sheet. `not_on_plans` is
 * missing on purpose: it is what add_field_unit stamps on a unit somebody
 * found on site, so offering it here would invite a flag on an existing mark
 * that means "this window isn't on the plans" — which is a missed unit, and
 * has its own button.
 */
export const DATA_OFF_CHOICES: readonly DataOffKind[] = [
  "wrong_size",
  "mirrored",
  "not_as_drawn",
  "other",
];

/** The catalog key naming each reason, so both languages come from one place. */
export const DATA_OFF_LABEL_KEYS: Record<DataOffKind, TKey> = {
  wrong_size: "dataoff.reason.wrongSize",
  mirrored: "dataoff.reason.mirrored",
  not_as_drawn: "dataoff.reason.notAsDrawn",
  not_on_plans: "dataoff.reason.notOnPlans",
  other: "dataoff.reason.other",
};

/** What the flag columns look like to every reader here. */
export interface FlaggableOpening {
  flag_kind?: string | null;
  flag_note?: string | null;
}

export function isDataOffKind(value: unknown): value is DataOffKind {
  return typeof value === "string" && (DATA_OFF_KINDS as readonly string[]).includes(value);
}

/**
 * The reason this unit's record is off, or null when it isn't flagged.
 *
 * A note with no kind is a flag raised before reasons existed (or by the old
 * two-argument RPC, which is still live for callers that never asked for one).
 * Nobody was ever asked which kind it was, so "other" is the only honest
 * answer — the same backfill the migration wrote.
 */
export function dataOffKind(opening: FlaggableOpening | null | undefined): DataOffKind | null {
  if (!opening) return null;
  if (isDataOffKind(opening.flag_kind)) return opening.flag_kind;
  if (opening.flag_kind != null && String(opening.flag_kind).trim() !== "") return "other";
  if (opening.flag_note?.trim()) return "other";
  return null;
}

/** True when this unit's record is flagged as wrong, whatever the reason. */
export function isDataOff(opening: FlaggableOpening | null | undefined): boolean {
  return dataOffKind(opening) !== null;
}

/** Ids of every flagged unit in a list — what the map and the Data Tab want. */
export function dataOffIds<T extends FlaggableOpening & { id: string }>(
  openings: readonly T[],
): Set<string> {
  const out = new Set<string>();
  for (const o of openings) if (isDataOff(o)) out.add(o.id);
  return out;
}

/**
 * The share of units whose record is off — shown beside the rework rate, and
 * read the same way: how often does the paperwork lie? Null when there are no
 * units to divide by, so a fresh job says nothing rather than "0%".
 */
export function dataOffRate(flagged: number, total: number): number | null {
  if (total <= 0) return null;
  return flagged / total;
}
