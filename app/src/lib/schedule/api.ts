import { listTimeOff } from "../timeOff/api";
import { availableAssignments } from "../timeOff/model";
// Data layer for crew scheduling. Remote-first (Supabase) with a graceful
// browser-local fallback: when the additive migration hasn't been applied yet
// the table lookups fail with a "missing table" error and every call transparently
// falls back to a localStorage draft store — mirroring the plan-outline pattern
// in install/api.ts — so the board is usable pre-migration and nothing crashes.

import { supabase } from "../supabase";
import { filterToLiveProjects } from "../liveProjects";
import { isMissingFunction, isMissingTable } from "../schemaErrors";
import { addDaysISO } from "./dates";
import { filterMyPublished } from "./myPublished";
import type {
  AssignmentMember,
  AssignmentPatch,
  NewAssignmentInput,
  ScheduleAssignment,
  ScheduleEventInput,
} from "./types";

const LOCAL_KEY = "infinity.schedule.assignments.v1";

/** Errors the database returns as an ANSWER — a refusal, a constraint, a
 * session — which name the table in their text often enough ("...policy for
 * table "schedule_assignments"") that isMissingTable's name-based fallback
 * used to mistake them for the table not being there yet. */
const ANSWERED_CODES = new Set(["42501", "23502", "23503", "23505", "23514", "40001", "P0001", "PGRST301", "PGRST302"]);

/** Missing-table / missing-column errors mean the migration isn't applied.
 * A coded refusal is NOT that, however it is worded: a publish the database
 * refused used to fall through here into the browser-local store and "go",
 * with the sheet closing as if it had (2026-09-24, caught by the e2e for
 * Codex's #646 review). Only an error that carries no answer code is judged
 * by its wording. */
function isMissingScheduleTable(error: unknown): boolean {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (ANSWERED_CODES.has(code)) return false;
  return isMissingTable(error, "schedule_assignment", "schedule_events", "schedule_ai_reasons");
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
      kind: "install",
      delivery_id: null,
      start_date: input.start_date,
      end_date: input.end_date,
      start_time: input.start_time ?? null,
      ...(input.end_time !== undefined ? { end_time: input.end_time } : {}),
      status: "draft",
      color: input.color ?? null,
      note: input.note ?? null,
      created_by: null,
      created_via: input.created_via === "ai" ? "ai" : null,
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
      ...("end_time" in patch ? { end_time: patch.end_time ?? null } : {}),
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
  project_id: string | null;
  kind?: string | null;
  delivery_id?: string | null;
  package_deliveries?: { id: string; label: string | null } | null;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time?: string | null;
  status: string;
  color: string | null;
  note: string | null;
  created_by: string | null;
  created_via?: string | null;
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
  "projects(id, job_code, name, address), package_deliveries(id, label)";

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
    end_time: row.end_time ?? null,
    status: (row.status as ScheduleAssignment["status"]) ?? "draft",
    color: row.color,
    note: row.note,
    created_by: row.created_by,
    created_via: row.created_via === "ai" ? "ai" : null,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    members,
    project: row.projects ?? null,
    kind: row.kind === "delivery" ? "delivery" : "install",
    delivery_id: row.delivery_id ?? null,
    delivery: row.package_deliveries ?? null,
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
  // Wave D: the crew board reads this table directly by date range, which
  // isn't covered by the projects RLS hide — see liveProjects.ts. The local
  // fallback store above is a pre-migration offline cache, not a live read;
  // left unfiltered on purpose.
  return filterToLiveProjects(((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow));
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
  // Two-step: first the ids the user is a member of, then the full rows with the
  // single members embed. Embedding the members relationship a second time (as a
  // `!inner` filter) makes PostgREST emit SQL that trips Postgres' "aggregate
  // functions are not allowed in FROM clause of their own query level", and an
  // `!inner` filter would also collapse the crew list to just this user.
  const memberRes = await supabase
    .from("schedule_assignment_members")
    .select("assignment_id")
    .eq("profile_id", profileId);
  if (memberRes.error) {
    if (isMissingScheduleTable(memberRes.error)) {
      return filterMyPublished(readLocal(), profileId, fromISO, toISO);
    }
    throw memberRes.error;
  }
  const ids = (memberRes.data ?? []).map(
    (r) => (r as { assignment_id: string }).assignment_id,
  );
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(SELECT)
    .in("id", ids)
    .eq("status", "published")
    .lte("start_date", toISO)
    .gte("end_date", fromISO)
    .order("start_date");
  if (error) {
    if (isMissingScheduleTable(error)) {
      return filterMyPublished(readLocal(), profileId, fromISO, toISO);
    }
    throw error;
  }
  return availableAssignments(((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow), await listTimeOff(profileId), profileId);
}

/** Published assignments for one job (read-only view on the project hub). */
export async function listProjectAssignments(
  projectId: string,
): Promise<ScheduleAssignment[]> {
  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(SELECT)
    .eq("project_id", projectId)
    .eq("status", "published")
    .order("start_date");
  if (error) {
    if (isMissingScheduleTable(error)) {
      return readLocal()
        .filter((a) => a.project_id === projectId && a.status === "published")
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
    }
    throw error;
  }
  return filterToLiveProjects(((data ?? []) as unknown as RawAssignmentRow[]).map(mapRow));
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
      ...(input.end_time !== undefined ? { end_time: input.end_time } : {}),
      color: input.color ?? null,
      note: input.note ?? null,
      status: "draft",
      created_by: await currentUserId(),
      ...(input.created_via === "ai" ? { created_via: "ai" } : {}),
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
  if ("end_time" in patch) columnPatch.end_time = patch.end_time ?? null;
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

/** Server transaction: never fall back to local storage or several partial writes. */
export async function removeAssignmentDay(assignment: ScheduleAssignment, day: string): Promise<void> {
  const { error } = await supabase.rpc("schedule_remove_day", {
    p_assignment_id: assignment.id,
    p_day: day,
    p_expected_updated_at: assignment.updated_at,
  });
  if (error) {
    if (isMissingFunction(error)) throw new Error("Removing individual days is not available until the scheduling update is installed. No days were removed.");
    throw error;
  }
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

/** What a review-card Drop found when it reached the database. */
export type DropDraftResult = "dropped" | "changed";

/**
 * The Review AI drafts card's Drop (K2.8): delete this row ONLY if it is still
 * the draft the supervisor was looking at — still status 'draft', and still at
 * the revision (`updated_at`) the card was rendered from. Two supervisors can
 * have the card open at once; if one publishes, the other's Drop used to reach
 * the board's unconditional deleteAssignment and delete a PUBLISHED row the
 * crew could already see (Codex's review of #646). A publish bumps updated_at
 * (publishAssignments), so either filter alone catches it; both are sent so a
 * row edited-but-not-published is refused too. Zero rows matched is not an
 * error from PostgREST — it is the answer "this draft changed", and the card
 * says so instead of claiming a delete.
 */
export async function dropDraftAssignment(a: Pick<ScheduleAssignment, "id" | "updated_at">): Promise<DropDraftResult> {
  const { data, error } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("id", a.id)
    .eq("status", "draft")
    .eq("updated_at", a.updated_at)
    .select("id");
  if (error) {
    if (isMissingScheduleTable(error)) {
      localStore.remove(a.id);
      return "dropped";
    }
    throw error;
  }
  if (!data || (data as unknown[]).length === 0) return "changed";
  await logEvent({ assignment_id: a.id, kind: "removed" });
  return "dropped";
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

/** The model's reason for each AI draft (K2.8), from schedule_ai_reasons —
 * its own table because the reason is about PEOPLE and only a supervisor or
 * owner may read it: the row's `note` is crew-visible, and so is every
 * schedule_events row (20261003000000), which is where the first cut kept it.
 * The wall is the table's read policy (20261032000000), not this function: a
 * login below supervisor gets no rows back, never an error. Keyed by
 * assignment id; a draft the model gave no reason for, or one older than the
 * table, is simply absent. A missing table reads as no reasons, the way
 * logEvent treats its writes. */
export async function listAiDraftReasons(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("schedule_ai_reasons")
    .select("assignment_id, reason")
    .in("assignment_id", ids);
  if (error) {
    if (isMissingScheduleTable(error)) return out;
    throw error;
  }
  for (const row of (data ?? []) as { assignment_id: string | null; reason: unknown }[]) {
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (row.assignment_id && reason) out.set(row.assignment_id, reason);
  }
  return out;
}

/** What the database says about each id a publish was sent for. */
export interface PublishReadback {
  /** Now published (or further along): the publish reached the database. */
  published: string[];
  /** Still draft: the publish did not reach them. */
  drafts: string[];
  /** Not readable any more (deleted meanwhile, or hidden): not confirmed. */
  missing: string[];
}

/**
 * Re-read the rows a publish was sent for, after the reply was lost. A PATCH
 * can commit and its response never arrive (one bar of signal); the page used
 * to tell the supervisor "Nothing was published" on every error, and the crew
 * could already see the schedule. This is the only honest answer: ask the
 * database what happened. Throws when the read itself fails — the caller then
 * knows only that it does not know.
 */
export async function confirmPublished(ids: string[]): Promise<PublishReadback> {
  const out: PublishReadback = { published: [], drafts: [], missing: [] };
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("schedule_assignments")
    .select("id, status")
    .in("id", ids);
  if (error) throw error;
  const seen = new Map<string, string>();
  for (const row of (data ?? []) as { id: string; status: string }[]) seen.set(row.id, row.status);
  for (const id of ids) {
    const status = seen.get(id);
    if (status === undefined) out.missing.push(id);
    else if (status === "draft") out.drafts.push(id);
    else out.published.push(id);
  }
  // The audit rows publishAssignments writes AFTER its update never ran when
  // the reply was lost; write them for what the database confirms.
  for (const id of out.published) await logEvent({ assignment_id: id, kind: "published" });
  return out;
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
