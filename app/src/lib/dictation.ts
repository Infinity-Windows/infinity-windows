import { supabase } from "./supabase";
import type { Lang } from "./i18n";

export function appendDictation(current: string, transcript: string, multiline: boolean, maxLength = -1): string | null {
  const words = multiline ? transcript.trim() : transcript.trim().replace(/\s+/g, " ");
  const result = current ? `${current}${/\s$/.test(current) ? "" : multiline ? "\n" : " "}${words}` : words;
  return maxLength >= 0 && result.length > maxLength ? null : result;
}

export async function transcribeDescription(audio: Blob, lang: Lang, signal: AbortSignal): Promise<string> {
  const body = new FormData();
  body.append("audio", audio, "description");
  body.append("language", lang);
  const { data, error } = await supabase.functions.invoke("transcribe-description", { body, signal });
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
}
