import { supabase } from "./supabase";
import type { Lang } from "./i18n";
import { speechAudio } from "./voiceAudio";
import { voiceFilename } from "./voiceRecording";
export const TRANSCRIPTION_TIMEOUT_MS = 45_000;

export function appendDictation(current: string, transcript: string, multiline: boolean, maxLength = -1): string | null {
  const words = multiline ? transcript.trim() : transcript.trim().replace(/\s+/g, " ");
  const result = current ? `${current}${/\s$/.test(current) ? "" : multiline ? "\n" : " "}${words}` : words;
  return maxLength >= 0 && result.length > maxLength ? null : result;
}

export async function transcribeDescription(audio: Blob, lang: Lang, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("recording_canceled");
  if (!navigator.onLine) throw new Error("offline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new Error("recording_canceled")); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error("transcription_timeout")); }, TRANSCRIPTION_TIMEOUT_MS);
  });
  const run = async () => {
    const ready = await speechAudio(audio);
    if (controller.signal.aborted) throw new Error("recording_canceled");
    const body = new FormData();
    body.append("audio", ready, voiceFilename(ready, "description"));
    body.append("language", lang);
    const { data, error } = await supabase.functions.invoke("transcribe-description", { body, signal: controller.signal });
    if (error) {
      let code = "transcription_failed";
      if (error.context instanceof Response) {
        const payload = await error.context.json().catch(() => null);
        if (typeof payload?.error === "string") code = payload.error;
      }
      throw new Error(code);
    }
    if (typeof data?.text !== "string") throw new Error("transcription_failed");
    return data.text;
  };
  // Keep the deadline through response-body parsing, not only until headers arrive.
  return await Promise.race([run(), deadline]).finally(() => {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener("abort", cancel);
  });
}
