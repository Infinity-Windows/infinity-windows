// Data layer for crew scheduling. Remote-first (Supabase) with a graceful
// browser-local fallback: when the additive migration hasn't been applied yet
// the table lookups fail with a "missing table" error and every call transparently
// falls back to a localStorage draft store — mirroring the plan-outline pattern
// in install/api.ts — so the board is usable pre-migration and nothing crashes.

import { supabase } from "../supabase";
import { addDaysISO } from "./dates";
import type {
  AssignmentMember,
  AssignmentPatch,
  NewAssignmentInput,
  ScheduleAssignment,
  ScheduleEventInput,
} from "./types";

const LOCAL_KEY = "infinity.schedule.assignments.v1";

/** Missing-table / missing-column errors mean the migration isn't applied. */
function isMissingScheduleTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "PGRST205" || e.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("schedule_assignment") ||
    msg.includes("schedule_events") ||
    (msg.includes("does not exist") && msg.includes("relation"))
  );
}

// --- Local fallback store ---------------------------------------------------

function readLocal(): ScheduleAssignment[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as ScheduleAssignment[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(rows: ScheduleAssignment[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  } catch {
    /* quota — in-memory view for this session still works */
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Math.random().toString(36).slice(2)}`;
}

function rangesTouch(a: ScheduleAssignment, fromISO: string, toISO: string): boolean {
  return a.start_date <= toISO && a.end_date >= fromISO;
}

const localStore = {
  list(fromISO: string, toISO: string): ScheduleAssignment[] {
    return readLocal()
      .filter((a) => rangesTouch(a, fromISO, toISO))
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  },
  drafts(): ScheduleAssignment[] {
    return readLocal().filter((a) => a.status === "draft");
  },
  create(input: NewAssignmentInput): ScheduleAssignment {
    const row: ScheduleAssignment = {
      id: newId(),
      project_id: input.project_id,
      start_date: input.start_date,
      end_date: input.end_date,
      start_time: input.start_time ?? null,
      status: "draft",
      color: input.color ?? null,
      note: input.note ?? null,
      created_by: null,
      published_at: null,
      created_at: nowISO(),
      updated_at: nowISO(),
      members: input.members.map((m) => ({ ...m })),
      project: null,
    };
    writeLocal([...readLocal(), row]);
    return row;
  },
  update(id: string, patch: AssignmentPatch): ScheduleAssignment {
    const rows = readLocal();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error("Assignment not found");
    const next: ScheduleAssignment = {
      ...rows[idx],
      ...("start_date" in patch ? { start_date: patch.start_date! } : {}),
      ...("end_date" in patch ? { end_date: patch.end_date! } : {}),
      ...("start_time" in patch ? { start_time: patch.start_time ?? null } : {}),
      ...("color" in patch ? { color: patch.color ?? null } : {}),
      ...("note" in patch ? { note: patch.note ?? null } : {}),
      ...("status" in patch ? { status: patch.status! } : {}),
      ...(patch.members ? { members: patch.members.map((m) => ({ ...m })) } : {}),
      updated_at: nowISO(),
    };
    rows[idx] = next;
    writeLocal(rows);
    return next;
  },
  remove(id: string): void {
    writeLocal(readLocal().filter((r) => r.id !== id));
  },
  publish(ids: string[]): void {
    const set = new Set(ids);
    writeLocal(
      readLocal().map((r) =>
        set.has(r.id) && r.status === "draft"
          ? { ...r, status: "published", published_at: nowISO(), updated_at: nowISO() }
          : r,
      ),
    );
  },
};

// --- Row mapping (remote) ---------------------------------------------------

interface RawMemberRow {
  profile_id: string;
  role: string;
  profiles?: { display_name?: string | null } | null;
}

interface RawAssignmentRow {
  id: string;
  project_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  status: string;
  color: string | null;
  note: string | null;
  created_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  schedule_assignment_members?: RawMemberRow[] | null;
  projects?: {
    id: string;
    job_code: string;
    name: string;
    address: string | null;
  } | null;
}

const SELECT =
  "*, schedule_assignment_members(profile_id, role, profiles(display_name)), " +
  "projects(id, job_code, name, address)";

function mapRow(row: RawAssignmentRow): ScheduleAssignment {
  const members: AssignmentMember[] = (row.schedule_assignment_members ?? []).map(
    (m) => ({
      profile_id: m.profile_id,
      role: m.role === "foreman" ? "foreman" : "installer",
      display_name: m.profiles?.display_name ?? null,
    }),
  );
  return {
    id: row.id,
    project_id: row.project_id,
    start_date: row.start_date,
    end_date: row.end_date,
    start_time: row.start_time,
    status: (row.status as ScheduleAssignment["status"]) ?? "draft",
    color: row.color,
    note: row.note,
    created_by: row.created_by,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    members,
    project: row.projects ?? null,
  };
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

async function replaceMembers(
  assignmentId: string,
  members: AssignmentMember[],
): Promise<void> {
  await supabase
    .from("schedule_assignment_members")
    .delete()
    .eq("assignment_id", assignmentId);
  if (members.length === 0) return;
  const { error } = await supabase.from("schedule_assignment_members").insert(
    members.map((m) => ({
      assignment_id: assignmentId,
      profile_id: m.profile_id,
      role: m.role,
    })),
  );
  if (error) throw error;
}

// --- Public API -------------------------------------------------------------

/** Assignments overlapping the inclusive [from, to] window (the fetch primitive). */
export async function listAssignments(
  fromISO: string,
  toISO: string,
): Promise<ScheduleAssignment[]> {
  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(SELECT)
    .lte("start_date", toISO)
    .gte("end_date", fromISO)
    .order("start_date");
  if (error) {
    if (isMissingScheduleTable(error)) return localStore.list(fromISO, toISO);
    throw error;
  }
  return ((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow);
}

/** All still-draft assignments (drives the unpublished-changes bar). */
export async function listDraftAssignments(): Promise<ScheduleAssignment[]> {
  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(SELECT)
    .eq("status", "draft")
    .order("start_date");
  if (error) {
    if (isMissingScheduleTable(error)) return localStore.drafts();
    throw error;
  }
  return ((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow);
}

/** Published assignments a person is on, overlapping [from, to] (My Schedule). */
export async function listMyPublished(
  profileId: string,
  fromISO: string,
  toISO: string,
): Promise<ScheduleAssignment[]> {
  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(`${SELECT}, schedule_assignment_members!inner(profile_id)`)
    .eq("status", "published")
    .lte("start_date", toISO)
    .gte("end_date", fromISO)
    .eq("schedule_assignment_members.profile_id", profileId)
    .order("start_date");
  if (error) {
    if (isMissingScheduleTable(error)) {
      return localStore
        .list(fromISO, toISO)
        .filter(
          (a) =>
            a.status === "published" &&
            a.members.some((m) => m.profile_id === profileId),
        );
    }
    throw error;
  }
  return ((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow);
}

export async function createAssignment(
  input: NewAssignmentInput,
): Promise<ScheduleAssignment> {
  const { data, error } = await supabase
    .from("schedule_assignments")
    .insert({
      project_id: input.project_id,
      start_date: input.start_date,
      end_date: input.end_date,
      start_time: input.start_time ?? null,
      color: input.color ?? null,
      note: input.note ?? null,
      status: "draft",
      created_by: await currentUserId(),
    })
    .select("id")
    .single();
  if (error) {
    if (isMissingScheduleTable(error)) return localStore.create(input);
    throw error;
  }
  const id = (data as { id: string }).id;
  await replaceMembers(id, input.members);
  await logEvent({ assignment_id: id, kind: "created" });
  const [row] = await listById([id]);
  return row;
}

export async function updateAssignment(
  id: string,
  patch: AssignmentPatch,
): Promise<ScheduleAssignment> {
  const columnPatch: Record<string, unknown> = { updated_at: nowISO() };
  if ("start_date" in patch) columnPatch.start_date = patch.start_date;
  if ("end_date" in patch) columnPatch.end_date = patch.end_date;
  if ("start_time" in patch) columnPatch.start_time = patch.start_time ?? null;
  if ("color" in patch) columnPatch.color = patch.color ?? null;
  if ("note" in patch) columnPatch.note = patch.note ?? null;
  if ("status" in patch) columnPatch.status = patch.status;

  const { error } = await supabase
    .from("schedule_assignments")
    .update(columnPatch)
    .eq("id", id);
  if (error) {
    if (isMissingScheduleTable(error)) return localStore.update(id, patch);
    throw error;
  }
  if (patch.members) await replaceMembers(id, patch.members);
  const [row] = await listById([id]);
  return row;
}

export async function deleteAssignment(id: string): Promise<void> {
  const { error } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("id", id);
  if (error) {
    if (isMissingScheduleTable(error)) {
      localStore.remove(id);
      return;
    }
    throw error;
  }
  await logEvent({ assignment_id: id, kind: "removed" });
}

/** Flip the given draft assignments to published and stamp published_at. */
export async function publishAssignments(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("schedule_assignments")
    .update({ status: "published", published_at: nowISO(), updated_at: nowISO() })
    .in("id", ids)
    .eq("status", "draft");
  if (error) {
    if (isMissingScheduleTable(error)) {
      localStore.publish(ids);
      return;
    }
    throw error;
  }
  for (const id of ids) await logEvent({ assignment_id: id, kind: "published" });
}

/** Best-effort audit write; never throws (a missing table is fine). */
export async function logEvent(input: ScheduleEventInput): Promise<void> {
  try {
    await supabase.from("schedule_events").insert({
      assignment_id: input.assignment_id,
      actor: await currentUserId(),
      kind: input.kind,
      payload: input.payload ?? null,
    });
  } catch {
    /* audit is optional; ignore */
  }
}

async function listById(ids: string[]): Promise<ScheduleAssignment[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(SELECT)
    .in("id", ids);
  if (error) {
    if (isMissingScheduleTable(error)) {
      const set = new Set(ids);
      return readLocal().filter((r) => set.has(r.id));
    }
    throw error;
  }
  return ((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow);
}

/** The 6-month scheduling horizon [today, today+~6mo] as ISO strings. */
export function horizonRange(todayISO: string): { from: string; to: string } {
  return { from: todayISO, to: addDaysISO(todayISO, 183) };
}
