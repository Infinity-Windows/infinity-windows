// Client side of the Monday.com connector: read the staged incoming jobs,
// trigger the (self-throttled) sync, and turn a staged row into a real app
// project with the office's job code. The sync itself lives in the
// monday-sync edge function; see its header for the full design.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import { createProject, type CreateProjectInput } from "./api";

/**
 * One file Monday says is attached to a staged row.
 *
 * Never a URL. Monday's own `public_url` is valid for an hour, so the sync
 * stores the asset id and the pull asks for a fresh link server-side at the
 * moment somebody presses the button.
 */
export interface MondayFile {
  asset_id: string;
  name: string;
  /** Monday returns ".pdf", with the dot. */
  ext: string | null;
  /** Bytes, or null when Monday did not say. */
  size: number | null;
  /** Which of the board's two file columns it came from. */
  column_id: string;
  uploaded_at: string | null;
}

export interface MondayJob {
  id: string;
  monday_item_id: string;
  name: string;
  group_title: string | null;
  status: string | null;
  job_type: string | null;
  start_date: string | null;
  end_date: string | null;
  est_arrival: string | null;
  budget: number | null;
  flashing_note: string | null;
  synced_at: string;
  project_id: string | null;
  dismissed_at: string | null;
  /**
   * Optional because a phone can be running ahead of the migration: the column
   * simply is not in the row yet, and every screen has to read that as "no
   * files known" rather than crashing. Use `filesOnMonday` below.
   */
  files?: MondayFile[] | null;
}

/** The row's file list, however incomplete the row is. Never throws. */
export function filesOnMonday(job: Pick<MondayJob, "files">): MondayFile[] {
  return Array.isArray(job.files) ? job.files.filter((f) => f && f.asset_id) : [];
}

/** Where a pulled Monday file lands on the job. */
export type MondayFileKind = "building" | "specs" | "document";

/** The three formats the planset slots can actually do anything with. */
const EXTRACTABLE_EXTENSIONS = new Set(["pdf", "dwg", "dxf"]);

/** "pdf" from ".PDF", "HC24 - LP.pdf", or nothing at all. */
export function fileExtension(name: string, ext?: string | null): string {
  const raw =
    (ext ?? "").trim() ||
    (name.includes(".") ? name.slice(name.lastIndexOf(".")) : "");
  return raw.replace(/^\./, "").toLowerCase();
}

/** Could this file be a plan set or a spec sheet at all? */
export function isExtractableFile(name: string, ext?: string | null): boolean {
  return EXTRACTABLE_EXTENSIONS.has(fileExtension(name, ext));
}

/**
 * Which slot a Monday file probably belongs in, from its name.
 *
 * THIS IS THE OFFICE'S OWN SHORTHAND, not a convention we invented. On the Ops
 * Gantt Chart a file called "SV2 - LP.pdf" is the plan set ("LP"), "SV2 - CU.pdf"
 * is the cut sheets, and "Summit View 2 - July16_26 - IRON.pdf" is the ironwork
 * order — paperwork worth keeping and not something to run an extraction over.
 *
 * A GUESS, shown before anything is pulled and always overridable. The office
 * has been naming these files by hand for years and the shorthand holds on most
 * rows, not all of them; being wrong quietly is what would turn a signed quote
 * into a building plan the map then tries to draw from.
 *
 * The rules, in the order they are asked:
 *   1. Anything that is not a PDF, DWG or DXF is a document. The other two
 *      slots feed a plan renderer and an extractor, and neither can open a
 *      spreadsheet.
 *   2. "LP", or the word "plan" / "plans" (which is also how "Marked Plans"
 *      lands here) — the building plan.
 *   3. "CU", "CAD" / "CADs", "specs", or "units" — the spec sheets.
 *   4. Everything else is a job document.
 *
 * Plans are asked FIRST on purpose: a sheet named for both is far more likely
 * to be the marked-up plan set with a CAD note in its name than the reverse,
 * and the plan slot is the one a foreman notices is empty.
 *
 * Whole words only. "LP" must not be found inside "Alpine" and "CU" must not be
 * found inside "Cut List" — every one of those is a real name shape on this
 * board. The extension is stripped before matching so a ".dwg" can never read
 * as a word in the name.
 */
export function guessMondayFileKind(
  name: string,
  ext?: string | null,
): MondayFileKind {
  if (!isExtractableFile(name, ext)) return "document";
  const base = name.replace(/\.[^.]*$/, "");
  if (/\b(lp|plans?)\b/i.test(base)) return "building";
  if (/\b(cu|cads?|specs?|units?)\b/i.test(base)) return "specs";
  return "document";
}

/** Staged Monday jobs awaiting review — newest sync first. */
export async function listIncomingMondayJobs(): Promise<MondayJob[]> {
  const { data, error } = await supabase
    .from("monday_jobs")
    .select("*")
    .is("project_id", null)
    .is("dismissed_at", null)
    .is("left_groups_at", null)
    .order("start_date", { ascending: true, nullsFirst: false });
  if (error) {
    if (isMissingTable(error, "monday_jobs")) return [];
    throw error;
  }
  return (data ?? []) as MondayJob[];
}

/**
 * Ask the edge function to refresh from Monday. Fire-and-forget from the
 * Jobs page: the function itself throttles to one real sync per ~10 min,
 * so calling on every page load is safe and keeps working-hours freshness
 * around 15 minutes without any cron. `force` bypasses the throttle
 * (the manual "Sync now" button).
 */
export async function triggerMondaySync(force = false): Promise<{
  ok: boolean;
  synced?: number;
  skipped?: string;
  error?: string;
}> {
  const { data, error } = await supabase.functions.invoke("monday-sync", {
    body: { force },
  });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; synced?: number; skipped?: string };
}

/**
 * What a staged Monday row becomes when it is built into a real job.
 *
 * Pure, and separate from the write below, so the mapping itself is testable:
 * this is the one place where a fact Monday knows turns into a fact the app
 * runs on, and getting it wrong is invisible until somebody drives to a job.
 *
 * Wave J (J3) added the two lines that matter here. `est_arrival` has been
 * synced into monday_jobs since the connector shipped and then thrown away at
 * build time — the office already knew when the windows were coming and the app
 * did not. It is now the job's `materials_eta`. And an imported job is born
 * NOT READY: nobody has walked that site or checked its order, so it should not
 * claim otherwise the moment it lands.
 */
export function buildInputFromMonday(
  job: MondayJob,
  input: CreateProjectInput,
): CreateProjectInput {
  return {
    ...input,
    materialsEta: input.materialsEta ?? job.est_arrival ?? null,
    readyState: input.readyState ?? "not_ready",
  };
}

/** Build a real project from a staged row and link the two. */
export async function buildProjectFromMonday(
  job: MondayJob,
  input: CreateProjectInput,
): Promise<void> {
  const project = await createProject(buildInputFromMonday(job, input));
  const { error } = await supabase
    .from("monday_jobs")
    .update({ project_id: project.id })
    .eq("id", job.id);
  if (error) throw error;
}

export async function dismissMondayJob(id: string): Promise<void> {
  const { error } = await supabase
    .from("monday_jobs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
