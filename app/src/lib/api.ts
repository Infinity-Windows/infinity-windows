import { supabase } from "./supabase";
import {
  isMissingStagingBayError,
  missingBayMessage,
  missingStagingBayJobCode,
  sharedShelfWarning,
  type PutawaySuggestion,
} from "./staging";
import type {
  JobMode,
  Location,
  Movement,
  Project,
  ProjectWindow,
  WindowType,
  WindowUnit,
} from "./types";
import { quickJobName, quickTrackingJobCode } from "./quickJobs";
import { isMissingColumn, isMissingFunction, isMissingTable } from "./schemaErrors";
import { sortProjectsForList, type ReadyState } from "./pipeline";

const WINDOW_SELECT =
  "*, window_types(*), locations(*), projects(*)";

async function actor(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? null;
}

export async function listWindowTypes(): Promise<WindowType[]> {
  const { data, error } = await supabase
    .from("window_types")
    .select("*")
    .order("type_code");
  if (error) throw error;
  return data;
}

// Ask Infinity used to search the catalog here, matching the whole question as
// one phrase against a type code — which is why "single hung" found nothing and
// the screen's own "Single hung tips" button came back empty. It now searches a
// bundled keyword index on the device instead (src/lib/brain), so type lookup
// needs no signal at all. See docs/ask-infinity-token-free.md.

export async function listLocations(): Promise<Location[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("*")
    .eq("active", true)
    .order("address");
  if (error) throw error;
  return data;
}

/**
 * Wave J (J2): the ONE order every jobs list reads in — the office's hand-made
 * order first (`sort_order`, nulls last), then the jobs starting soonest
 * (`start_date`, nulls last), then the name.
 *
 * It is applied in two places on purpose. The server does it, so a list is
 * already right the moment it lands; then `sortProjectsForList` does it again
 * on the rows, which is what keeps the answer identical on a phone whose
 * database does not have `sort_order` yet (the fallback below) and while an
 * optimistic reorder is on screen. The rule itself lives once, in
 * lib/pipeline.ts, and is unit-tested there.
 */
interface Orderable<T> {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): T;
}

function inPipelineOrder<T extends Orderable<T>>(query: T): T {
  return query
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("start_date", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });
}

/**
 * Wave H (H0): readiness and the two materials dates live in `project_pipeline`
 * now, not on the job row.
 *
 * They were columns on `projects` for one wave, and `projects` is the one table
 * a builder (partner) login reads WHOLE for the jobs it was granted — so "your
 * windows have not turned up" was readable by the general contractor. The side
 * table carries its own policy (crew read, never a partner), which is the only
 * shape that actually works; `project_financials` did the same for the bid.
 *
 * A partner reading a job therefore gets `project_pipeline: null` back from
 * RLS, not an error, and `flattenPipeline` turns that into a job that is Ready
 * with nothing to say — which is exactly what a builder should see.
 */
const PIPELINE_EMBED = "*, project_pipeline(ready_state, materials_eta, materials_arrived_at)";

/** The three facts, as PostgREST hands them back on the embed. */
interface PipelineSide {
  ready_state?: string | null;
  materials_eta?: string | null;
  materials_arrived_at?: string | null;
}

/**
 * Fold the embedded row up onto the job, so every screen keeps reading
 * `project.ready_state` the way it did when it was a column.
 *
 * Three cases, and the difference between the last two is the whole reason this
 * is a function rather than a spread:
 *   - the key is ABSENT — this read did not ask for the embed (a phone running
 *     ahead of the migration fell back below). The fields stay `undefined`,
 *     which lib/pipeline.ts and the Pipeline card both read as "nothing is
 *     known", and no pill or chip is drawn.
 *   - the key is NULL — the embed ran and there is no row: nobody has ever said
 *     anything about this job, so it is Ready with no dates. That is the same
 *     answer the NOT NULL DEFAULT gave while these were columns, and the only
 *     one that does not put a red flag on every job in the company.
 *   - the key is an object — the real answer.
 */
export function flattenPipeline(row: Record<string, unknown>): Project {
  const { project_pipeline: side, ...rest } = row as Record<string, unknown> & {
    project_pipeline?: PipelineSide | PipelineSide[] | null;
  };
  if (side === undefined) return rest as unknown as Project;
  // PostgREST answers a one-to-one embed with an object, but a schema cache
  // that has not noticed the primary key yet answers with an array. Both mean
  // the same thing here, and a card that silently lost its readiness because of
  // a cache warm-up is not worth the risk.
  const one = (Array.isArray(side) ? (side[0] ?? null) : side) as PipelineSide | null;
  return {
    ...(rest as unknown as Project),
    ready_state: one?.ready_state ?? "ready",
    materials_eta: one?.materials_eta ?? null,
    materials_arrived_at: one?.materials_arrived_at ?? null,
  };
}

function activeProjectRows(columns: string) {
  return supabase.from("projects").select(columns).eq("status", "active").is("deleted_at", null);
}

/** The shape both jobs-list readers hand `readProjects`, before ordering. */
type ProjectQuery = ReturnType<typeof activeProjectRows>;

function pipelineRows(rows: unknown): Project[] {
  return sortProjectsForList((rows as Record<string, unknown>[]).map(flattenPipeline));
}

/**
 * Read a jobs list in pipeline order, degrading one step at a time.
 *
 * Two independent things can be missing on a database behind the app: the
 * `project_pipeline` table (wave H) and the `sort_order` column (wave J).
 * PostgREST refuses the WHOLE read for either rather than ignoring the part it
 * cannot serve, so each one gets its own retry and the Jobs page loads on any
 * of the three shapes. A job hub that white-screens because a migration is ten
 * minutes behind a deploy is the failure this repo keeps writing guards against.
 */
async function readProjects(build: (columns: string) => ProjectQuery): Promise<Project[]> {
  const withEmbed = await inPipelineOrder(build(PIPELINE_EMBED));
  if (!withEmbed.error) return pipelineRows(withEmbed.data);

  if (isMissingTable(withEmbed.error, "project_pipeline")) {
    const plain = await inPipelineOrder(build("*"));
    if (!plain.error) return sortProjectsForList(plain.data as unknown as Project[]);
    if (isMissingColumn(plain.error, "sort_order")) {
      const fallback = await build("*").order("name");
      if (fallback.error) throw fallback.error;
      return sortProjectsForList(fallback.data as unknown as Project[]);
    }
    throw plain.error;
  }

  if (isMissingColumn(withEmbed.error, "sort_order")) {
    const fallback = await build(PIPELINE_EMBED).order("name");
    if (fallback.error) throw fallback.error;
    return pipelineRows(fallback.data);
  }

  throw withEmbed.error;
}

export async function listProjects(): Promise<Project[]> {
  return readProjects(activeProjectRows);
}

/**
 * Every job whatever its life stage (owner ask, 2026-08-26). Two callers
 * only: the job-history screen, and the warehouse's job-NAME maps — a
 * finished job's leftover conex material must keep naming its job instead
 * of decaying to "job not listed". Pickers stay on listProjects: nobody
 * tags new material to a finished job by accident.
 *
 * Wave D: the RLS predicate on `projects` already hides a trashed job from
 * every non-owner caller, so `.is("deleted_at", null)` here is belt and
 * suspenders for everyone else — but it matters for the OWNER, who is the
 * one caller RLS lets see a trashed row at all. Without this filter an
 * owner's own job-history "Finished / Cancelled" list (which reads
 * `status !== "active"`) would start showing trashed jobs mixed in with
 * cancelled ones. JobHistory.tsx's own Deleted section is the one place
 * that deliberately reads a trashed row, and it does so separately.
 */
export async function listProjectsAnyStatus(): Promise<Project[]> {
  return readProjects((columns) =>
    supabase.from("projects").select(columns).is("deleted_at", null),
  );
}

/**
 * Wave D: every job in the owner's trash, newest-deleted first. Owner-only
 * in practice — RLS hides every trashed row from anyone else, so a
 * non-owner simply gets an empty list back rather than an error.
 */
export async function listTrashedProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) throw error;
  return data;
}

// Trashing a job now lives in lib/jobDeletion.ts (deleteJob): supervisor+, with
// a required reason and an all-supervisor notice (standard-tracking-jobs slice
// 5). The reason and the push are why it moved out of this bare RPC wrapper.

/** Supervisor+. Undoes a trash within the 30-day window (server-enforced). */
export async function restoreProject(projectId: string): Promise<void> {
  const { error } = await supabase.rpc("restore_project", { p_project_id: projectId });
  if (error) throw error;
}

/**
 * The confirm dialog's real numbers (owner ask: state the cost before the
 * tap). Three cheap head-count queries — no rows, just counts — rather than
 * a dedicated RPC, since every table involved is already readable to the
 * caller under its own RLS.
 */
export interface ProjectDeleteCounts {
  openings: number;
  packages: number;
  photos: number;
}

export async function getProjectDeleteCounts(projectId: string): Promise<ProjectDeleteCounts> {
  const [openings, packages, photos] = await Promise.all([
    supabase.from("project_openings").select("id", { count: "exact", head: true }).eq("project_id", projectId),
    supabase.from("packages").select("id", { count: "exact", head: true }).eq("project_id", projectId),
    supabase.from("attachments").select("id", { count: "exact", head: true }).eq("project_id", projectId),
  ]);
  if (openings.error) throw openings.error;
  if (packages.error) throw packages.error;
  if (photos.error) throw photos.error;
  return {
    openings: openings.count ?? 0,
    packages: packages.count ?? 0,
    photos: photos.count ?? 0,
  };
}

/** Finish, cancel, or reopen a job (supervisor+). Reversible on purpose. */
export async function setProjectStatus(
  projectId: string,
  status: "active" | "completed" | "cancelled",
): Promise<void> {
  const { error } = await supabase.rpc("set_project_status", {
    p_project: projectId,
    p_status: status,
  });
  if (error) throw error;
}

/** Owner-only, empty shells only — a job with material, plans, or hours
 * refuses with a sentence pointing at complete/cancel. */
export async function deleteProject(projectId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_project", { p_project: projectId });
  if (error) throw error;
}

/** Fields captured on the Horizon-style add/edit project form. */
export interface ProjectDetailsInput {
  address?: string | null;
  customerName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  siteState?: string | null;
  unitNumber?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
}

export interface CreateProjectInput extends ProjectDetailsInput {
  jobCode: string;
  name: string;
  /** Wave J (J1): 'not_ready' for a job that arrived rather than being filled
   * in — a Monday import, a one-tap tracking job. Omitted means Ready, which
   * is the column's own default and what the full New project form sends. */
  readyState?: ReadyState;
  /** Wave J (J3): the day the windows are due, carried over from Monday's
   * `est_arrival` on import. RPC-only like readiness, so it is written after
   * the insert rather than with it. */
  materialsEta?: string | null;
}

const clean = (value: string | null | undefined): string | null =>
  value?.trim() ? value.trim() : null;

/**
 * Shape the shared detail fields into the DB column names — ONLY the ones the
 * caller actually named.
 *
 * The distinction is the whole point, and it used to be missing. This function
 * returned all nine columns every time, and `clean(undefined)` is null, so a
 * caller who passed one field was silently sending "erase the other eight".
 * The one caller at the time (the job details form) always passed all nine, so
 * nothing broke — until wave J's Pipeline card saved an expected start date on
 * its own and took the job's address, customer, phone, email and notes with it.
 *
 * So: absent means LEAVE THAT COLUMN ALONE, and an explicit null (or "") still
 * means CLEAR IT. The full form is unaffected — it names every field, so it
 * still sends every column, including the blanks a person deliberately emptied.
 * On INSERT an omitted column simply takes its default, which is NULL, so
 * createProject behaves exactly as before.
 */
function detailColumns(input: ProjectDetailsInput): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  if (input.address !== undefined) patch.address = clean(input.address);
  if (input.customerName !== undefined) patch.customer_name = clean(input.customerName);
  if (input.contactPhone !== undefined) patch.contact_phone = clean(input.contactPhone);
  if (input.contactEmail !== undefined) patch.contact_email = clean(input.contactEmail);
  if (input.siteState !== undefined) {
    patch.site_state = clean(input.siteState)?.toUpperCase() ?? null;
  }
  if (input.unitNumber !== undefined) patch.unit_number = clean(input.unitNumber);
  if (input.startDate !== undefined) patch.start_date = clean(input.startDate);
  if (input.endDate !== undefined) patch.end_date = clean(input.endDate);
  if (input.notes !== undefined) patch.notes = clean(input.notes);
  return patch;
}

/**
 * Create a job. Its two staging bays (J-<JOBCODE>-A and -B) are created by the
 * database, by an AFTER INSERT trigger on `projects`.
 *
 * This function used to insert those two rows itself, and undo the job if that
 * insert failed. Both are gone. Keeping them would have been worse than
 * redundant: the trigger has already made the bays by the time this returns, so
 * the insert could only ever collide, and the compensating delete would then
 * have deleted the job the user just created. More to the point, a rule that
 * lives in the client is a rule that only holds for jobs the client makes —
 * which is exactly how a job reached production with no bays at all. See
 * supabase/migrations/20260729220000_staging_bays_guaranteed.sql.
 */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const jobCode = input.jobCode.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "-");
  const name = input.name.trim();
  if (!jobCode) throw new Error("Job code is required.");
  if (!name) throw new Error("Project name is required.");

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({
      job_code: jobCode,
      name,
      ...detailColumns(input),
    })
    .select("*")
    .single();
  if (projectError) throw projectError;

  // Wave J (J1/J3): a job that ARRIVED rather than being filled in — imported
  // from Monday, or built in one tap from the clock-in — is born Not ready.
  // Nobody has walked that site or checked that its windows are ordered, and a
  // job that claims to be ready when nobody has said so is exactly the lie this
  // wave exists to stop. The full New project form is the opposite case: the
  // person filling it in knows, so it defaults Ready with a toggle.
  //
  // Written after the insert, not with it: ready_state and materials_eta are
  // both RPC-only under wave D's projects grant law, so a value in the INSERT
  // above would 42501. A job that is briefly Ready between the two writes never
  // matters — nothing reads it until this function returns.
  //
  // Both are wrapped so a database that does not have wave J's migration yet
  // cannot fail a create that has ALREADY happened. The job exists by this
  // point; throwing here would show the foreman an error for a job that is
  // sitting in the list behind the dialog, which is the worst of both answers.
  // It simply arrives without its readiness, and somebody sets it by hand.
  const created = project as Project;
  if (input.readyState === "not_ready") {
    try {
      await setProjectReadiness(created.id, "not_ready");
      created.ready_state = "not_ready";
    } catch (err) {
      if (!isMissingFunction(err)) throw err;
    }
  }
  if (input.materialsEta) {
    try {
      await setProjectMaterials(created.id, { eta: input.materialsEta });
      created.materials_eta = input.materialsEta;
    } catch (err) {
      if (!isMissingFunction(err)) throw err;
    }
  }

  return created;
}

/** Foreman+: mark a job Ready or Not ready. */
export async function setProjectReadiness(
  projectId: string,
  readyState: ReadyState,
): Promise<void> {
  const { error } = await supabase.rpc("set_project_readiness", {
    p_project_id: projectId,
    p_ready_state: readyState,
  });
  if (error) throw error;
}

/**
 * Foreman+: set or clear when the windows are due, and record that they came
 * (or take that back).
 *
 * Nulls mean LEAVE THAT FACT ALONE, which is why clearing the ETA is its own
 * flag rather than "send null": the one-tap Materials-arrived call has no ETA
 * to send, and a null that meant "erase" would wipe the date every time
 * somebody pressed the button.
 */
export async function setProjectMaterials(
  projectId: string,
  input: { eta?: string | null; clearEta?: boolean; arrived?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc("set_project_materials", {
    p_project_id: projectId,
    p_materials_eta: input.eta ?? null,
    p_clear_eta: input.clearEta ?? false,
    p_arrived: input.arrived ?? null,
  });
  if (error) throw error;
}

/**
 * Foreman+: write the jobs list order. The WHOLE visible list goes over, in its
 * new order, and the server writes 1..n — so the result is the same however it
 * was dragged, and a second foreman's save lands as one coherent order rather
 * than interleaving with somebody's half-finished one.
 */
export async function setProjectsOrder(projectIds: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_projects_order", { p_ids: projectIds });
  if (error) throw error;
}

/**
 * Create a Tracking-ONLY job in one tap from the clock-in (standard-tracking-
 * jobs slice 5). Foreman+ only — the CALLER is gated in the UI, the same way
 * every other create-project affordance is (projects' INSERT policy is open to
 * authenticated). Reuses createProject, then flips modes to tracking via the
 * one legal writer of allowed_modes (set_project_modes); a job briefly born
 * data-mode between the two writes never matters — nothing reads it until this
 * returns and the caller clocks into it.
 *
 * The name is auto-derived (address, else customer) when the box is left blank
 * — a callback often only has an address — and the job_code is generated with a
 * random tail so two same-named callbacks never collide. The returned row's
 * allowed_modes is set to ['tracking'] so the caller need not re-fetch to know
 * what it just made.
 */
export async function createTrackingJob(input: {
  name?: string | null;
  address?: string | null;
  customerName?: string | null;
}): Promise<Project> {
  const name = quickJobName(input);
  const jobCode = quickTrackingJobCode(name);
  const project = await createProject({
    jobCode,
    name,
    address: input.address ?? null,
    customerName: input.customerName ?? null,
    // Wave J (J1): born Not ready. A job made in one tap from the clock-in is
    // a callback or a service call somebody is standing in front of — nobody
    // has checked its windows are ordered, so it should not claim they are.
    readyState: "not_ready",
  });
  await setProjectModes(project.id, ["tracking"]);
  return { ...project, allowed_modes: ["tracking"], ready_state: "not_ready" };
}

/**
 * Foreman+ repair: give a job its two staging bays if either is missing or has
 * been retired. Idempotent — safe to press twice. Exists so that a job that
 * arrived by a merge, a restore or a hand-written INSERT can be fixed from
 * inside the app instead of by an engineer writing SQL against production.
 */
export async function ensureStagingBays(projectId: string): Promise<Location[]> {
  const { data, error } = await supabase.rpc("ensure_project_staging_bays", {
    p_project_id: projectId,
  });
  if (error) throw error;
  return (data ?? []) as Location[];
}

export interface UpdateProjectInput extends ProjectDetailsInput {
  name?: string;
}

/**
 * Edit an existing job's Horizon-style details (foreman+ from the hub).
 *
 * PARTIAL: only the fields named in `input` are written. A caller that wants
 * one date changed sends one date and every other column is left exactly as it
 * was; a caller that wants a field emptied sends null (or "") for it. See
 * detailColumns above for the bug that rule exists to stop.
 *
 * Status is NOT accepted here: projects.status is column-locked (wave D's
 * grant restructure) and changes only through set_project_status().
 */
export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const patch: Record<string, string | null> = detailColumns(input);
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required.");
    patch.name = name;
  }
  // An update naming no columns at all is a caller bug, and PostgREST would
  // answer it with a 400 nobody could act on. Say what happened instead.
  if (Object.keys(patch).length === 0) throw new Error("Nothing to save on this job.");

  const { data, error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Project;
}

/**
 * Flag or unflag a job as fake practice/QA data. Supervisor+ — the database
 * checks this too and refuses below that rank. The only legal way to change
 * `projects.is_test`: writing the column directly is revoked from every
 * client role (20260933000000_testing_projects.sql).
 */
export async function setProjectTest(
  projectId: string,
  isTest: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_project_test", {
    p_project: projectId,
    p_is_test: isTest,
  });
  if (error) throw error;
}

/**
 * Set which work modes a job allows — a non-empty subset of {data,tracking}
 * (standard-tracking-jobs slice 2). Foreman+, checked server-side. The only
 * legal way to change projects.allowed_modes: writing the column directly is
 * revoked from every client role (20260970000000_job_modes.sql).
 */
export async function setProjectModes(
  projectId: string,
  modes: JobMode[],
): Promise<void> {
  const { error } = await supabase.rpc("set_project_modes", {
    p_project_id: projectId,
    p_modes: modes,
  });
  if (error) throw error;
}

/**
 * Permanently deletes a job — owner-only, and only when it is already
 * flagged as a testing project. There is no undo; the confirm dialog on the
 * button that calls this is the only safety net.
 */
export async function deleteTestProject(projectId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_test_project", {
    p_project: projectId,
  });
  if (error) throw error;
}

export async function getProjectWindows(
  projectId: string,
): Promise<ProjectWindow[]> {
  const { data, error } = await supabase
    .from("project_windows")
    .select("*, window_types(*)")
    .eq("project_id", projectId);
  if (error) throw error;
  return data;
}


export async function getWindowByWindowId(
  windowId: string,
): Promise<WindowUnit | null> {
  const { data, error } = await supabase
    .from("windows")
    .select(WINDOW_SELECT)
    .eq("window_id", windowId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function findWindowBySerial(
  serial: string,
): Promise<WindowUnit | null> {
  const { data, error } = await supabase
    .from("windows")
    .select(WINDOW_SELECT)
    .eq("serial", serial.trim())
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Edit a window's friendly display name (foreman+ via the trusted-crew RLS). */
export async function updateWindow(
  id: string,
  patch: { display_name?: string | null },
): Promise<WindowUnit> {
  const update: Record<string, string | null> = {};
  if (patch.display_name !== undefined) {
    update.display_name = patch.display_name?.trim() ? patch.display_name.trim() : null;
  }
  const { data, error } = await supabase
    .from("windows")
    .update(update)
    .eq("id", id)
    .select(WINDOW_SELECT)
    .single();
  if (error) throw error;
  return data as WindowUnit;
}

export async function findWindowByCode(
  code: string,
): Promise<WindowUnit | null> {
  const { data, error } = await supabase.rpc("find_window_by_code", {
    p_code: code,
  });
  if (error) throw error;
  // The RPC returns SETOF windows: Supabase may hand back an array or a single
  // row object depending on how it's typed. Normalize both to one unit or null.
  const row = Array.isArray(data) ? data[0] : data;
  return (row as WindowUnit | undefined) ?? null;
}

export async function getLocationByAddress(
  address: string,
): Promise<Location | null> {
  const { data, error } = await supabase
    .from("locations")
    .select("*")
    .eq("address", address)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getLocationBySerial(
  serial: string,
): Promise<Location | null> {
  const { data, error } = await supabase
    .from("locations")
    .select("*")
    .eq("serial", serial.trim())
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Edit a slot's address and/or friendly display name (foreman+ via the
 * trusted-crew RLS). `address` is a GENERATED column (zone-rack-slot), so we
 * parse ZONE-RACK-SLOT and update the underlying parts; the address then
 * regenerates. The permanent serial is never touched, so printed QRs keep
 * scanning even after a rename.
 */
export async function updateLocation(
  id: string,
  patch: { address?: string; display_name?: string | null },
): Promise<Location> {
  const update: Record<string, string | null> = {};
  if (patch.display_name !== undefined) {
    update.display_name = patch.display_name?.trim() ? patch.display_name.trim() : null;
  }
  if (patch.address !== undefined) {
    const parts = patch.address.trim().toUpperCase().split("-").filter(Boolean);
    if (parts.length < 3) {
      throw new Error("Address must look like ZONE-RACK-SLOT, e.g. S-03-B.");
    }
    const zone = parts[0];
    if (!["R", "J", "S", "D"].includes(zone)) {
      throw new Error(`Zone must be R, J, S or D (got "${zone}").`);
    }
    update.zone = zone;
    update.slot = parts[parts.length - 1];
    update.rack = parts.slice(1, -1).join("-");
  }
  const { data, error } = await supabase
    .from("locations")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Location;
}

/**
 * Retire a slot. Locations are soft-deleted (active = false) rather than hard
 * deleted: movements/cycle-count history and any windows still sitting in the
 * slot reference the row, so a hard delete would either break history or be
 * blocked by foreign keys. `listLocations` already only returns active slots,
 * so flipping the flag makes the slot disappear from every picker and label
 * list while keeping the audit trail intact. Foreman+ via the same trusted-crew
 * RLS that guards `updateLocation`.
 */
export async function deleteLocation(id: string): Promise<void> {
  const { error } = await supabase
    .from("locations")
    .update({ active: false })
    .eq("id", id);
  if (error) throw error;
}

/** Retire several slots in one round-trip (bulk "delete selected"). */
export async function deleteLocations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("locations")
    .update({ active: false })
    .in("id", ids);
  if (error) throw error;
}


export async function searchUnits(query: string): Promise<WindowUnit[]> {
  const q = query.trim();
  if (!q) return [];
  const { data: types, error: typeError } = await supabase
    .from("window_types")
    .select("id")
    .or(`type_code.ilike.%${q}%,name.ilike.%${q}%`);
  if (typeError) throw typeError;
  const typeIds = types.map((t) => t.id);

  let request = supabase.from("windows").select(WINDOW_SELECT).limit(100);
  if (typeIds.length > 0) {
    request = request.or(
      `window_id.ilike.%${q}%,window_type_id.in.(${typeIds.join(",")})`,
    );
  } else {
    request = request.ilike("window_id", `%${q}%`);
  }
  const { data, error } = await request.order("window_id");
  if (error) throw error;
  return data;
}

export async function getMovements(windowUuid: string): Promise<Movement[]> {
  const { data, error } = await supabase
    .from("movements")
    .select("*")
    .eq("window_id", windowUuid)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

export async function receiveWindow(
  typeId: string,
  projectId: string | null,
): Promise<WindowUnit> {
  const { data, error } = await supabase.rpc("receive_window", {
    p_type_id: typeId,
    p_project_id: projectId,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as WindowUnit;
}




export async function moveWindow(
  windowUuid: string,
  locationId: string,
  reason?: string,
): Promise<WindowUnit> {
  const { data, error } = await supabase.rpc("move_window", {
    p_window_id: windowUuid,
    p_location_id: locationId,
    p_actor: await actor(),
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return data as WindowUnit;
}



export interface UnloadResult {
  unloaded: number;
  damaged: number;
}


export interface ReorderNeed {
  window_type_id: string;
  type_name: string;
  missing_count: number;
  damaged_count: number;
}

/**
 * Per-type reorder rollup for a project: damaged units + still-missing
 * deliveries, so foreman+/office can reorder fast. Foreman+ (enforced by the
 * RPC).
 */
export async function listReorderNeeds(
  projectId: string,
): Promise<ReorderNeed[]> {
  const { data, error } = await supabase.rpc("list_reorder_needs", {
    p_project_id: projectId,
  });
  if (error) throw error;
  return (data ?? []) as ReorderNeed[];
}


/**
 * Where to put a unit away — and, just as importantly, whether that answer is
 * the job's own staging bay or a shared shelf.
 *
 * `projectId` is the unit's job (null for unassigned stock). It is what decides
 * whether a stock-zone answer is normal or is something the foreman has to be
 * told about; see app/src/lib/staging.ts. The database refuses outright when
 * the job has no bay at all, and that refusal is turned into a `missingBay`
 * suggestion here rather than thrown, so callers show the reason instead of
 * silently rendering nothing.
 */
export async function suggestLocation(
  windowUuid: string,
  projectId: string | null = null,
): Promise<PutawaySuggestion> {
  const { data, error } = await supabase.rpc("suggest_location", {
    p_window_id: windowUuid,
  });
  if (error) {
    if (isMissingStagingBayError(error)) {
      const jobCode = missingStagingBayJobCode(error);
      return {
        location: null,
        warning: missingBayMessage(jobCode),
        missingBay: true,
        jobCode,
      };
    }
    throw error;
  }
  const location = (data as Location | null)?.id ? (data as Location) : null;
  return {
    location,
    warning: sharedShelfWarning(Boolean(projectId), location),
    missingBay: false,
    jobCode: null,
  };
}





export interface CatalogImportResult {
  inserted: number;
  updated: number;
  total: number;
}

/** Upsert catalog rows by type_code. Existing types keep synthesized tip columns. */
export async function importWindowTypes(
  rows: import("./catalogCsv").CatalogCsvRow[],
): Promise<CatalogImportResult> {
  if (rows.length === 0) return { inserted: 0, updated: 0, total: 0 };

  const codes = rows.map((r) => r.type_code);
  const { data: existing, error: exErr } = await supabase
    .from("window_types")
    .select("type_code")
    .in("type_code", codes);
  if (exErr) throw exErr;
  const existingCodes = new Set((existing ?? []).map((r) => r.type_code));

  const { error } = await supabase.from("window_types").upsert(
    rows.map((r) => ({
      type_code: r.type_code,
      name: r.name,
      category: r.category,
      width_in: r.width_in,
      height_in: r.height_in,
      difficulty_rating: r.difficulty_rating,
      tutorial_url: r.tutorial_url,
      notes: r.notes,
    })),
    { onConflict: "type_code" },
  );
  if (error) throw error;

  const updated = rows.filter((r) => existingCodes.has(r.type_code)).length;
  return {
    inserted: rows.length - updated,
    updated,
    total: rows.length,
  };
}
