// Training videos in Learn (owner spec, 2026-08-13): supervisors title the
// window type they're teaching, upload the video (or hyperlink YouTube),
// and author TWO transcripts — the summary for reviewing the video, and
// the full text to read along. Installers watch and read.

import { supabase } from "./supabase";
import { isMissingFunction, isMissingTable } from "./schemaErrors";

/**
 * Wave U: where a lesson is in its life. A supervisor builds it as a `draft`
 * — the link is in, the transcript or the quiz is not — and `published` is the
 * deliberate tap that lets crews see it.
 */
export type VideoStatus = "draft" | "published";

export interface LearningVideo {
  id: string;
  title: string;
  window_type_id: string | null;
  topic: string | null;
  video_path: string | null;
  youtube_url: string | null;
  summary: string | null;
  transcript: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Wave Q: the window type a PASSING quiz on this video clears the
   * installer for. Null means the video teaches without gating any work. */
  grants_clearance: string | null;
  /**
   * Wave U. OPTIONAL on purpose: Learn has to load on a phone whose database
   * has not had 20260984000000 applied yet, and a row from that database
   * carries no status at all. `videoStatus()` below is the one place that
   * decides what an absent status means (published — it was visible
   * yesterday, so it stays visible today).
   */
  status?: VideoStatus | string | null;
}

/**
 * A row's state, with the pre-migration answer folded in. PURE — unit-tested.
 *
 * Anything that is not literally 'draft' reads as published: an absent column,
 * a null, or a value some future writer invents. Erring toward published is
 * the safe direction here, because the failure mode of the other choice is the
 * whole Learn library going blank on a crew's phone the day a frontend deploy
 * lands ahead of its migration.
 */
export function videoStatus(video: Pick<LearningVideo, "status">): VideoStatus {
  return video.status === "draft" ? "draft" : "published";
}

/**
 * Split the library into what a supervisor still has to finish and what crews
 * can see. PURE — unit-tested.
 *
 * Row-level security already keeps drafts away from a crew login, so this is
 * belt and braces rather than the lock — but it is what draws the Inbox, and a
 * client that filtered nothing would show a draft to anybody whose read
 * somehow returned one.
 */
export function partitionLearningVideos(
  videos: LearningVideo[],
  canAuthor: boolean,
): { inbox: LearningVideo[]; published: LearningVideo[] } {
  const published = videos.filter((v) => videoStatus(v) === "published");
  if (!canAuthor) return { inbox: [], published };
  return { inbox: videos.filter((v) => videoStatus(v) === "draft"), published };
}

/**
 * Every lesson the caller may read.
 *
 * Deliberately NOT filtered by status server-side: the "crew read" policy
 * (20260984000000) already answers a crew login with published rows only, and
 * a `.eq("status", …)` here would be the one thing in this read that breaks
 * outright against a database that has not had the column yet.
 */
export async function listLearningVideos(): Promise<LearningVideo[]> {
  const { data, error } = await supabase
    .from("learning_videos")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error, "learning_videos")) return [];
    throw error;
  }
  return (data ?? []) as LearningVideo[];
}

export async function saveLearningVideo(input: {
  id?: string | null;
  title: string;
  windowTypeId?: string | null;
  topic?: string | null;
  videoPath?: string | null;
  youtubeUrl?: string | null;
  summary?: string | null;
  transcript?: string | null;
  active?: boolean;
  grantsClearance?: string | null;
  /** Wave U: omitted means "leave it where it is" — the server keeps a
   * published lesson published and a draft a draft. Publishing is its own tap
   * (publishLearningVideo). */
  status?: VideoStatus | null;
}): Promise<LearningVideo> {
  const args: Record<string, unknown> = {
    p_id: input.id ?? null,
    p_title: input.title,
    p_window_type: input.windowTypeId ?? null,
    p_topic: input.topic ?? null,
    p_video_path: input.videoPath ?? null,
    p_youtube_url: input.youtubeUrl ?? null,
    p_summary: input.summary ?? null,
    p_transcript: input.transcript ?? null,
    p_active: input.active ?? true,
    p_grants_clearance: input.grantsClearance ?? null,
    p_status: input.status ?? null,
  };
  const { data, error } = await supabase.rpc("save_learning_video", args);
  if (!error) return data as LearningVideo;
  // A database that still has the ten-argument version of this RPC answers
  // "no function matches" rather than refusing the caller. Drop the new
  // argument and save anyway: a supervisor should not lose their typing
  // because the frontend deployed before the migration did.
  if (!isMissingFunction(error)) throw error;
  delete args.p_status;
  const retry = await supabase.rpc("save_learning_video", args);
  if (retry.error) throw retry.error;
  return retry.data as LearningVideo;
}

/** One tap on a draft: crews can see it from now on. Supervisor+ (enforced in
 * SQL, not here). */
export async function publishLearningVideo(id: string): Promise<LearningVideo> {
  const { data, error } = await supabase.rpc("publish_learning_video", { p_id: id });
  if (error) throw error;
  return data as LearningVideo;
}

/** Upload a lesson video; returns the storage path for save_learning_video. */
export async function uploadLearningVideo(file: File): Promise<string> {
  const clean = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const path = `${crypto.randomUUID()}-${clean}`;
  const { error } = await supabase.storage
    .from("learning-videos")
    .upload(path, file, { contentType: file.type || "video/mp4" });
  if (error) throw error;
  return path;
}

/** Hour-long signed URL for an uploaded lesson. */
export async function learningVideoUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from("learning-videos")
    .createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Every address a supervisor will realistically paste → the embeddable
 * player URL, or null when it isn't YouTube. PURE — unit-tested.
 *
 *   https://www.youtube.com/watch?v=ID&t=42
 *   https://youtu.be/ID?si=…
 *   https://www.youtube.com/shorts/ID
 *   https://www.youtube.com/embed/ID
 */
export function youtubeEmbedUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text.startsWith("http") ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1).split("/")[0] || null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
      id = m ? m[1] : null;
    }
  }
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}
