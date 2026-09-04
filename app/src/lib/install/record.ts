// The unit Record (CONTEXT.md): the full story of one unit, read back from
// the atoms the field already saves — install rounds (voided included),
// their media, the session timeline, redos, the flashing photo. Nothing here
// is stored FOR the record; it is a reading. Raw facts show to every role;
// anything that compares stays foreman+ (that gate lives in the UI).

import { supabase } from "../supabase";
import { isMissingColumn } from "../schemaErrors";
import type { MemoTopics } from "./types";
import { MEMO_TOPICS } from "./types";
import { sessionMinutes, type UnitRedo, type UnitSession } from "./sessions";

/** One install round: an install_events row with everything worth reading. */
export interface RecordEvent extends MemoTopics {
  id: string;
  created_at: string;
  started_at: string | null;
  installer: string | null;
  installer_id?: string | null;
  /** Wave Y: who installed it, when somebody else filed it. Null = the filer. */
  credited_to?: string | null;
  minutes: number | null;
  quality_grade: number | null;
  transcript_raw: string | null;
  photo_findings: string[] | null;
  voided_at: string | null;
  void_reason: string | null;
  voider?: { display_name: string | null } | null;
}

/** All install rounds on one opening, oldest first, voided rounds included —
 * void never deletes, and the Record is where that pays off. */
export async function listOpeningInstallEvents(
  openingId: string,
): Promise<RecordEvent[]> {
  const memoCols = MEMO_TOPICS.map((t) => t.key).join(", ");
  const base = `id, created_at, started_at, installer, minutes, quality_grade, transcript_raw, photo_findings, voided_at, void_reason, ${memoCols}, voider:voided_by(display_name)`;
  const read = async (cols: string) =>
    supabase
      .from("install_events")
      .select(cols)
      .eq("project_opening_id", openingId)
      .order("created_at", { ascending: true });
  // The credit columns come first, and a database that predates them falls
  // back to the round exactly as the Record has always read it — a phone ahead
  // of the migration still gets the window's whole story.
  const first = await read(`${base}, installer_id, credited_to`);
  if (!first.error) return (first.data ?? []) as unknown as RecordEvent[];
  if (!isMissingColumn(first.error, "credited_to")) throw first.error;
  const fallback = await read(base);
  if (fallback.error) throw fallback.error;
  return (fallback.data ?? []) as unknown as RecordEvent[];
}

export interface RecordMedia {
  id: string;
  installEventId: string;
  kind: "photo" | "video" | "voice_memo";
  signedUrl: string | null;
  createdAt: string;
}

/** Attachments storage_path is bucket-prefixed ("install-media/…"). */
async function signBucketPath(storagePath: string): Promise<string | null> {
  const slash = storagePath.indexOf("/");
  const bucket = slash >= 0 ? storagePath.slice(0, slash) : "install-media";
  const path = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

/** A phase photo path is raw inside install-media (projectId/…), never
 * bucket-prefixed — signing it through the bucket parser would eat the
 * project id as a bucket name. */
export async function signedPhasePhoto(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from("install-media")
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

/** The media of a set of install rounds (photos, walkthrough video, voice
 * memo), signed. Media hangs off the EVENT — a round keeps its own photos. */
export async function listInstallMedia(
  eventIds: string[],
): Promise<RecordMedia[]> {
  if (eventIds.length === 0) return [];
  const { data, error } = await supabase
    .from("attachments")
    .select("id, install_event_id, kind, storage_path, created_at")
    .in("install_event_id", eventIds)
    .in("kind", ["photo", "video", "voice_memo"])
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as {
    id: string;
    install_event_id: string;
    kind: RecordMedia["kind"];
    storage_path: string;
    created_at: string;
  }[];
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      installEventId: r.install_event_id,
      kind: r.kind,
      signedUrl: await signBucketPath(r.storage_path),
      createdAt: r.created_at,
    })),
  );
}

/**
 * Cheap per-opening photo counts for a WHOLE job (Studio 100x #7): id/kind
 * only, nothing signed — so the model can paint a 📷 badge on every unit at
 * once without paying to sign a single URL. Signing stays exactly where it
 * already lives, listInstallMedia above, for the one unit somebody taps.
 *
 * Void never deletes (this file's own header): a voided round's photos
 * still count, same as groupRounds still shows them on the Record.
 *
 * Two queries, not one nested embed, on purpose: both shapes already ship
 * elsewhere in this file/api.ts (the project_openings!inner join
 * mirrors listVoidedInstallOpeningIds; the install_event_id .in() filter
 * mirrors listInstallMedia above) — proven shapes over a new untested one.
 */
export async function listProjectPhotoCounts(
  projectId: string,
): Promise<Map<string, number>> {
  const { data: events, error: eventsError } = await supabase
    .from("install_events")
    .select(
      "id, project_opening_id, project_openings:project_opening_id!inner(project_id)",
    )
    .eq("project_openings.project_id", projectId);
  if (eventsError) throw eventsError;
  const openingByEvent = new Map(
    (events ?? []).map((e) => [e.id as string, e.project_opening_id as string]),
  );
  const eventIds = [...openingByEvent.keys()];
  if (eventIds.length === 0) return new Map();

  const { data: photos, error: photosError } = await supabase
    .from("attachments")
    .select("install_event_id")
    .in("install_event_id", eventIds)
    .eq("kind", "photo");
  if (photosError) throw photosError;

  const counts = new Map<string, number>();
  for (const row of (photos ?? []) as { install_event_id: string | null }[]) {
    const openingId = row.install_event_id
      ? openingByEvent.get(row.install_event_id)
      : undefined;
    if (!openingId) continue;
    counts.set(openingId, (counts.get(openingId) ?? 0) + 1);
  }
  return counts;
}

/** Every redo ever pressed on one opening, resolved ones included. */
export async function listOpeningRedos(openingId: string): Promise<UnitRedo[]> {
  const { data, error } = await supabase
    .from("unit_redos")
    .select("*, presser:profiles!unit_redos_pressed_by_fkey(display_name)")
    .eq("opening_id", openingId)
    .order("pressed_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as UnitRedo[];
}

// =============================================================================
// Pure builders
// =============================================================================

export interface RecordRound {
  event: RecordEvent;
  media: RecordMedia[];
  /** 1-based, oldest first. */
  number: number;
  /** The live round is the one not voided. */
  current: boolean;
}

/** Group rounds with their own media, oldest first. */
export function groupRounds(
  events: readonly RecordEvent[],
  media: readonly RecordMedia[],
): RecordRound[] {
  return events.map((event, i) => ({
    event,
    media: media.filter((m) => m.installEventId === event.id),
    number: i + 1,
    current: event.voided_at == null,
  }));
}

export interface TimelineRow {
  at: string;
  /** Plain sentence, already resolved to names. */
  text: string;
  kind: "work" | "block" | "redo" | "note" | "assign";
}

const END_REASON_TEXT: Record<string, string> = {
  finish: "finished",
  block: "blocked",
  break: "paused for break",
  clock_out: "clocked out",
  handoff: "handed off",
  complete: "wrapped up",
  auto_closed: "left running — auto-closed",
};

/**
 * The dispute-settler: every session and redo as a plain sentence, oldest
 * first. `nameOf` resolves profile ids ("Isaac", "Maria"); unknown ids fall
 * back to "Crew".
 */
export function buildTimeline(
  sessions: readonly UnitSession[],
  redos: readonly UnitRedo[],
  nameOf: (profileId: string) => string | null | undefined,
  now: number = Date.now(),
  /**
   * Wave Y: the unit's hand-overs, already worded by
   * assignmentHistory.assignmentTimelineRows. Passed in rather than fetched
   * here so this stays the pure sorter it has always been, and so the two
   * existing callers keep their three-argument call.
   */
  assignments: readonly TimelineRow[] = [],
): TimelineRow[] {
  const rows: TimelineRow[] = [...assignments];
  for (const s of sessions) {
    const who = nameOf(s.profile_id) || "Crew";
    const min = sessionMinutes(s, now);
    const role = s.role === "helper" ? " (helping)" : "";
    const rework = s.is_rework ? " — redo work" : "";
    if (!s.ended_at) {
      rows.push({
        at: s.started_at,
        kind: "work",
        text: `${who} started${role}${rework} — still on it (${min}m so far)`,
      });
      continue;
    }
    const ended = END_REASON_TEXT[s.end_reason ?? ""] ?? "stopped";
    const reason =
      s.end_reason === "block" && s.block_reason ? `: ${s.block_reason}` : "";
    rows.push({
      at: s.started_at,
      kind: s.end_reason === "block" ? "block" : "work",
      text: `${who}${role}${rework} — ${min}m, ${ended}${reason}`,
    });
  }
  for (const r of redos) {
    const who = r.presser?.display_name || nameOf(r.pressed_by) || "Crew";
    rows.push({
      at: r.pressed_at,
      kind: "redo",
      text: `${who} pressed Redo: ${r.reason}`,
    });
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The memo topics an event actually has content for, prompt + text. */
export function filledTopics(
  event: MemoTopics,
): { prompt: string; text: string }[] {
  return MEMO_TOPICS.flatMap((t) => {
    const text = event[t.key];
    return typeof text === "string" && text.trim()
      ? [{ prompt: t.prompt, text: text.trim() }]
      : [];
  });
}
