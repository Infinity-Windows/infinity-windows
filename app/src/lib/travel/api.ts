// Data layer for Travel Info. Remote-first (Supabase) with a graceful
// browser-local fallback: until the additive migration is applied the table
// lookups fail with a "missing table" error and every call transparently falls
// back to a localStorage store — mirroring schedule/api.ts — so the feature is
// usable pre-migration and nothing crashes. RLS (once applied) enforces
// crew-read-only + member-or-supervisor visibility server-side.

import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type {
  ContactInput,
  Flight,
  FlightInput,
  GroundInput,
  GroundTransport,
  Lodging,
  LodgingInput,
  NewTripInput,
  Procedure,
  ProcedureInput,
  Trip,
  TripAttachment,
  TripContact,
  TripCrewMember,
  TripDetail,
  TripPatch,
} from "./types";

const LOCAL_KEY = "infinity.travel.trips.v1";
const BUCKET = "trip-attachments";

/** Missing-table / missing-column errors mean the migration isn't applied. */
function isMissingTravelTable(error: unknown): boolean {
  return isMissingTable(error);
}

function nowISO(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Math.random().toString(36).slice(2)}`;
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// =============================================================================
// Local fallback store
// =============================================================================

interface LocalTrip extends Trip {
  flights: Flight[];
  lodging: Lodging[];
  ground: GroundTransport[];
  procedures: Procedure[];
  contacts: TripContact[];
  attachments: TripAttachment[];
}

function readLocal(): LocalTrip[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as LocalTrip[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(rows: LocalTrip[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  } catch {
    /* quota — session view still works */
  }
}

function localTripSummary(t: LocalTrip): Trip {
  const { flights, lodging, ground, procedures, contacts, attachments, ...trip } = t;
  void flights;
  void lodging;
  void ground;
  void procedures;
  void contacts;
  void attachments;
  return trip;
}

function nextSort<T extends { sort_order: number }>(rows: T[]): number {
  return rows.reduce((max, r) => Math.max(max, r.sort_order), -1) + 1;
}

const localStore = {
  list(): Trip[] {
    return readLocal().map(localTripSummary);
  },
  get(id: string): TripDetail | null {
    const t = readLocal().find((r) => r.id === id);
    if (!t) return null;
    return {
      trip: localTripSummary(t),
      flights: t.flights ?? [],
      lodging: t.lodging ?? [],
      ground: t.ground ?? [],
      procedures: t.procedures ?? [],
      contacts: t.contacts ?? [],
      attachments: t.attachments ?? [],
    };
  },
  create(input: NewTripInput): Trip {
    const id = newId();
    const row: LocalTrip = {
      id,
      project_id: input.project_id ?? null,
      name: input.name,
      destination: input.destination ?? null,
      start_date: input.start_date,
      end_date: input.end_date,
      timezone: input.timezone ?? null,
      notes: input.notes ?? null,
      status: "draft",
      published_at: null,
      created_by: null,
      created_at: nowISO(),
      updated_at: nowISO(),
      crew: input.crew.map((m) => ({ ...m })),
      project: null,
      flights: [],
      lodging: [],
      ground: [],
      procedures: [],
      contacts: [],
      attachments: [],
    };
    writeLocal([...readLocal(), row]);
    return localTripSummary(row);
  },
  update(id: string, patch: TripPatch): Trip {
    const rows = readLocal();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error("Trip not found");
    const next: LocalTrip = { ...rows[idx], updated_at: nowISO() };
    if ("name" in patch && patch.name != null) next.name = patch.name;
    if ("destination" in patch) next.destination = patch.destination ?? null;
    if ("start_date" in patch && patch.start_date) next.start_date = patch.start_date;
    if ("end_date" in patch && patch.end_date) next.end_date = patch.end_date;
    if ("timezone" in patch) next.timezone = patch.timezone ?? null;
    if ("notes" in patch) next.notes = patch.notes ?? null;
    if ("project_id" in patch) next.project_id = patch.project_id ?? null;
    if ("status" in patch && patch.status) {
      next.status = patch.status;
      if (patch.status === "published" && !next.published_at) next.published_at = nowISO();
    }
    if (patch.crew) next.crew = patch.crew.map((m) => ({ ...m }));
    rows[idx] = next;
    writeLocal(rows);
    return localTripSummary(next);
  },
  remove(id: string): void {
    writeLocal(readLocal().filter((r) => r.id !== id));
  },
  mutateChild(
    tripId: string,
    key: "flights" | "lodging" | "ground" | "procedures" | "contacts",
    fn: (list: unknown[]) => unknown[],
  ): void {
    const rows = readLocal();
    const idx = rows.findIndex((r) => r.id === tripId);
    if (idx < 0) return;
    const current = (rows[idx][key] ?? []) as unknown[];
    rows[idx] = { ...rows[idx], [key]: fn(current), updated_at: nowISO() } as LocalTrip;
    writeLocal(rows);
  },
};

/** Minimal shape shared by every local child row (for the fallback store). */
type LocalChild = Record<string, unknown> & { id: string; sort_order?: number };

// =============================================================================
// Remote row mapping
// =============================================================================

const TRIP_SELECT =
  "*, trip_crew(profile_id, role, profiles(display_name)), " +
  "projects(id, job_code, name, address)";

interface RawCrewRow {
  profile_id: string;
  role: string;
  profiles?: { display_name?: string | null } | null;
}

function mapTrip(row: Record<string, unknown>): Trip {
  const crewRows = (row.trip_crew as RawCrewRow[] | null) ?? [];
  const crew: TripCrewMember[] = crewRows.map((c) => ({
    profile_id: c.profile_id,
    role: c.role,
    display_name: c.profiles?.display_name ?? null,
  }));
  return {
    id: row.id as string,
    project_id: (row.project_id as string | null) ?? null,
    name: row.name as string,
    destination: (row.destination as string | null) ?? null,
    start_date: row.start_date as string,
    end_date: row.end_date as string,
    timezone: (row.timezone as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    status: (row.status as Trip["status"]) ?? "draft",
    published_at: (row.published_at as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    crew,
    project: (row.projects as Trip["project"]) ?? null,
  };
}

// =============================================================================
// Public API — trips
// =============================================================================

/** Every trip the caller may see (RLS scopes crew to their own). */
export async function listTrips(): Promise<Trip[]> {
  const { data, error } = await supabase
    .from("trips")
    .select(TRIP_SELECT)
    .order("start_date", { ascending: false });
  if (error) {
    if (isMissingTravelTable(error)) return localStore.list();
    throw error;
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapTrip);
}

/** Full detail for one trip: crew + flights + lodging + ground + procedures +
 * contacts + attachments (plus company-wide procedure templates). */
export async function getTrip(id: string): Promise<TripDetail | null> {
  const tripRes = await supabase.from("trips").select(TRIP_SELECT).eq("id", id).maybeSingle();
  if (tripRes.error) {
    if (isMissingTravelTable(tripRes.error)) return localStore.get(id);
    throw tripRes.error;
  }
  if (!tripRes.data) return null;
  const trip = mapTrip(tripRes.data as unknown as Record<string, unknown>);

  const [flights, lodging, ground, procedures, contacts, attachments] = await Promise.all([
    supabase.from("flights").select("*").eq("trip_id", id).order("sort_order"),
    supabase.from("lodging").select("*").eq("trip_id", id).order("sort_order"),
    supabase.from("ground_transport").select("*").eq("trip_id", id).order("sort_order"),
    supabase.from("procedures").select("*").or(`trip_id.eq.${id},trip_id.is.null`).order("sort_order"),
    supabase.from("trip_contacts").select("*").eq("trip_id", id).order("sort_order"),
    supabase.from("trip_attachments").select("*").eq("trip_id", id).order("created_at"),
  ]);

  return {
    trip,
    flights: (flights.data ?? []) as Flight[],
    lodging: (lodging.data ?? []) as Lodging[],
    ground: (ground.data ?? []) as GroundTransport[],
    procedures: (procedures.data ?? []) as Procedure[],
    contacts: (contacts.data ?? []) as TripContact[],
    attachments: (attachments.data ?? []) as TripAttachment[],
  };
}

async function replaceCrew(tripId: string, crew: TripCrewMember[]): Promise<void> {
  await supabase.from("trip_crew").delete().eq("trip_id", tripId);
  if (crew.length === 0) return;
  const { error } = await supabase.from("trip_crew").insert(
    crew.map((m) => ({ trip_id: tripId, profile_id: m.profile_id, role: m.role })),
  );
  if (error) throw error;
}

export async function createTrip(input: NewTripInput): Promise<Trip> {
  const { data, error } = await supabase
    .from("trips")
    .insert({
      project_id: input.project_id ?? null,
      name: input.name,
      destination: input.destination ?? null,
      start_date: input.start_date,
      end_date: input.end_date,
      timezone: input.timezone ?? null,
      notes: input.notes ?? null,
      status: "draft",
      created_by: await currentUserId(),
    })
    .select("id")
    .single();
  if (error) {
    if (isMissingTravelTable(error)) return localStore.create(input);
    throw error;
  }
  const id = (data as { id: string }).id;
  await replaceCrew(id, input.crew);
  const detail = await getTrip(id);
  return detail!.trip;
}

export async function updateTrip(id: string, patch: TripPatch): Promise<Trip> {
  const cols: Record<string, unknown> = { updated_at: nowISO() };
  if ("name" in patch) cols.name = patch.name;
  if ("destination" in patch) cols.destination = patch.destination ?? null;
  if ("start_date" in patch) cols.start_date = patch.start_date;
  if ("end_date" in patch) cols.end_date = patch.end_date;
  if ("timezone" in patch) cols.timezone = patch.timezone ?? null;
  if ("notes" in patch) cols.notes = patch.notes ?? null;
  if ("project_id" in patch) cols.project_id = patch.project_id ?? null;
  if ("status" in patch) {
    cols.status = patch.status;
    if (patch.status === "published") cols.published_at = nowISO();
  }
  const { error } = await supabase.from("trips").update(cols).eq("id", id);
  if (error) {
    if (isMissingTravelTable(error)) return localStore.update(id, patch);
    throw error;
  }
  if (patch.crew) await replaceCrew(id, patch.crew);
  const detail = await getTrip(id);
  return detail!.trip;
}

export async function deleteTrip(id: string): Promise<void> {
  const { error } = await supabase.from("trips").delete().eq("id", id);
  if (error) {
    if (isMissingTravelTable(error)) return localStore.remove(id);
    throw error;
  }
}

export async function publishTrip(id: string): Promise<Trip> {
  return updateTrip(id, { status: "published" });
}

// =============================================================================
// Section CRUD (flights / lodging / ground / procedures / contacts)
// =============================================================================

async function upsertRow<T extends { id?: string; sort_order?: number }>(
  table: string,
  tripId: string,
  localKey: "flights" | "lodging" | "ground" | "procedures" | "contacts",
  input: T,
): Promise<void> {
  const { id, ...fields } = input;
  const payload = { ...fields, trip_id: tripId, updated_at: nowISO() };
  const res = id
    ? await supabase.from(table).update(payload).eq("id", id)
    : await supabase.from(table).insert(payload);
  if (res.error) {
    if (isMissingTravelTable(res.error)) {
      localStore.mutateChild(tripId, localKey, (list) => {
        const arr = list as LocalChild[];
        if (id) return arr.map((r) => (r.id === id ? { ...r, ...fields } : r));
        const row: LocalChild = {
          ...fields,
          id: newId(),
          trip_id: tripId,
          sort_order: input.sort_order ?? nextSort(arr as { sort_order: number }[]),
        };
        return [...arr, row];
      });
      return;
    }
    throw res.error;
  }
}

async function deleteRow(
  table: string,
  tripId: string,
  localKey: "flights" | "lodging" | "ground" | "procedures" | "contacts",
  id: string,
): Promise<void> {
  const res = await supabase.from(table).delete().eq("id", id);
  if (res.error) {
    if (isMissingTravelTable(res.error)) {
      localStore.mutateChild(tripId, localKey, (list) =>
        (list as LocalChild[]).filter((r) => r.id !== id),
      );
      return;
    }
    throw res.error;
  }
}

export function upsertFlight(tripId: string, input: FlightInput & { id?: string }) {
  return upsertRow("flights", tripId, "flights", input);
}
export function deleteFlight(tripId: string, id: string) {
  return deleteRow("flights", tripId, "flights", id);
}

export function upsertLodging(tripId: string, input: LodgingInput & { id?: string }) {
  return upsertRow("lodging", tripId, "lodging", input);
}
export function deleteLodging(tripId: string, id: string) {
  return deleteRow("lodging", tripId, "lodging", id);
}

export function upsertGround(tripId: string, input: GroundInput & { id?: string }) {
  return upsertRow("ground_transport", tripId, "ground", input);
}
export function deleteGround(tripId: string, id: string) {
  return deleteRow("ground_transport", tripId, "ground", id);
}

export function upsertContact(tripId: string, input: ContactInput & { id?: string }) {
  return upsertRow("trip_contacts", tripId, "contacts", input);
}
export function deleteContact(tripId: string, id: string) {
  return deleteRow("trip_contacts", tripId, "contacts", id);
}

/** Procedures may be trip-scoped or company-wide (trip_id null). */
export async function upsertProcedure(
  tripId: string | null,
  input: ProcedureInput & { id?: string },
): Promise<void> {
  const { id, ...fields } = input;
  const payload = { ...fields, trip_id: tripId, updated_at: nowISO() };
  const res = id
    ? await supabase.from("procedures").update(payload).eq("id", id)
    : await supabase.from("procedures").insert(payload);
  if (res.error) {
    if (isMissingTravelTable(res.error) && tripId) {
      localStore.mutateChild(tripId, "procedures", (list) => {
        const arr = list as LocalChild[];
        if (id) return arr.map((r) => (r.id === id ? { ...r, ...fields } : r));
        return [
          ...arr,
          {
            ...fields,
            id: newId(),
            trip_id: tripId,
            sort_order: input.sort_order ?? nextSort(arr as { sort_order: number }[]),
          },
        ];
      });
      return;
    }
    if (isMissingTravelTable(res.error)) return; // company templates unavailable offline
    throw res.error;
  }
}
export async function deleteProcedure(tripId: string | null, id: string): Promise<void> {
  const res = await supabase.from("procedures").delete().eq("id", id);
  if (res.error) {
    if (isMissingTravelTable(res.error) && tripId) {
      localStore.mutateChild(tripId, "procedures", (list) =>
        (list as LocalChild[]).filter((r) => r.id !== id),
      );
      return;
    }
    if (isMissingTravelTable(res.error)) return;
    throw res.error;
  }
}

// =============================================================================
// Attachments (private bucket + signed URLs)
// =============================================================================

/** Short-lived signed URL for a stored attachment, or null on failure. */
export async function signedAttachmentUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 3600);
  if (error) return null;
  return data.signedUrl;
}

export interface UploadAttachmentInput {
  tripId: string;
  file: File;
  label?: string | null;
  flightId?: string | null;
  lodgingId?: string | null;
}

/** Upload a file to the private bucket + record it. Attachments need the
 * migration (storage + table); offline it throws a friendly error. */
export async function uploadTripAttachment(input: UploadAttachmentInput): Promise<void> {
  const safeName = input.file.name.replace(/[^\w.-]+/g, "_");
  const path = `${input.tripId}/${newId()}-${safeName}`;
  const up = await supabase.storage
    .from(BUCKET)
    .upload(path, input.file, { contentType: input.file.type || undefined });
  if (up.error) throw up.error;
  const { error } = await supabase.from("trip_attachments").insert({
    trip_id: input.tripId,
    flight_id: input.flightId ?? null,
    lodging_id: input.lodgingId ?? null,
    storage_path: path,
    label: input.label ?? input.file.name,
    created_by: await currentUserId(),
  });
  if (error) throw error;
}

export async function deleteAttachment(att: TripAttachment): Promise<void> {
  await supabase.storage.from(BUCKET).remove([att.storage_path]);
  const { error } = await supabase.from("trip_attachments").delete().eq("id", att.id);
  if (error && !isMissingTravelTable(error)) throw error;
}
