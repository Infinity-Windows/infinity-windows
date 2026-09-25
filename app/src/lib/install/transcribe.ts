import { supabase } from "../supabase";
import { speechAudio } from "../voiceAudio";

/**
 * Kick off a unit memo's transcript. `client` is the one every request goes
 * through — the read, the download and the edge-function call. The outbox
 * hands in the client bound to the memo owner's token (2026-09-25, Codex
 * review of #660, P2 #3): this runs after the memo's audio has been
 * converted, which can take seconds, and the shared client would carry
 * whoever is signed in by THEN. Left out, the shared client — for the retry
 * loop, which runs as the person signed in.
 */
export async function transcribeInstallAttachment(
  id: string,
  original?: Blob,
  client: typeof supabase = supabase,
) {
  let audio = original;
  if (!audio) {
    const { data: row, error } = await client.from("attachments").select("storage_path").eq("id", id).single();
    if (error) throw error;
    const slash = row.storage_path.indexOf("/"), bucket = row.storage_path.slice(0, slash), path = row.storage_path.slice(slash + 1);
    if (bucket !== "install-media" || slash < 1) throw new Error("Recording is unavailable.");
    const result = await client.storage.from(bucket).download(path, undefined, {signal: AbortSignal.timeout(45000)});
    if (result.error) throw result.error;
    audio = result.data;
  }
  const normalized = await speechAudio(audio);
  let body: FormData | {attachment_id: string} = {attachment_id:id};
  if (normalized !== audio) {
    body = new FormData(); body.append("attachment_id", id); body.append("transcription_audio", normalized, "memo.wav");
  }
  const result = await client.functions.invoke("transcribe-install-memo", {body, signal:AbortSignal.timeout(60000)});
  if (result.error) throw result.error;
  return result.data;
}
