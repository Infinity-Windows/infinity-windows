// The unit Record (CONTEXT.md): the full story of one unit, read back from
// the atoms the field already saves — install rounds (voided included),
// their media, the session timeline, redos, the flashing photo. Nothing here
// is stored FOR the record; it is a reading. Raw facts show to every role;
// anything that compares stays foreman+ (that gate lives in the UI).

import { supabase } from "../supabase";
import type { MemoTopics } from "./types";
import { MEMO_TOPICS } from "./types";
import { sessionMinutes, type UnitRedo, type UnitSession } from "./sessions";

/** One install round: an install_events row with everything worth reading. */
export interface RecordEvent extends MemoTopics {
  id: string;
  created_at: string;
  started_at: string | null;
  installer: string | null;
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
  const { data, error } = await supabase
    .from("install_events")
    .select(
      `id, created_at, started_at, installer, minutes, quality_grade, transcript_raw, photo_findings, voided_at, void_reason, ${memoCols}, voider:voided_by(display_name)`,
    )
    .eq("project_opening_id", openingId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as RecordEvent[];
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
  kind: "work" | "block" | "redo" | "note";
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
): TimelineRow[] {
  const rows: TimelineRow[] = [];
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
