import { supabase } from "../supabase";
import { speechAudio } from "../voiceAudio";

export async function transcribeInstallAttachment(id: string, original?: Blob) {
  let audio = original;
  if (!audio) {
    const { data: row, error } = await supabase.from("attachments").select("storage_path").eq("id", id).single();
    if (error) throw error;
    const slash = row.storage_path.indexOf("/"), bucket = row.storage_path.slice(0, slash), path = row.storage_path.slice(slash + 1);
    if (bucket !== "install-media" || slash < 1) throw new Error("Recording is unavailable.");
    const result = await supabase.storage.from(bucket).download(path, undefined, {signal: AbortSignal.timeout(45000)});
    if (result.error) throw result.error;
    audio = result.data;
  }
  const normalized = await speechAudio(audio);
  let body: FormData | {attachment_id: string} = {attachment_id:id};
  if (normalized !== audio) {
    body = new FormData(); body.append("attachment_id", id); body.append("transcription_audio", normalized, "memo.wav");
  }
  const result = await supabase.functions.invoke("transcribe-install-memo", {body, signal:AbortSignal.timeout(60000)});
  if (result.error) throw result.error;
  return result.data;
}
