// Six MiB fits three minutes of mono 16 kHz PCM when Safari AAC is normalized.
// Shared short-recording limits; retention is handled by the calling workflow.
export const DICTATION_MAX_BYTES = 6 * 1024 * 1024;
export const DICTATION_MAX_SECONDS = 180;
export const DICTATION_AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/ogg": "ogg",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
};
export function dictationExtension(mime: string): string | null {
  return DICTATION_AUDIO_TYPES[mime.split(";")[0].trim().toLowerCase()] ?? null;
}

/** Bound bytes even when Content-Length is missing or untrusted. */
export async function readDictationBody(req: Request): Promise<ArrayBuffer> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("empty_audio");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > DICTATION_MAX_BYTES + 16_384) {
        await reader.cancel();
        throw new Error("audio_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data.buffer;
}
