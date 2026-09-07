// Job facts on the unit sheet (S5, .scratch/installer-os/installer-os-spec.md).
// The read-only card an installer sees under the spec card is a REPORT, not a
// form — every value here is either the job's own answer (project_build_facts,
// S4) or, when the unit's own spec disagrees, the spec's answer instead. This
// file holds the pure logic behind that report: which of the four elevation
// notes is THIS unit's, and which of the two set-depth answers wins. Both are
// unit-tested directly (unitFactsCard.test.ts) because a wrong elevation or a
// silently-dropped disagreement sends a crew to install the wrong way.
//
// ADR-0011: job facts are the job's DEFAULT answer; project_mark_specs.extra
// stays authoritative for what actually gets installed at one opening.

import { markBase } from "./extract";
import {
  parseViewTitle,
  pickElevationViews,
  type ElevationViewLike,
} from "./elevationViews";
import { formatInches } from "./specs";
import type { BuildFacts, SetDepth } from "./buildFacts";

export type Elevation = "north" | "south" | "east" | "west";

const COMPASS_TO_ELEVATION: Record<string, Elevation> = {
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
};

/**
 * Which side of the building one unit is drawn on, read off the mark's
 * elevation-reference captions (project_mark_elevation_views.view_name) — the
 * same captions MarkElevationCrop parses to find the picture. `pickElevationViews`
 * does the same de-duplication and ranking a foreman relies on there: two
 * captions naming the same face collapse to one, and a straight elevation with
 * a compass bearing outranks a property view of the same wall. Null when
 * nothing on file names a compass side for this unit — a chained unit
 * ("1-2") is normalized to its base mark ("1") the same way the spec card
 * looks up its own spec. PURE.
 */
export function deriveUnitElevation(
  openingCode: string | null | undefined,
  views: readonly ElevationViewLike[],
): Elevation | null {
  if (!openingCode) return null;
  const wanted = markBase(openingCode).toUpperCase();
  const mine = views.filter((v) => v.mark_code.trim().toUpperCase() === wanted);
  const best = pickElevationViews(mine)[0];
  if (!best?.view_name) return null;
  const title = parseViewTitle(best.view_name);
  if (!title?.compass) return null;
  return COMPASS_TO_ELEVATION[title.compass] ?? null;
}

export interface ElevationNote {
  elevation: Elevation;
  note: string;
}

const ELEVATION_NOTE_FIELD: Record<Elevation, keyof BuildFacts> = {
  north: "note_north",
  south: "note_south",
  east: "note_east",
  west: "note_west",
};

const ELEVATIONS: readonly Elevation[] = ["north", "south", "east", "west"];

/**
 * The elevation note(s) worth showing on a unit sheet: the ONE note for the
 * unit's own side of the building when that side is known, or every
 * non-empty note (each labelled with its side) when it isn't — so a unit
 * with no elevation reference on file doesn't lose the north note just
 * because nobody can say it's the north one. PURE.
 */
export function elevationNotesFor(
  facts: BuildFacts,
  elevation: Elevation | null,
): ElevationNote[] {
  const nonEmpty = (e: Elevation): ElevationNote | null => {
    const note = facts[ELEVATION_NOTE_FIELD[e]] as string | null;
    return note && note.trim() !== "" ? { elevation: e, note } : null;
  };
  if (elevation) {
    const note = nonEmpty(elevation);
    return note ? [note] : [];
  }
  return ELEVATIONS.map(nonEmpty).filter((n): n is ElevationNote => n != null);
}

export interface SetDepthLine {
  /** The set-depth value to display — the unit's own spec value when it
   * disagrees and wins, the job fact's own value otherwise. */
  value: SetDepth;
  /** True when the unit's own spec carries an inset/outset that differs
   * from the job's set_depth — the disagreement sentence renders only then. */
  disagrees: boolean;
}

/**
 * Resolve which set-depth value the sheet should show, and whether the
 * unit's own spec is overriding the job's answer. Null when the job hasn't
 * recorded a set depth at all — an unanswered job fact stays hidden
 * regardless of what one unit's spec says (ADR-0011: job facts are a
 * DEFAULT; a unit with no default to override shows nothing here, same as
 * every other unanswered field on this card). PURE.
 */
export function resolveSetDepthLine(
  jobSetDepth: SetDepth | null,
  specInsetOutset: "inset" | "outset" | null,
): SetDepthLine | null {
  if (!jobSetDepth) return null;
  if (specInsetOutset && specInsetOutset !== jobSetDepth) {
    return { value: specInsetOutset, disagrees: true };
  }
  return { value: jobSetDepth, disagrees: false };
}

/**
 * Set depth the way a foreman says it out loud: the translated word, plus
 * the inch when the job recorded one — "Outset 1"" — never a bare "Outset"
 * once an inch is on file, and never a decimal. Caller supplies the already
 * translated label (a catalog concern); this is formatting only. PURE.
 */
export function formatSetDepthValue(label: string, inches: number | null): string {
  const inchStr = formatInches(inches);
  return inchStr ? `${label} ${inchStr}` : label;
}

/**
 * A unit's own inset/outset call, read off its mark spec's `extra` the same
 * way the spec review screen does (SpecReviewSection.tsx) — never widened to
 * read anything else out of `extra`. PURE.
 */
export function specInsetOutsetOf(
  extra: Record<string, unknown> | null | undefined,
): "inset" | "outset" | null {
  const v = extra?.inset_outset;
  return v === "inset" || v === "outset" ? v : null;
}

/**
 * Join the non-empty pieces of one fact line with the card's separator —
 * "Flange screw · 2½" · every 12"" — dropping anything blank so the dots
 * never double up. Null when nothing survived, so a caller can hide the row.
 * PURE.
 */
export function joinFactLine(
  parts: readonly (string | null | undefined)[],
): string | null {
  const kept = parts.filter(
    (p): p is string => p != null && p.trim() !== "",
  );
  return kept.length > 0 ? kept.join(" · ") : null;
}

/**
 * True when at least one job-fact field this card can show is actually
 * answered. Drives the empty state: "No job facts yet" only when every
 * field — including every elevation note — is blank. PURE.
 */
export function hasAnyUnitFact(
  facts: BuildFacts | null,
  elevation: Elevation | null,
): boolean {
  if (!facts) return false;
  const plain: (string | number | null)[] = [
    facts.exterior_finish,
    facts.exterior_note,
    facts.set_depth,
    facts.flashing_system,
    facts.flashing_note,
    facts.fastener_type,
    facts.fastener_length_in,
    facts.fastener_spacing_in,
    facts.fastener_note,
    facts.sill_pan,
    facts.sill_pan_type,
    facts.site_rules,
    facts.gc_contact_name,
    facts.gc_contact_phone,
  ];
  if (plain.some((v) => v != null && v !== "")) return true;
  return elevationNotesFor(facts, elevation).length > 0;
}
