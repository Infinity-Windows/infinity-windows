// Job facts on the unit sheet (S5, .scratch/installer-os/installer-os-spec.md).
// The read-only card an installer sees under the spec card is a REPORT, not a
// form — every value here is the job's own answer (project_build_facts, S4),
// and when the unit's own spec disagrees with every exterior situation the
// job recorded, the spec's answer is shown instead. This file holds the pure
// logic behind that report, unit-tested directly (unitFactsCard.test.ts)
// because a silently-dropped disagreement sends a crew to install the wrong
// way.
//
// ADR-0011: job facts are the job's DEFAULT answer; project_mark_specs.extra
// stays authoritative for what actually gets installed at one opening.

import { formatInches } from "./specs";
import { isBlankExteriorLine, type BuildFacts, type ExteriorLine, type SetDepth } from "./buildFacts";

export interface SpecOverride {
  /** The unit's own inset/outset call, shown with "it wins". */
  value: SetDepth;
}

/**
 * Whether the unit's own spec overrides what the job recorded. The job now
 * carries a LIST of situations (brick outset, stucco inset), so the spec
 * disagrees only when it names a set depth that NO recorded line uses — a
 * unit on the stucco side whose spec says inset agrees with the stucco
 * line, and nothing is said. Null when the spec has no call, or when the
 * job hasn't answered a set depth anywhere yet (an unanswered job fact stays
 * hidden regardless of what one unit's spec says — ADR-0011: job facts are a
 * DEFAULT; a unit with no default to override shows nothing here). PURE.
 */
export function specOverrideLine(
  lines: readonly ExteriorLine[],
  specInsetOutset: "inset" | "outset" | null,
): SpecOverride | null {
  if (!specInsetOutset) return null;
  const answered = lines.filter((l) => l.set_depth != null);
  if (answered.length === 0) return null;
  if (answered.some((l) => l.set_depth === specInsetOutset)) return null;
  return { value: specInsetOutset };
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
 * field — including every exterior situation — is blank. PURE.
 */
export function hasAnyUnitFact(facts: BuildFacts | null): boolean {
  if (!facts) return false;
  if (facts.exterior_lines.some((l) => !isBlankExteriorLine(l))) return true;
  const plain: (string | number | null)[] = [
    facts.flashing_system,
    facts.flashing_system_other,
    facts.flashing_note,
    facts.fastener_type,
    facts.fastener_type_other,
    facts.fastener_length_in,
    facts.fastener_spacing_in,
    facts.fastener_note,
    facts.site_rules,
    facts.gc_contact_name,
    facts.gc_contact_phone,
    facts.elevation_notes,
  ];
  return plain.some((v) => v != null && v !== "");
}
