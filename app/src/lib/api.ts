import { supabase } from "./supabase";
import type { Issue } from "./issues";
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

/**
 * Search the real install brain (the closed catalog) for a free-text query.
 * Matches on type code, name, or category so "Ask Infinity" can answer with a
 * type's seeded/learned tips, watch-outs, difficulty and median install time
 * instead of a hardcoded glossary. Provisional (job spec-extract) types are
 * excluded so answers only ever reflect real catalog products.
 */
export async function searchBrainTypes(query: string): Promise<WindowType[]> {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await supabase
    .from("window_types")
    .select("*")
    .eq("provisional", false)
    .or(`type_code.ilike.${like},name.ilike.${like},category.ilike.${like}`)
    .order("n_installs", { ascending: false })
    .limit(4);
  if (error) throw error;
  return data ?? [];
}

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
 * Create a job and its two default staging slots. The compensating delete
 * keeps a partial job out of the list if staging setup fails.
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

  const { error: stagingError } = await supabase.from("locations").insert([
    { zone: "J", rack: jobCode, slot: "A", capacity: 10 },
    { zone: "J", rack: jobCode, slot: "B", capacity: 10 },
  ]);
  if (stagingError) {
    await supabase.from("projects").delete().eq("id", project.id);
    throw stagingError;
  }

  return project as Project;
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

export async function suggestLocation(
  windowUuid: string,
): Promise<Location | null> {
  const { data, error } = await supabase.rpc("suggest_location", {
    p_window_id: windowUuid,
  });
  if (error) throw error;
  return (data as Location | null)?.id ? (data as Location) : null;
}

export interface DashboardCounts {
  total: number;
  inbound: number;
  staged: number;
  damaged: number;
}

export async function getDashboardCounts(): Promise<DashboardCounts> {
  const countWhere = (apply: (q: ReturnType<typeof base>) => ReturnType<typeof base>) =>
    apply(base());
  const base = () =>
    supabase.from("windows").select("id", { count: "exact", head: true });

  const [total, inbound, staged, damaged] = await Promise.all([
    countWhere((q) => q.not("status", "in", "(installed,loaded)")),
    countWhere((q) => q.eq("status", "inbound")),
    countWhere((q) => q.eq("status", "staged")),
    countWhere((q) => q.eq("status", "damaged")),
  ]);
  for (const r of [total, inbound, staged, damaged]) {
    if (r.error) throw r.error;
  }
  return {
    total: total.count ?? 0,
    inbound: inbound.count ?? 0,
    staged: staged.count ?? 0,
    damaged: damaged.count ?? 0,
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
