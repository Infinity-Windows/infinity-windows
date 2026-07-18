import { supabase } from "./supabase";
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

export interface CreateProjectInput {
  jobCode: string;
  name: string;
  address?: string | null;
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
      address: input.address?.trim() || null,
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
