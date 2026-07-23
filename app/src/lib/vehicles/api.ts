// Data layer for the Vehicles & Machinery fleet. Remote-first (Supabase) with a
// graceful browser-local fallback: when the additive migration hasn't been
// applied yet the table lookups fail with a "missing table" error and every
// call transparently falls back to a localStorage store — mirroring the
// scheduling + plan-outline pattern — so the fleet is usable pre-migration and
// nothing crashes.

import { supabase } from "../supabase";
import { listProjects } from "../api";
import type { Project } from "../types";
import { normalizeDrivers } from "./drivers";
import type {
  ManualLocationInput,
  ServiceRecordInput,
  Vehicle,
  VehicleDriver,
  VehicleFinancials,
  VehicleInput,
  VehicleLocation,
  VehicleProjectAssignment,
  VehicleServiceRecord,
  VehicleWithMeta,
} from "./types";

const LOCAL_KEY = "infinity.vehicles.v1";

/** Missing-table / missing-column errors mean the migration isn't applied. */
function isMissingVehicleTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "PGRST205" || e.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("vehicle") ||
    (msg.includes("does not exist") && msg.includes("relation"))
  );
}

function nowISO(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Math.random().toString(36).slice(2)}`;
}

function primaryProfileId(drivers: VehicleDriver[]): string | null {
  const primary = drivers.find((d) => d.relation === "primary");
  return primary?.profile_id ?? null;
}

// --- Local fallback store ---------------------------------------------------

interface LocalDB {
  vehicles: Vehicle[];
  drivers: (VehicleDriver & { id: string; vehicle_id: string })[];
  locations: VehicleLocation[];
  history: (VehicleLocation & { id: string })[];
  service: VehicleServiceRecord[];
  financials: VehicleFinancials[];
  assignments: VehicleProjectAssignment[];
}

function emptyDB(): LocalDB {
  return {
    vehicles: [],
    drivers: [],
    locations: [],
    history: [],
    service: [],
    financials: [],
    assignments: [],
  };
}

function readDB(): LocalDB {
  if (typeof localStorage === "undefined") return emptyDB();
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return emptyDB();
    return { ...emptyDB(), ...(JSON.parse(raw) as Partial<LocalDB>) } as LocalDB;
  } catch {
    return emptyDB();
  }
}

function writeDB(db: LocalDB): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(db));
  } catch {
    /* quota — in-memory view for this session still works */
  }
}

function localWithMeta(db: LocalDB, v: Vehicle): VehicleWithMeta {
  const assignments = db.assignments
    .filter((a) => a.vehicle_id === v.id)
    .sort((a, b) => b.assigned_at.localeCompare(a.assigned_at));
  return {
    ...v,
    drivers: db.drivers.filter((d) => d.vehicle_id === v.id),
    location: db.locations.find((l) => l.vehicle_id === v.id) ?? null,
    assignment: assignments[0] ?? null,
  };
}

const localStore = {
  list(): VehicleWithMeta[] {
    const db = readDB();
    return db.vehicles.map((v) => localWithMeta(db, v));
  },
  get(id: string): VehicleWithMeta | null {
    const db = readDB();
    const v = db.vehicles.find((x) => x.id === id);
    return v ? localWithMeta(db, v) : null;
  },
  create(input: VehicleInput): Vehicle {
    const db = readDB();
    const drivers = normalizeDrivers(input.drivers);
    const vehicle: Vehicle = {
      id: newId(),
      kind: input.kind,
      trailer_subtype: input.kind === "trailer" ? input.trailer_subtype : null,
      year: input.year,
      make: input.make,
      model: input.model,
      color: input.color,
      vin: input.vin,
      plate: input.plate,
      odometer: input.odometer,
      engine_hours: input.engine_hours,
      last_service_date: input.last_service_date,
      next_service_date: input.next_service_date,
      status: input.status,
      primary_driver_id: primaryProfileId(drivers),
      notes: input.notes,
      created_by: null,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    db.vehicles.push(vehicle);
    for (const d of drivers) {
      db.drivers.push({ ...d, id: newId(), vehicle_id: vehicle.id });
    }
    writeDB(db);
    return vehicle;
  },
  update(id: string, input: VehicleInput): Vehicle {
    const db = readDB();
    const idx = db.vehicles.findIndex((v) => v.id === id);
    if (idx < 0) throw new Error("Vehicle not found");
    const drivers = normalizeDrivers(input.drivers);
    const next: Vehicle = {
      ...db.vehicles[idx],
      kind: input.kind,
      trailer_subtype: input.kind === "trailer" ? input.trailer_subtype : null,
      year: input.year,
      make: input.make,
      model: input.model,
      color: input.color,
      vin: input.vin,
      plate: input.plate,
      odometer: input.odometer,
      engine_hours: input.engine_hours,
      last_service_date: input.last_service_date,
      next_service_date: input.next_service_date,
      status: input.status,
      primary_driver_id: primaryProfileId(drivers),
      notes: input.notes,
      updated_at: nowISO(),
    };
    db.vehicles[idx] = next;
    db.drivers = db.drivers.filter((d) => d.vehicle_id !== id);
    for (const d of drivers) db.drivers.push({ ...d, id: newId(), vehicle_id: id });
    writeDB(db);
    return next;
  },
  remove(id: string): void {
    const db = readDB();
    db.vehicles = db.vehicles.filter((v) => v.id !== id);
    db.drivers = db.drivers.filter((d) => d.vehicle_id !== id);
    db.locations = db.locations.filter((l) => l.vehicle_id !== id);
    db.history = db.history.filter((h) => h.vehicle_id !== id);
    db.service = db.service.filter((s) => s.vehicle_id !== id);
    db.financials = db.financials.filter((f) => f.vehicle_id !== id);
    db.assignments = db.assignments.filter((a) => a.vehicle_id !== id);
    writeDB(db);
  },
  updateLocation(vehicleId: string, input: ManualLocationInput): VehicleLocation {
    const db = readDB();
    const loc: VehicleLocation = {
      vehicle_id: vehicleId,
      lat: input.lat,
      lng: input.lng,
      speed_mph: input.speed_mph ?? null,
      heading_deg: input.heading_deg ?? null,
      battery_pct: null,
      ignition_on: null,
      recorded_at: nowISO(),
      source: "manual",
    };
    db.locations = db.locations.filter((l) => l.vehicle_id !== vehicleId);
    db.locations.push(loc);
    db.history.push({ ...loc, id: newId() });
    writeDB(db);
    return loc;
  },
  listService(vehicleId: string): VehicleServiceRecord[] {
    return readDB()
      .service.filter((s) => s.vehicle_id === vehicleId)
      .sort((a, b) => b.performed_at.localeCompare(a.performed_at));
  },
  addService(vehicleId: string, input: ServiceRecordInput): VehicleServiceRecord {
    const db = readDB();
    const rec: VehicleServiceRecord = {
      id: newId(),
      vehicle_id: vehicleId,
      performed_at: input.performed_at,
      odometer: input.odometer,
      engine_hours: input.engine_hours,
      category: input.category,
      description: input.description,
      cost: input.cost,
      vendor: input.vendor,
      created_at: nowISO(),
    };
    db.service.push(rec);
    // Advance the vehicle's last-service date so reminders recompute.
    const v = db.vehicles.find((x) => x.id === vehicleId);
    if (v) v.last_service_date = input.performed_at;
    writeDB(db);
    return rec;
  },
  removeService(id: string): void {
    const db = readDB();
    db.service = db.service.filter((s) => s.id !== id);
    writeDB(db);
  },
  getFinancials(vehicleId: string): VehicleFinancials | null {
    return readDB().financials.find((f) => f.vehicle_id === vehicleId) ?? null;
  },
  saveFinancials(vehicleId: string, input: Omit<VehicleFinancials, "vehicle_id">): VehicleFinancials {
    const db = readDB();
    const row: VehicleFinancials = { ...input, vehicle_id: vehicleId, updated_at: nowISO() };
    db.financials = db.financials.filter((f) => f.vehicle_id !== vehicleId);
    db.financials.push(row);
    writeDB(db);
    return row;
  },
  assign(vehicleId: string, projectId: string, note: string | null): VehicleProjectAssignment {
    const db = readDB();
    const row: VehicleProjectAssignment = {
      id: newId(),
      vehicle_id: vehicleId,
      project_id: projectId,
      assigned_at: nowISO(),
      note,
      project: null,
    };
    db.assignments.push(row);
    writeDB(db);
    return row;
  },
  unassign(vehicleId: string): void {
    const db = readDB();
    db.assignments = db.assignments.filter((a) => a.vehicle_id !== vehicleId);
    writeDB(db);
  },
};

// --- Row mapping (remote) ---------------------------------------------------

type EmbeddedProfile = { display_name?: string | null } | null;
interface RawDriverRow {
  id: string;
  profile_id: string | null;
  name: string | null;
  relation: string;
  profiles?: EmbeddedProfile;
}
interface RawAssignmentRow {
  id: string;
  vehicle_id: string;
  project_id: string;
  assigned_at: string;
  note: string | null;
  projects?: { id: string; job_code: string; name: string; address: string | null } | null;
}
interface RawVehicleRow extends Vehicle {
  vehicle_drivers?: RawDriverRow[] | null;
  vehicle_locations_latest?: VehicleLocation[] | VehicleLocation | null;
  vehicle_project_assignments?: RawAssignmentRow[] | null;
}

function mapDriver(row: RawDriverRow): VehicleDriver {
  return {
    id: row.id,
    profile_id: row.profile_id,
    name: row.name,
    relation: row.relation === "primary" ? "primary" : "insured",
    display_name: row.profiles?.display_name ?? null,
  };
}

function mapAssignment(row: RawAssignmentRow): VehicleProjectAssignment {
  return {
    id: row.id,
    vehicle_id: row.vehicle_id,
    project_id: row.project_id,
    assigned_at: row.assigned_at,
    note: row.note,
    project: row.projects ?? null,
  };
}

function mapVehicle(row: RawVehicleRow): VehicleWithMeta {
  const latest = row.vehicle_locations_latest;
  const location = Array.isArray(latest) ? (latest[0] ?? null) : (latest ?? null);
  const assignments = (row.vehicle_project_assignments ?? [])
    .map(mapAssignment)
    .sort((a, b) => b.assigned_at.localeCompare(a.assigned_at));
  return {
    ...(row as Vehicle),
    drivers: (row.vehicle_drivers ?? []).map(mapDriver),
    location,
    assignment: assignments[0] ?? null,
  };
}

const VEHICLE_SELECT =
  "*, vehicle_drivers(id, profile_id, name, relation, profiles(display_name)), " +
  "vehicle_locations_latest(*), " +
  "vehicle_project_assignments(id, vehicle_id, project_id, assigned_at, note, projects(id, job_code, name, address))";

function vehicleColumns(input: VehicleInput, drivers: VehicleDriver[]) {
  return {
    kind: input.kind,
    trailer_subtype: input.kind === "trailer" ? input.trailer_subtype : null,
    year: input.year,
    make: input.make,
    model: input.model,
    color: input.color,
    vin: input.vin,
    plate: input.plate,
    odometer: input.odometer,
    engine_hours: input.engine_hours,
    last_service_date: input.last_service_date,
    next_service_date: input.next_service_date,
    status: input.status,
    primary_driver_id: primaryProfileId(drivers),
    notes: input.notes,
  };
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

async function replaceDrivers(vehicleId: string, drivers: VehicleDriver[]): Promise<void> {
  await supabase.from("vehicle_drivers").delete().eq("vehicle_id", vehicleId);
  if (drivers.length === 0) return;
  const { error } = await supabase.from("vehicle_drivers").insert(
    drivers.map((d) => ({
      vehicle_id: vehicleId,
      profile_id: d.profile_id,
      name: d.profile_id ? null : d.name,
      relation: d.relation,
    })),
  );
  if (error) throw error;
}

// --- Public API -------------------------------------------------------------

export async function listVehicles(): Promise<VehicleWithMeta[]> {
  const { data, error } = await supabase
    .from("vehicles")
    .select(VEHICLE_SELECT)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.list();
    throw error;
  }
  return ((data ?? []) as unknown as RawVehicleRow[]).map(mapVehicle);
}

export async function getVehicle(id: string): Promise<VehicleWithMeta | null> {
  const { data, error } = await supabase
    .from("vehicles")
    .select(VEHICLE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.get(id);
    throw error;
  }
  return data ? mapVehicle(data as unknown as RawVehicleRow) : null;
}

export async function createVehicle(input: VehicleInput): Promise<Vehicle> {
  const drivers = normalizeDrivers(input.drivers);
  const { data, error } = await supabase
    .from("vehicles")
    .insert({ ...vehicleColumns(input, drivers), created_by: await currentUserId() })
    .select("id")
    .single();
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.create(input);
    throw error;
  }
  const id = (data as { id: string }).id;
  await replaceDrivers(id, drivers);
  const row = await getVehicle(id);
  return row as Vehicle;
}

export async function updateVehicle(id: string, input: VehicleInput): Promise<Vehicle> {
  const drivers = normalizeDrivers(input.drivers);
  const { error } = await supabase
    .from("vehicles")
    .update({ ...vehicleColumns(input, drivers), updated_at: nowISO() })
    .eq("id", id);
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.update(id, input);
    throw error;
  }
  await replaceDrivers(id, drivers);
  const row = await getVehicle(id);
  return row as Vehicle;
}

export async function deleteVehicle(id: string): Promise<void> {
  const { error } = await supabase.from("vehicles").delete().eq("id", id);
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.remove(id);
    throw error;
  }
}

export async function updateVehicleLocation(
  vehicleId: string,
  input: ManualLocationInput,
): Promise<VehicleLocation> {
  const payload = {
    vehicle_id: vehicleId,
    lat: input.lat,
    lng: input.lng,
    speed_mph: input.speed_mph ?? null,
    heading_deg: input.heading_deg ?? null,
    recorded_at: nowISO(),
    source: "manual",
  };
  const { error } = await supabase
    .from("vehicle_locations_latest")
    .upsert(payload, { onConflict: "vehicle_id" });
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.updateLocation(vehicleId, input);
    throw error;
  }
  // Append-only trail (best-effort; the latest write is what matters).
  await supabase.from("vehicle_locations_history").insert(payload);
  return { ...payload, battery_pct: null, ignition_on: null } as VehicleLocation;
}

export async function listServiceRecords(vehicleId: string): Promise<VehicleServiceRecord[]> {
  const { data, error } = await supabase
    .from("vehicle_service_records")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order("performed_at", { ascending: false });
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.listService(vehicleId);
    throw error;
  }
  return (data ?? []) as VehicleServiceRecord[];
}

export async function addServiceRecord(
  vehicleId: string,
  input: ServiceRecordInput,
): Promise<VehicleServiceRecord> {
  const { data, error } = await supabase
    .from("vehicle_service_records")
    .insert({ vehicle_id: vehicleId, ...input })
    .select("*")
    .single();
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.addService(vehicleId, input);
    throw error;
  }
  // Keep the vehicle's last-service date in step so reminders recompute.
  await supabase
    .from("vehicles")
    .update({ last_service_date: input.performed_at, updated_at: nowISO() })
    .eq("id", vehicleId);
  return data as VehicleServiceRecord;
}

export async function deleteServiceRecord(id: string): Promise<void> {
  const { error } = await supabase.from("vehicle_service_records").delete().eq("id", id);
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.removeService(id);
    throw error;
  }
}

/**
 * Owner-only. RLS hard-blocks non-owners (returns no rows), and the UI never
 * calls this unless the REAL role is owner and not previewing.
 */
export async function getFinancials(vehicleId: string): Promise<VehicleFinancials | null> {
  const { data, error } = await supabase
    .from("vehicle_financials")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.getFinancials(vehicleId);
    throw error;
  }
  return (data as VehicleFinancials | null) ?? null;
}

export async function saveFinancials(
  vehicleId: string,
  input: Omit<VehicleFinancials, "vehicle_id" | "updated_at">,
): Promise<VehicleFinancials> {
  const payload = { vehicle_id: vehicleId, ...input, updated_at: nowISO() };
  const { data, error } = await supabase
    .from("vehicle_financials")
    .upsert(payload, { onConflict: "vehicle_id" })
    .select("*")
    .single();
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.saveFinancials(vehicleId, input);
    throw error;
  }
  return data as VehicleFinancials;
}

export async function assignToProject(
  vehicleId: string,
  projectId: string,
  note: string | null,
): Promise<VehicleProjectAssignment> {
  const { data, error } = await supabase
    .from("vehicle_project_assignments")
    .insert({ vehicle_id: vehicleId, project_id: projectId, note })
    .select("*, projects(id, job_code, name, address)")
    .single();
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.assign(vehicleId, projectId, note);
    throw error;
  }
  return mapAssignment(data as unknown as RawAssignmentRow);
}

export async function unassignProject(vehicleId: string): Promise<void> {
  const { error } = await supabase
    .from("vehicle_project_assignments")
    .delete()
    .eq("vehicle_id", vehicleId);
  if (error) {
    if (isMissingVehicleTable(error)) return localStore.unassign(vehicleId);
    throw error;
  }
}

/** Active projects for the "assign to a job" picker (reuses the projects API). */
export async function listAssignableProjects(): Promise<Project[]> {
  return listProjects();
}
