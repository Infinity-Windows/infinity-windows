// Data layer for the per-job group chat. Remote-first (Supabase) with a
// graceful browser-local fallback: when the additive `project_messages`
// migration hasn't been applied yet the table lookups fail with a "missing
// table" error and every call transparently falls back to a localStorage store
// — mirroring the schedule/vehicles libs — so the Chat tab is usable
// pre-migration and nothing crashes.

import { supabase } from "../supabase";
import { getMyProfile, listProfiles } from "../install/api";
import { roleRank } from "../install/types";
import { listProjectAssignments } from "../schedule/api";

export interface ChatMessage {
  id: string;
  project_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  mentions: string[];
  created_at: string;
}

export interface ChatRosterMember {
  id: string;
  display_name: string | null;
  role: string | null;
  /** True when the person is assigned to THIS job (crew), vs. a supervisor/owner. */
  assigned: boolean;
}

export interface ChatRoster {
  members: ChatRosterMember[];
  /** Installers + foreman assigned to the job — pushed on every message. */
  assignedCrewIds: string[];
  /** Supervisors/owners — pushed only when @-mentioned. */
  supervisorOwnerIds: string[];
}

const LOCAL_KEY = "infinity.chat.messages.v1";

/** Missing-table / missing-column errors mean the migration isn't applied. */
function isMissingChatTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "PGRST205" || e.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("project_messages") ||
    (msg.includes("does not exist") && msg.includes("relation"))
  );
}

// --- Local fallback store ---------------------------------------------------

function readLocal(): ChatMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(rows: ChatMessage[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  } catch {
    /* quota — the in-memory view for this session still works */
  }
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Math.random().toString(36).slice(2)}`;
}

// --- Row mapping (remote) ---------------------------------------------------

interface RawMessageRow {
  id: string;
  project_id: string;
  author_id: string;
  body: string;
  mentions: string[] | null;
  created_at: string;
  author?: { display_name?: string | null } | null;
}

const MESSAGE_SELECT =
  "id, project_id, author_id, body, mentions, created_at, author:author_id(display_name)";

function mapRow(row: RawMessageRow): ChatMessage {
  return {
    id: row.id,
    project_id: row.project_id,
    author_id: row.author_id,
    author_name: row.author?.display_name ?? null,
    body: row.body,
    mentions: Array.isArray(row.mentions) ? row.mentions : [],
    created_at: row.created_at,
  };
}

// --- Public API -------------------------------------------------------------

/** The job's messages oldest-first (the thread order). */
export async function listMessages(projectId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("project_messages")
    .select(MESSAGE_SELECT)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingChatTable(error)) {
      return readLocal()
        .filter((m) => m.project_id === projectId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    throw error;
  }
  return ((data ?? []) as unknown as RawMessageRow[]).map(mapRow);
}

/** Post a text message to the job, stamping author_id = the signed-in user. */
export async function sendMessage(
  projectId: string,
  body: string,
  mentionedIds: string[],
): Promise<ChatMessage> {
  const text = body.trim();
  if (!text) throw new Error("Message is empty.");
  const { data: userData } = await supabase.auth.getUser();
  const authorId = userData.user?.id ?? null;

  const { data, error } = await supabase
    .from("project_messages")
    .insert({
      project_id: projectId,
      author_id: authorId,
      body: text,
      mentions: mentionedIds,
    })
    .select(MESSAGE_SELECT)
    .single();
  if (error) {
    if (isMissingChatTable(error)) {
      const me = await getMyProfile();
      const row: ChatMessage = {
        id: newId(),
        project_id: projectId,
        author_id: authorId ?? me?.id ?? "local",
        author_name: me?.display_name ?? null,
        body: text,
        mentions: mentionedIds,
        created_at: new Date().toISOString(),
      };
      writeLocal([...readLocal(), row]);
      return row;
    }
    throw error;
  }
  return mapRow(data as unknown as RawMessageRow);
}

/**
 * The chat roster for a job: assigned crew (installers + foreman) derived from
 * the published schedule (schedule_assignment_members) UNION any installers on
 * the job's openings, PLUS every supervisor/owner (who can view/post on any
 * job). Drives the composer's @-mention autocomplete and the notify split.
 */
export async function listRoster(projectId: string): Promise<ChatRoster> {
  const profiles = await listProfiles();
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const assigned = new Set<string>();

  // Crew on the job's published schedule.
  const assignments = await listProjectAssignments(projectId);
  for (const a of assignments) {
    for (const m of a.members) assigned.add(m.profile_id);
  }

  // Installers assigned to any of the job's openings.
  const { data: openingRows, error: openingErr } = await supabase
    .from("project_openings")
    .select("assigned_to")
    .eq("project_id", projectId)
    .not("assigned_to", "is", null);
  if (openingErr && !isMissingChatTable(openingErr)) {
    // Openings is a core table; a genuine error shouldn't sink the roster, but
    // a missing-relation in a bare env is tolerated (fall through with none).
    throw openingErr;
  }
  for (const row of (openingRows ?? []) as { assigned_to: string | null }[]) {
    if (row.assigned_to) assigned.add(row.assigned_to);
  }

  const supervisorOwnerIds = profiles
    .filter((p) => roleRank(p.role) >= 2)
    .map((p) => p.id);
  const supSet = new Set(supervisorOwnerIds);

  // Assigned crew for notify purposes excludes pure supervisors/owners: they're
  // covered by the mention-only rule, not the "every message" rule.
  const assignedCrewIds = [...assigned].filter((id) => !supSet.has(id));

  const memberIds = new Set<string>([...assigned, ...supervisorOwnerIds]);
  const members: ChatRosterMember[] = [...memberIds].map((id) => {
    const p = byId.get(id);
    return {
      id,
      display_name: p?.display_name ?? null,
      role: p?.role ?? null,
      assigned: assigned.has(id) && !supSet.has(id),
    };
  });
  members.sort((a, b) =>
    (a.display_name ?? "").localeCompare(b.display_name ?? ""),
  );

  return { members, assignedCrewIds, supervisorOwnerIds };
}
