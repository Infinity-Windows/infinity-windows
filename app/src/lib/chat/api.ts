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
import { resolveMentions } from "./mentions";
import { countUnreadByProject, type UnreadMessage } from "./unread";

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
const LOCAL_READS_KEY = "infinity.chat.reads.v1";

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

/** Missing read-cursor table means the 20260723050000 migration isn't applied. */
function isMissingReadsTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "PGRST205" || e.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("project_message_reads") ||
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

/** Local read cursors keyed by project id (ISO last_read_at). */
function readLocalCursors(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LOCAL_READS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeLocalCursor(projectId: string, iso: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const cursors = readLocalCursors();
    cursors[projectId] = iso;
    localStorage.setItem(LOCAL_READS_KEY, JSON.stringify(cursors));
  } catch {
    /* quota — best effort; unread simply won't persist this session */
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

// --- Unread tracking --------------------------------------------------------

/** The signed-in user's id, or null when unauthenticated. */
async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** The user's per-project read cursors, from the table or the local fallback. */
async function fetchReadCursors(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("project_message_reads")
    .select("project_id, last_read_at");
  if (error) {
    if (isMissingReadsTable(error)) return readLocalCursors();
    throw error;
  }
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as {
    project_id: string;
    last_read_at: string;
  }[]) {
    out[row.project_id] = row.last_read_at;
  }
  return out;
}

/**
 * Unread message counts keyed by project id, for every job the user can see.
 * Counts messages created after the user's last_read_at for that job, excluding
 * the user's own messages. RLS scopes `project_messages` to visible jobs, so the
 * result is naturally limited to jobs the user participates in / can access.
 * Projects with no unread messages are omitted.
 */
export async function getUnreadCounts(): Promise<Record<string, number>> {
  const selfId = await currentUserId();

  let messages: UnreadMessage[];
  const { data, error } = await supabase
    .from("project_messages")
    .select("project_id, author_id, created_at");
  if (error) {
    if (isMissingChatTable(error)) {
      messages = readLocal().map((m) => ({
        project_id: m.project_id,
        author_id: m.author_id,
        created_at: m.created_at,
      }));
    } else {
      throw error;
    }
  } else {
    messages = (data ?? []) as UnreadMessage[];
  }

  const cursors = await fetchReadCursors();
  return countUnreadByProject(messages, cursors, selfId);
}

/** Mark a job's chat read for the signed-in user (upsert last_read_at = now). */
export async function markRead(projectId: string): Promise<void> {
  const selfId = await currentUserId();
  const now = new Date().toISOString();
  if (!selfId) {
    writeLocalCursor(projectId, now);
    return;
  }
  const { error } = await supabase
    .from("project_message_reads")
    .upsert(
      { project_id: projectId, profile_id: selfId, last_read_at: now },
      { onConflict: "project_id,profile_id" },
    );
  if (error) {
    if (isMissingReadsTable(error)) {
      writeLocalCursor(projectId, now);
      return;
    }
    throw error;
  }
}

// --- @-mention inbox --------------------------------------------------------

export interface MentionInboxItem {
  message: ChatMessage;
  projectId: string;
  jobLabel: string;
}

interface RawMentionRow extends RawMessageRow {
  project?: { job_code?: string | null; name?: string | null } | null;
}

const MENTION_SELECT =
  "id, project_id, author_id, body, mentions, created_at, author:author_id(display_name), project:project_id(job_code, name)";

/**
 * Messages that @-mention the signed-in user, newest first — the durable in-app
 * signal for everyone (supervisors/owners only ever get pushed on a mention, so
 * this is where they see them). RLS scopes the query to jobs the user can see;
 * the user's own messages are excluded.
 */
export async function listMyMentions(limit = 30): Promise<MentionInboxItem[]> {
  const selfId = await currentUserId();
  if (!selfId) return [];

  const toItem = (m: ChatMessage, jobLabel: string): MentionInboxItem => ({
    message: m,
    projectId: m.project_id,
    jobLabel,
  });

  const { data, error } = await supabase
    .from("project_messages")
    .select(MENTION_SELECT)
    .contains("mentions", [selfId])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingChatTable(error)) {
      const me = await getMyProfile();
      const selfRoster = [{ id: selfId, display_name: me?.display_name ?? null }];
      return readLocal()
        .filter(
          (m) =>
            m.author_id !== selfId &&
            (m.mentions.includes(selfId) ||
              resolveMentions(m.body, selfRoster).includes(selfId)),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((m) => toItem(m, m.project_id));
    }
    throw error;
  }

  return ((data ?? []) as unknown as RawMentionRow[])
    .filter((row) => row.author_id !== selfId)
    .map((row) => {
      const jobLabel =
        row.project?.job_code ?? row.project?.name ?? "this job";
      return toItem(mapRow(row), jobLabel);
    });
}
