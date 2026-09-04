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
import { isMissingColumn, isMissingTable } from "./schemaErrors";
import type { ScopeCounts } from "./scope";

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

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name");
  if (error) throw error;
  return data;
}

/** The columns of project_scope_counts, named rather than `*` — house rule. */
const SCOPE_COUNT_COLS =
  "project_id, openings, installed, windows, doors, door_sliders, door_french, door_bifold, door_swing, door_other, unknown_units";

/** A job with no openings at all still has a row to show: all zeroes. */
function emptyScope(projectId: string): ScopeCounts {
  return {
    project_id: projectId,
    openings: 0,
    installed: 0,
    windows: 0,
    doors: 0,
    door_sliders: 0,
    door_french: 0,
    door_bifold: 0,
    door_swing: 0,
    door_other: 0,
    unknown_units: 0,
  };
}

/**
 * How many openings, windows and doors every job has — counted in the database
 * (wave X, `project_scope_counts`), one grouped row per job.
 *
 * This REPLACES pulling every opening row on the company down to the phone and
 * counting them in JavaScript, which is what the jobs list used to do. The view
 * is SECURITY INVOKER, so a job the reader cannot see cannot appear here.
 *
 * A database without the view yet falls back to that old whole-table read, so a
 * phone ahead of the migration still shows its openings and its progress bar.
 * That fallback exists only for the gap between this shipping and the migration
 * deploying — once the view is live everywhere it can go, and nothing else
 * reads openings that way any more.
 */
export async function listScopeCounts(): Promise<Map<string, ScopeCounts>> {
  const { data, error } = await supabase
    .from("project_scope_counts")
    .select(SCOPE_COUNT_COLS);
  if (error) {
    if (isMissingTable(error, "project_scope_counts")) return legacyOpeningCounts();
    throw error;
  }
  return new Map((data as ScopeCounts[]).map((row) => [row.project_id, row]));
}

/** One job's counts. Absent (a job with nothing on it) reads as all zeroes. */
export async function getScopeCounts(projectId: string): Promise<ScopeCounts> {
  const { data, error } = await supabase
    .from("project_scope_counts")
    .select(SCOPE_COUNT_COLS)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "project_scope_counts")) {
      return (await legacyOpeningCounts()).get(projectId) ?? emptyScope(projectId);
    }
    throw error;
  }
  return (data as ScopeCounts | null) ?? emptyScope(projectId);
}

/**
 * The pre-view read: every opening row, counted here. Kept ONLY as the degrade
 * path above — openings and installed, no kinds, which is exactly what the app
 * knew before the counts view existed.
 */
async function legacyOpeningCounts(): Promise<Map<string, ScopeCounts>> {
  const { data, error } = await supabase
    .from("project_openings")
    .select("project_id, status");
  if (error) throw error;
  const byProject = new Map<string, ScopeCounts>();
  for (const row of (data ?? []) as { project_id: string; status: string }[]) {
    const counts = byProject.get(row.project_id) ?? emptyScope(row.project_id);
    counts.openings += 1;
    if (row.status === "installed") counts.installed += 1;
    byProject.set(row.project_id, counts);
  }
  return byProject;
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
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .is("deleted_at", null)
    .order("name");
  if (error) throw error;
  return data;
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
  /** Wave X: how many storeys the building has, typed by a person. A traced 3D
   * model beats it for display and never writes back into it (lib/scope.ts). */
  stories?: number | null;
}

export interface CreateProjectInput extends ProjectDetailsInput {
  jobCode: string;
  name: string;
}

const clean = (value: string | null | undefined): string | null =>
  value?.trim() ? value.trim() : null;

/** A storey count the database will accept, or null. Matches the CHECK. */
const cleanStories = (value: number | null | undefined): number | null => {
  if (value == null || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= 1 && n <= 60 ? n : null;
};

type DetailColumns = Record<string, string | number | null>;

/** Shape the shared detail fields into the DB column names. */
function detailColumns(input: ProjectDetailsInput): DetailColumns {
  return {
    address: clean(input.address),
    customer_name: clean(input.customerName),
    contact_phone: clean(input.contactPhone),
    contact_email: clean(input.contactEmail),
    site_state: clean(input.siteState)?.toUpperCase() ?? null,
    unit_number: clean(input.unitNumber),
    start_date: clean(input.startDate),
    end_date: clean(input.endDate),
    notes: clean(input.notes),
    stories: cleanStories(input.stories),
  };
}

/**
 * `projects.stories` arrives with 20260980000000, and creating or editing a job
 * has to keep working on a database that has not had it yet — otherwise the app
 * ships a New-project form nobody can submit. Drop the one column and try
 * again; every other field the person typed still lands.
 */
function withoutStories(patch: DetailColumns): DetailColumns {
  const copy = { ...patch };
  delete copy.stories;
  return copy;
}

function isMissingStoriesColumn(error: unknown): boolean {
  return isMissingColumn(error, "stories");
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

  const insert = (cols: DetailColumns) =>
    supabase
      .from("projects")
      .insert({ job_code: jobCode, name, ...cols })
      .select("*")
      .single();

  const cols = detailColumns(input);
  let { data: project, error: projectError } = await insert(cols);
  if (projectError && isMissingStoriesColumn(projectError)) {
    ({ data: project, error: projectError } = await insert(withoutStories(cols)));
  }
  if (projectError) throw projectError;

  return project as Project;
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
  });
  await setProjectModes(project.id, ["tracking"]);
  return { ...project, allowed_modes: ["tracking"] };
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

/** Edit an existing job's Horizon-style details (foreman+ from the hub).
 * Status is NOT accepted here: projects.status is column-locked (wave D's
 * grant restructure) and changes only through set_project_status(). */
export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const patch: DetailColumns = detailColumns(input);
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required.");
    patch.name = name;
  }

  const update = (cols: DetailColumns) =>
    supabase.from("projects").update(cols).eq("id", projectId).select("*").single();

  let { data, error } = await update(patch);
  if (error && isMissingStoriesColumn(error)) {
    ({ data, error } = await update(withoutStories(patch)));
  }
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
