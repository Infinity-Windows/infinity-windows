// Job facts (S4, .scratch/installer-os): the job-level build answers a
// foreman records once so nobody on the crew has to ask twice — the exterior
// situations (one line per finish on the house: brick outset an inch, stucco
// inset an inch and a quarter), flashing system, fasteners, site rules, the
// GC's contact, and one box of elevation notes.
//
// project_build_facts (20261001000000, reshaped by 20261002000000) is
// RPC-only, same law as project_pipeline: every write goes through
// upsert_build_facts, which is foreman+ and merges a partial patch so the
// Job facts card can save one field at a time. Reads are open to every
// signed-in crew role — an installer wants to know it's stucco and outset
// just as much as the foreman who filed it — and walled from a partner login
// (THE WALL).
//
// Degrades rather than crashes on a database ahead of (or behind) the
// migration: getBuildFacts answers null and listGreenLightItems answers []
// instead of throwing, so the card and the checklist are simply not offered
// yet.
//
// ADR-0011: job facts are the job's answers; the per-unit spec
// (project_mark_specs.extra) stays authoritative for what actually gets
// installed at one opening.

import { supabase } from "../supabase";
import { isMissingColumn, isMissingFunction, isMissingTable } from "../schemaErrors";
import { formatApiError } from "./errors";
import { enqueueSaveBuildFacts } from "../offline/outbox";
import type { TKey } from "../i18n/catalog";

export const EXTERIOR_FINISHES = ["stucco", "rock", "siding", "brick", "other"] as const;
export type ExteriorFinish = (typeof EXTERIOR_FINISHES)[number];

export const SET_DEPTHS = ["inset", "outset", "unknown"] as const;
export type SetDepth = (typeof SET_DEPTHS)[number];

export const FLASHING_SYSTEMS = ["butyl_tape", "paper_flashing", "fluid_applied", "other"] as const;
export type FlashingSystem = (typeof FLASHING_SYSTEMS)[number];

export const FASTENER_TYPES = ["flange_screw", "jamb_screw", "concrete_screw", "other"] as const;
export type FastenerType = (typeof FASTENER_TYPES)[number];

/** Every pick-list value, mapped to its catalog key. The catalog (both
 * languages) is the source of the label text; this file only says which key
 * goes with which stored value. */
export const EXTERIOR_FINISH_KEYS: Record<ExteriorFinish, TKey> = {
  stucco: "buildFacts.exteriorFinish.stucco",
  rock: "buildFacts.exteriorFinish.rock",
  siding: "buildFacts.exteriorFinish.siding",
  brick: "buildFacts.exteriorFinish.brick",
  other: "buildFacts.exteriorFinish.other",
};

export const SET_DEPTH_KEYS: Record<SetDepth, TKey> = {
  inset: "buildFacts.setDepth.inset",
  outset: "buildFacts.setDepth.outset",
  unknown: "buildFacts.setDepth.unknown",
};

export const FLASHING_SYSTEM_KEYS: Record<FlashingSystem, TKey> = {
  butyl_tape: "buildFacts.flashingSystem.butylTape",
  paper_flashing: "buildFacts.flashingSystem.paperFlashing",
  fluid_applied: "buildFacts.flashingSystem.fluidApplied",
  other: "buildFacts.flashingSystem.other",
};

export const FASTENER_TYPE_KEYS: Record<FastenerType, TKey> = {
  flange_screw: "buildFacts.fastenerType.flangeScrew",
  jamb_screw: "buildFacts.fastenerType.jambScrew",
  concrete_screw: "buildFacts.fastenerType.concreteScrew",
  other: "buildFacts.fastenerType.other",
};

/** Who a green-light item expects to answer it. */
export type GreenLightWho = "foreman" | "supervisor";

export const WHO_KEYS: Record<GreenLightWho, TKey> = {
  foreman: "buildFacts.who.foreman",
  supervisor: "buildFacts.who.supervisor",
};

/**
 * One exterior situation: "where it's brick, it's outset an inch". A house
 * carries several — that is the whole reason this is a list and not four
 * columns (owner, 2026-09-07). Every field nullable: a foreman adds a line
 * and fills it in as they learn it.
 */
export interface ExteriorLine {
  exterior_finish: ExteriorFinish | null;
  exterior_note: string | null;
  set_depth: SetDepth | null;
  set_depth_inches: number | null;
}

export const EMPTY_EXTERIOR_LINE: ExteriorLine = {
  exterior_finish: null,
  exterior_note: null,
  set_depth: null,
  set_depth_inches: null,
};

/** The server refuses a longer list; the card stops offering "add" here. */
export const MAX_EXTERIOR_LINES = 20;

export interface BuildFacts {
  project_id: string;
  exterior_lines: ExteriorLine[];
  flashing_system: FlashingSystem | null;
  /** What the flashing is when flashing_system is "other". */
  flashing_system_other: string | null;
  flashing_note: string | null;
  fastener_type: FastenerType | null;
  /** What the fastener is when fastener_type is "other". */
  fastener_type_other: string | null;
  fastener_length_in: number | null;
  fastener_spacing_in: number | null;
  fastener_note: string | null;
  site_rules: string | null;
  gc_contact_name: string | null;
  gc_contact_phone: string | null;
  elevation_notes: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** The whitelisted column names upsert_build_facts accepts — mirrors the SQL
 * function's own v_allowed array (20261002000000). Kept as a value (not just
 * a type) so buildFacts.test.ts can assert the two never drift. */
export const BUILD_FACTS_PATCH_KEYS = [
  "exterior_lines",
  "flashing_system",
  "flashing_system_other",
  "flashing_note",
  "fastener_type",
  "fastener_type_other",
  "fastener_length_in",
  "fastener_spacing_in",
  "fastener_note",
  "site_rules",
  "gc_contact_name",
  "gc_contact_phone",
  "elevation_notes",
] as const;

export type BuildFactsField = (typeof BUILD_FACTS_PATCH_KEYS)[number];

export type BuildFactsPatch = Partial<Pick<BuildFacts, BuildFactsField>>;

const BUILD_FACTS_COLS =
  "project_id, exterior_lines, flashing_system, flashing_system_other, flashing_note, " +
  "fastener_type, fastener_type_other, fastener_length_in, fastener_spacing_in, fastener_note, " +
  "site_rules, gc_contact_name, gc_contact_phone, elevation_notes, updated_by, updated_at";

export const buildFactsKey = (projectId: string) => ["buildFacts", projectId] as const;

export const greenLightItemsKey = (projectId: string) => ["greenLightItems", projectId] as const;

/**
 * Read the stored jsonb list defensively: a row written by the server always
 * has exactly the four keys, but a phone's persisted cache from an earlier
 * bundle, or a hand-edited row, may not. Anything that is not a list is an
 * empty list; anything in it that is not an object is dropped; a value that
 * is not one of the pick-list words reads as "not answered". PURE.
 */
export function normalizeExteriorLines(raw: unknown): ExteriorLine[] {
  if (!Array.isArray(raw)) return [];
  const out: ExteriorLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const finish = o.exterior_finish;
    const depth = o.set_depth;
    const inches = o.set_depth_inches;
    const note = o.exterior_note;
    out.push({
      exterior_finish: (EXTERIOR_FINISHES as readonly string[]).includes(String(finish))
        ? (finish as ExteriorFinish)
        : null,
      exterior_note: typeof note === "string" && note.trim() !== "" ? note : null,
      set_depth: (SET_DEPTHS as readonly string[]).includes(String(depth)) ? (depth as SetDepth) : null,
      set_depth_inches:
        typeof inches === "number" && Number.isFinite(inches)
          ? inches
          : typeof inches === "string" && inches.trim() !== "" && Number.isFinite(Number(inches))
            ? Number(inches)
            : null,
    });
  }
  return out;
}

/** True when a line says nothing at all — the card drops these before
 * saving so a stray tap on "Add" never stores a blank row. PURE. */
export function isBlankExteriorLine(line: ExteriorLine): boolean {
  return (
    line.exterior_finish == null &&
    line.set_depth == null &&
    line.set_depth_inches == null &&
    (line.exterior_note == null || line.exterior_note.trim() === "")
  );
}

/**
 * The label for a pick-list answer, honouring "other": when the stored value
 * is `other` and the foreman named what it actually is, that name IS the
 * label — "Other" on a unit sheet tells an installer nothing. PURE.
 */
export function pickListLabel(
  label: string | null,
  value: string | null,
  other: string | null,
): string | null {
  if (value === "other" && other && other.trim() !== "") return other.trim();
  return label;
}

/** One job's build facts, or null when nobody has recorded any yet (or the
 * migration hasn't reached this database — the two look identical to a
 * reader, and both mean "show the empty state"). */
export async function getBuildFacts(projectId: string): Promise<BuildFacts | null> {
  const { data, error } = await supabase
    .from("project_build_facts")
    .select(BUILD_FACTS_COLS)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "project_build_facts")) return null;
    // A database still on the four-column shape (this bundle ahead of its
    // migration) has no exterior_lines yet: nothing to show, not a crash.
    if (isMissingColumn(error)) return null;
    throw new Error(formatApiError(error));
  }
  if (!data) return null;
  const row = data as unknown as Omit<BuildFacts, "exterior_lines"> & { exterior_lines: unknown };
  return { ...row, exterior_lines: normalizeExteriorLines(row.exterior_lines) };
}

/**
 * Queue one (or a few) job-facts fields through the offline outbox.
 * upsert_build_facts merges the patch server-side and is idempotent on the
 * same value, so this is safe to call again after a lost reply.
 */
export function saveBuildFact(projectId: string, patch: BuildFactsPatch): Promise<string> {
  return enqueueSaveBuildFacts({ projectId, patch });
}

export interface GreenLightItem {
  item_key: string;
  label_en: string;
  answered: boolean;
  who: GreenLightWho;
}

/** The six green-light items for one job, open ones first. Empty on a
 * database that doesn't have green_light_items yet — never an error, since
 * the checklist is a bonus view on top of screens that work without it. */
export async function listGreenLightItems(projectId: string): Promise<GreenLightItem[]> {
  const { data, error } = await supabase.rpc("green_light_items", {
    p_project_id: projectId,
  });
  if (error) {
    if (isMissingFunction(error)) return [];
    throw new Error(formatApiError(error));
  }
  return sortOpenFirst((data ?? []) as GreenLightItem[]);
}

/** Open items first, each half keeping the server's own order — a supervisor
 * reads this top to bottom as "what's left", not as an alphabetized list. */
export function sortOpenFirst(items: GreenLightItem[]): GreenLightItem[] {
  return [...items].sort((a, b) => Number(a.answered) - Number(b.answered));
}

export function openGreenLightItems(items: GreenLightItem[]): GreenLightItem[] {
  return items.filter((i) => !i.answered);
}

/** A GC check-in's answers, narrowed to the fields upsert_build_facts seeds
 * a job's FIRST build-facts row from. */
export interface GcCheckinSeedSource {
  set_preference: string | null;
  exterior_material: string | null;
  contact_name: string | null;
}

/**
 * Mirrors the seed branch of upsert_build_facts (20261002000000): what a
 * job's first-ever job-facts write inherits from its most recent GC
 * check-in, before the caller's own patch is applied. The SQL is the copy
 * that actually runs; this one exists so the mapping can be read and tested
 * without a database, the same reason pipeline.ts mirrors
 * claim_pipeline_nudges.
 *
 * The GC's set preference and "what's going on the outside" become line one
 * of the exterior situations — finish left open, since "stucco" from a GC's
 * mouth is a note, not a pick-list value. `unknown` stays unseeded on
 * purpose — an "I don't know" from the GC is not a fact worth carrying
 * forward as one.
 */
export function seedFromGcCheckin(checkin: GcCheckinSeedSource | null): BuildFactsPatch {
  if (!checkin) return {};
  const seed: BuildFactsPatch = {};
  const depth =
    checkin.set_preference && checkin.set_preference !== "unknown"
      ? (checkin.set_preference as SetDepth)
      : null;
  const material =
    checkin.exterior_material && checkin.exterior_material.trim() !== ""
      ? checkin.exterior_material.trim()
      : null;
  if (depth || material) {
    seed.exterior_lines = [
      { exterior_finish: null, exterior_note: material, set_depth: depth, set_depth_inches: null },
    ];
  }
  if (checkin.contact_name && checkin.contact_name.trim() !== "") {
    seed.gc_contact_name = checkin.contact_name;
  }
  return seed;
}
