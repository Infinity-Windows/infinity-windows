// Voice memos whose recording landed but whose transcript did not.
//
// The transcript is not part of saving a memo: the outbox's upload handler
// files the attachments row (that is the evidence) and then asks the
// transcribe function once, best-effort. A memo that misses that ask — the
// function timed out, the phone lost signal after the upload — keeps
// `transcribed_at = null`, and this is the loop that picks it up later.
// Lived in lib/install/queue.ts until that queue was retired.

import { supabase } from "../supabase";
import { transcribeInstallAttachment } from "./transcribe";

/**
 * Re-invoke transcription for any voice memos still missing a transcript.
 * A failed/interrupted invoke is retried instead of silently lost. Returns
 * how many were retried.
 */
export async function retryTranscriptions(limit = 20): Promise<number> {
  const { data, error } = await supabase
    .from("attachments")
    .select("id")
    .eq("kind", "voice_memo")
    .is("transcribed_at", null)
    .not("install_event_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error || !data) return 0;

  let retried = 0;
  for (const row of data) {
    try {
      await transcribeInstallAttachment(row.id);
      retried++;
    } catch {
      // Stays untranscribed; picked up on the next retry.
    }
  }
  return retried;
}

/** Count voice memos still awaiting a transcript (visible status). */
export async function pendingTranscriptionCount(): Promise<number> {
  const { count, error } = await supabase
    .from("attachments")
    .select("id", { count: "exact", head: true })
    .eq("kind", "voice_memo")
    .is("transcribed_at", null)
    .not("install_event_id", "is", null);
  if (error) return 0;
  return count ?? 0;
}
