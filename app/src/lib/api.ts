import { supabase } from "./supabase";
import type { Issue } from "./issues";
import { NOT_IN_INVENTORY } from "./inventoryViews";
import {
  isMissingStagingBayError,
  missingBayMessage,
  missingStagingBayJobCode,
  sharedShelfWarning,
  type PutawaySuggestion,
} from "./staging";
import type {
  Location,
  Movement,
  Project,
  ProjectWindow,
  WindowType,
  WindowUnit,
} from "./types";

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
    .order("name");
  if (error) throw error;
  return data;
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
}

const clean = (value: string | null | undefined): string | null =>
  value?.trim() ? value.trim() : null;

/** Shape the shared detail fields into the DB column names. */
function detailColumns(input: ProjectDetailsInput): Record<string, string | null> {
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
  };
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

  return project as Project;
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
  status?: Project["status"];
}

/** Edit an existing job's Horizon-style details (foreman+ from the hub). */
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
  if (input.status !== undefined) patch.status = input.status;

  const { data, error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Project;
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

export async function getProjectUnits(
  projectId: string,
): Promise<WindowUnit[]> {
  const { data, error } = await supabase
    .from("windows")
    .select(WINDOW_SELECT)
    .eq("project_id", projectId)
    .order("window_id");
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

export async function getUnitsAtLocation(
  locationId: string,
): Promise<WindowUnit[]> {
  const { data, error } = await supabase
    .from("windows")
    .select(WINDOW_SELECT)
    .eq("location_id", locationId)
    .order("window_id");
  if (error) throw error;
  return data;
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

/**
 * Pre-issue physical-unit records for a project from its planned quantities.
 * Creates one `pre_issued` window (serial + short_code + QR) per still-missing
 * planned unit and returns the newly created rows. Idempotent server-side:
 * re-running never exceeds the plan. Foreman+ only (enforced by the RPC).
 */
export async function preissueProjectUnits(
  projectId: string,
): Promise<WindowUnit[]> {
  const { data, error } = await supabase.rpc("preissue_project_units", {
    p_project_id: projectId,
  });
  if (error) throw error;
  return (data ?? []) as WindowUnit[];
}

/**
 * Receive a physical unit against the plan: match a scanned/typed code to its
 * pre_issued ID and activate it (-> in_warehouse, or damaged + a damage issue
 * when `damaged`). Optionally drop it straight into a storage location.
 * Foreman+ only (enforced by the RPC). Returns the activated unit.
 */
export async function activatePreissuedUnit(
  code: string,
  locationId?: string | null,
  damaged = false,
): Promise<WindowUnit> {
  const { data, error } = await supabase.rpc("activate_preissued_unit", {
    p_code: code,
    p_location_id: locationId ?? null,
    p_damaged: damaged,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as WindowUnit;
}

/**
 * Foreman-triggered delivery reconcile: flag every still-pre_issued unit for a
 * project as a 'missing' issue (deduped per unit). Returns the issues opened.
 * Foreman+ only (enforced by the RPC).
 */
export async function reconcileProjectDeliveries(
  projectId: string,
): Promise<Issue[]> {
  const { data, error } = await supabase.rpc("reconcile_project_deliveries", {
    p_project_id: projectId,
  });
  if (error) throw error;
  return (data ?? []) as Issue[];
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

export async function loadWindow(windowUuid: string): Promise<WindowUnit> {
  const { data, error } = await supabase.rpc("load_window", {
    p_window_id: windowUuid,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as WindowUnit;
}

/**
 * Batch load-out: put a set of the project's in-warehouse/staged units on the
 * truck ('loaded'). Ineligible ids (wrong job / already loaded) are skipped
 * server-side; returns only the units actually loaded. Foreman+ (enforced by
 * the RPC).
 */
export async function loadUnits(
  windowIds: string[],
  projectId: string,
): Promise<WindowUnit[]> {
  const { data, error } = await supabase.rpc("load_units", {
    p_window_ids: windowIds,
    p_project_id: projectId,
    p_actor: await actor(),
  });
  if (error) throw error;
  return (data ?? []) as WindowUnit[];
}

export interface UnloadResult {
  unloaded: number;
  damaged: number;
}

/**
 * Jobsite unload + condition report: OK units go 'on_site' (ready to
 * install); damaged units go on hold + open a deduped damage issue. Optional
 * location note is folded into the movement log. Returns { unloaded, damaged }
 * counts. Foreman+ (enforced by the RPC).
 */
export async function unloadUnits(
  okIds: string[],
  damagedIds: string[],
  projectId: string,
  locationNote?: string | null,
): Promise<UnloadResult> {
  const { data, error } = await supabase.rpc("unload_units", {
    p_ok_ids: okIds,
    p_damaged_ids: damagedIds,
    p_project_id: projectId,
    p_location_note: locationNote ?? null,
    p_actor: await actor(),
  });
  if (error) throw error;
  return (data ?? { unloaded: 0, damaged: 0 }) as UnloadResult;
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

export async function installWindow(windowUuid: string): Promise<WindowUnit> {
  const { data, error } = await supabase.rpc("install_window", {
    p_window_id: windowUuid,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as WindowUnit;
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

export interface InventorySnapshot {
  /** Every unit still in the warehouse's care, newest slot order applied later. */
  units: WindowUnit[];
  /** Server-side row count for the same filter, used only to detect a cut-off. */
  serverTotal: number;
  /** True when there are more units than we fetched (see INVENTORY_LIMIT). */
  truncated: boolean;
}

/**
 * PostgREST caps a response anyway; asking explicitly lets us notice when the
 * warehouse has outgrown a single page and say so instead of quietly showing a
 * count that no longer matches its list.
 */
const INVENTORY_LIMIT = 1000;

/**
 * One read of the whole inventory scope. The hub's four numbers and the four
 * lists behind them are all derived from this single result (see
 * lib/inventoryViews), so a number can never disagree with the list it opens.
 */
export async function listInventory(): Promise<InventorySnapshot> {
  const { data, error, count } = await supabase
    .from("windows")
    .select(WINDOW_SELECT, { count: "exact" })
    .not("status", "in", `(${NOT_IN_INVENTORY.join(",")})`)
    .order("window_id")
    .limit(INVENTORY_LIMIT);
  if (error) throw error;
  const units = (data ?? []) as WindowUnit[];
  return {
    units,
    serverTotal: count ?? units.length,
    truncated: (count ?? units.length) > units.length,
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
