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
 * "17.9 MB" — plain enough that somebody on a phone can tell a marked plan set
 * from a one-page quote before deciding to pull it over cell signal. Whole
 * megabytes above 10 MB, one decimal below, kilobytes under a megabyte.
 */
export function fileSizeLabel(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** What the office decided about one file in the Build form. */
export interface MondayFileChoice {
  kind: MondayFileKind;
  selected: boolean;
}

/** One file's fate, as the pull reports it back. */
export interface MondayPullResult {
  asset_id: string;
  name: string;
  ok: boolean;
  /** Which slot on the job it landed in, when it landed. */
  where: "plans" | "specs" | "documents" | null;
  /** True when this exact Monday file was already on the job. */
  already?: boolean;
  /** A plain sentence, from the server, when it did not land. */
  error?: string | null;
}

/**
 * The files to ask the server for, in board order.
 *
 * Pure and separate from the request below, because this is where a decision
 * the office made on screen turns into an instruction the server obeys. Two
 * rules it enforces beyond "what was ticked":
 *
 *   * A file with no choice recorded is TAKEN, at whatever the guesser said.
 *     The form ticks everything by default and un-ticking is the deliberate
 *     act; a file that somehow never got an entry should behave like the rest
 *     of them rather than silently going missing.
 *   * A file that is not a PDF, DWG or DXF is sent as a document whatever the
 *     picker holds. The picker locks that choice on screen, and this is the
 *     second lock: a plan slot fed a spreadsheet is a broken map, and the cost
 *     of being sure here is one line.
 */
export function pullRequestFiles(
  files: MondayFile[],
  choices: Record<string, MondayFileChoice>,
): { asset_id: string; kind: MondayFileKind }[] {
  return files
    .filter((f) => choices[f.asset_id]?.selected !== false)
    .map((f) => ({
      asset_id: f.asset_id,
      kind: isExtractableFile(f.name, f.ext)
        ? choices[f.asset_id]?.kind ?? guessMondayFileKind(f.name, f.ext)
        : ("document" as MondayFileKind),
    }));
}

/** How a pull went, in the three numbers the summary sentence needs. */
export function pullCounts(results: MondayPullResult[]): {
  pulled: number;
  failed: number;
  total: number;
} {
  const pulled = results.filter((r) => r.ok).length;
  return { pulled, failed: results.length - pulled, total: results.length };
}

/**
 * Files Monday has on this job that the app does not.
 *
 * Pure, because this is the whole of "new on Monday": the office adds a revised
 * plan set to the item weeks after the job was built, and the only way anyone
 * finds out today is by opening Monday. `alreadyHere` is every source_asset_id
 * on the job — plansets and documents together, because a file pulled as a
 * document must not keep offering itself as a plan.
 */
export function filesNewOnMonday(
  files: MondayFile[],
  alreadyHere: (string | null | undefined)[],
): MondayFile[] {
  const here = new Set(
    alreadyHere.filter((id): id is string => typeof id === "string" && id !== ""),
  );
  return files.filter((f) => !here.has(f.asset_id));
}

/**
 * The staged Monday row this job was built from, or null.
 *
 * Degrades to null rather than throwing when the table or the files column is
 * not there yet: a phone running ahead of the migration still has to be able to
 * open the Plans page.
 */
export async function mondayJobForProject(
  projectId: string,
): Promise<MondayJob | null> {
  const { data, error } = await supabase
    .from("monday_jobs")
    .select("*")
    .eq("project_id", projectId)
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "monday_jobs")) return null;
    throw error;
  }
  return (data as MondayJob | null) ?? null;
}

/**
 * Ask monday-sync to fetch the chosen files and put them on the job.
 *
 * Server-side on purpose. Monday's download link is minted per request and
 * lasts an hour, the token that mints it must never reach a browser, and only
 * the server can check that the asset really is attached to the item the office
 * tied to this job.
 */
export async function pullMondayFiles(args: {
  mondayJobId: string;
  projectId: string;
  files: { asset_id: string; kind: MondayFileKind }[];
}): Promise<{ ok: boolean; results: MondayPullResult[]; error?: string }> {
  const { data, error } = await supabase.functions.invoke("monday-sync", {
    body: {
      action: "pull_files",
      monday_job_id: args.mondayJobId,
      project_id: args.projectId,
      files: args.files,
    },
  });
  if (error) return { ok: false, results: [], error: error.message };
  const body = data as { ok?: boolean; results?: MondayPullResult[]; error?: string };
  return {
    ok: Boolean(body?.ok),
    results: Array.isArray(body?.results) ? body.results : [],
    error: body?.error,
  };
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

/**
 * Build a real project from a staged row and link the two.
 *
 * Returns the new job's id because the caller pulls the row's files onto it
 * next. The pull is deliberately NOT done here: a file that fails to come
 * across must never undo a job the office has already built, so the two are
 * separate steps with separate failures (Monday files, F3).
 */
export async function buildProjectFromMonday(
  job: MondayJob,
  input: CreateProjectInput,
): Promise<{ projectId: string }> {
  const project = await createProject(buildInputFromMonday(job, input));
  const { error } = await supabase
    .from("monday_jobs")
    .update({ project_id: project.id })
    .eq("id", job.id);
  if (error) throw error;
  return { projectId: project.id };
}

export async function dismissMondayJob(id: string): Promise<void> {
  const { error } = await supabase
    .from("monday_jobs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
