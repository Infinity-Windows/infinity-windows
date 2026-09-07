// Job facts (S4, .scratch/installer-os): the job-level build answers a
// foreman records once so nobody on the crew has to ask twice — exterior
// finish, set depth, flashing system, fasteners, sill pan, site rules, the
// GC's contact, and a note per elevation.
//
// project_build_facts (20261001000000) is RPC-only, same law as
// project_pipeline: every write goes through upsert_build_facts, which is
// foreman+ and merges a partial patch so the Job facts card can save one
// field at a time. Reads are open to every signed-in crew role — an
// installer wants to know it's stucco and outset just as much as the
// foreman who filed it — and walled from a partner login (THE WALL).
//
// Degrades rather than crashes on a database ahead of the migration:
// getBuildFacts answers null and listGreenLightItems answers [] instead of
// throwing, so the card and the checklist are simply not offered yet.
//
// ADR-0011: job facts are the job's answers; the per-unit spec
// (project_mark_specs.extra) stays authoritative for what actually gets
// installed at one opening.

import { supabase } from "../supabase";
import { isMissingFunction, isMissingTable } from "../schemaErrors";
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

export const SILL_PAN_REQUIREMENTS = ["required", "not_required", "unknown"] as const;
export type SillPanRequirement = (typeof SILL_PAN_REQUIREMENTS)[number];

export const SILL_PAN_TYPES = ["metal", "pvc", "fluid", "tape", "none"] as const;
export type SillPanType = (typeof SILL_PAN_TYPES)[number];

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

export const SILL_PAN_KEYS: Record<SillPanRequirement, TKey> = {
  required: "buildFacts.sillPan.required",
  not_required: "buildFacts.sillPan.notRequired",
  unknown: "buildFacts.sillPan.unknown",
};

export const SILL_PAN_TYPE_KEYS: Record<SillPanType, TKey> = {
  metal: "buildFacts.sillPanType.metal",
  pvc: "buildFacts.sillPanType.pvc",
  fluid: "buildFacts.sillPanType.fluid",
  tape: "buildFacts.sillPanType.tape",
  none: "buildFacts.sillPanType.none",
};

/** Who a green-light item expects to answer it. */
export type GreenLightWho = "foreman" | "supervisor";

export const WHO_KEYS: Record<GreenLightWho, TKey> = {
  foreman: "buildFacts.who.foreman",
  supervisor: "buildFacts.who.supervisor",
};

export interface BuildFacts {
  project_id: string;
  exterior_finish: ExteriorFinish | null;
  exterior_note: string | null;
  set_depth: SetDepth | null;
  set_depth_inches: number | null;
  flashing_system: FlashingSystem | null;
  flashing_note: string | null;
  fastener_type: FastenerType | null;
  fastener_length_in: number | null;
  fastener_spacing_in: number | null;
  fastener_note: string | null;
  sill_pan: SillPanRequirement | null;
  sill_pan_type: SillPanType | null;
  site_rules: string | null;
  gc_contact_name: string | null;
  gc_contact_phone: string | null;
  note_north: string | null;
  note_south: string | null;
  note_east: string | null;
  note_west: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** The whitelisted column names upsert_build_facts accepts — mirrors the SQL
 * function's own v_allowed array (20261001000000). Kept as a value (not just
 * a type) so buildFactsPatchKeys.test.ts can assert the two never drift. */
export const BUILD_FACTS_PATCH_KEYS = [
  "exterior_finish",
  "exterior_note",
  "set_depth",
  "set_depth_inches",
  "flashing_system",
  "flashing_note",
  "fastener_type",
  "fastener_length_in",
  "fastener_spacing_in",
  "fastener_note",
  "sill_pan",
  "sill_pan_type",
  "site_rules",
  "gc_contact_name",
  "gc_contact_phone",
  "note_north",
  "note_south",
  "note_east",
  "note_west",
] as const;

export type BuildFactsField = (typeof BUILD_FACTS_PATCH_KEYS)[number];

export type BuildFactsPatch = Partial<Pick<BuildFacts, BuildFactsField>>;

const BUILD_FACTS_COLS =
  "project_id, exterior_finish, exterior_note, set_depth, set_depth_inches, " +
  "flashing_system, flashing_note, fastener_type, fastener_length_in, " +
  "fastener_spacing_in, fastener_note, sill_pan, sill_pan_type, site_rules, " +
  "gc_contact_name, gc_contact_phone, note_north, note_south, note_east, note_west, " +
  "updated_by, updated_at";

export function buildFactsKey(projectId: string): unknown[] {
  return ["buildFacts", projectId];
}

export function greenLightItemsKey(projectId: string): unknown[] {
  return ["greenLightItems", projectId];
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
    throw new Error(formatApiError(error));
  }
  return (data as BuildFacts | null) ?? null;
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

/** A GC check-in's answers, narrowed to the three fields upsert_build_facts
 * seeds a job's FIRST build-facts row from. */
export interface GcCheckinSeedSource {
  set_preference: string | null;
  exterior_material: string | null;
  contact_name: string | null;
}

/**
 * Mirrors the seed branch of upsert_build_facts (20261001000000): what a
 * job's first-ever job-facts write inherits from its most recent GC
 * check-in, before the caller's own patch is applied. The SQL is the copy
 * that actually runs; this one exists so the mapping can be read and tested
 * without a database, the same reason pipeline.ts mirrors
 * claim_pipeline_nudges.
 *
 * `unknown` stays unseeded on purpose — an "I don't know" from the GC is not
 * a fact worth carrying forward as one.
 */
export function seedFromGcCheckin(checkin: GcCheckinSeedSource | null): BuildFactsPatch {
  if (!checkin) return {};
  const seed: BuildFactsPatch = {};
  if (checkin.set_preference && checkin.set_preference !== "unknown") {
    seed.set_depth = checkin.set_preference as SetDepth;
  }
  if (checkin.exterior_material && checkin.exterior_material.trim() !== "") {
    seed.exterior_note = checkin.exterior_material;
  }
  if (checkin.contact_name && checkin.contact_name.trim() !== "") {
    seed.gc_contact_name = checkin.contact_name;
  }
  return seed;
}
