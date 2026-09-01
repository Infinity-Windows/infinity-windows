// Training videos in Learn (owner spec, 2026-08-13): supervisors title the
// window type they're teaching, upload the video (or hyperlink YouTube),
// and author TWO transcripts — the summary for reviewing the video, and
// the full text to read along. Installers watch and read.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

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
}

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
}): Promise<LearningVideo> {
  const { data, error } = await supabase.rpc("save_learning_video", {
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
  });
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
