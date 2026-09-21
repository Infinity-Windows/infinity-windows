import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, dictationExtension } from "../../../supabase/functions/_shared/dictation";

export interface VoiceRecording { stop: () => void; cancel: () => void }
let active: symbol | null = null;
export function voiceFilename(blob: Blob, name = "memo") {
  return `${name}.${dictationExtension(blob.type) ?? "webm"}`;
}

/** Wait for the recorder's final data event BEFORE stopping the mic. Safari
 * emits its last MP4 chunk asynchronously after stop(). Every exit releases it. */
export async function startVoiceRecording(options: {
  signal: AbortSignal;
  onComplete: (blob: Blob) => void;
  onError: (error: Error) => void;
  onSeconds?: (seconds: number) => void;
}): Promise<VoiceRecording> {
  if (active) throw new Error("microphone_busy");
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    throw new Error("microphone_unsupported");
  if (options.signal.aborted) throw new Error("recording_canceled");
  const owner = Symbol("voice"); active = owner;
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let canceled = false, finished = false;
  const release = () => {
    clearInterval(timer);
    stream?.getTracks().forEach(track => track.stop());
    options.signal.removeEventListener("abort", cancel);
    if (active === owner) active = null;
  };
  const cancel = () => {
    canceled = true;
    if (recorder?.state === "recording") recorder.stop();
    release();
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (canceled || options.signal.aborted) { release(); throw new Error("recording_canceled"); }
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
    try { recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64_000 }); }
    catch { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    const rec = recorder, chunks: Blob[] = []; let bytes = 0;
    rec.ondataavailable = event => {
      if (canceled || finished) return;
      if (event.data.size) { chunks.push(event.data); bytes += event.data.size; }
      if (bytes > DICTATION_MAX_BYTES && rec.state === "recording") rec.stop();
    };
    rec.onstop = () => {
      if (finished) return;
      finished = true; release();
      if (canceled) return;
      if (!bytes || bytes > DICTATION_MAX_BYTES) { options.onError(new Error(bytes ? "audio_too_large" : "empty_audio")); return; }
      options.onComplete(new Blob(chunks, { type: rec.mimeType || chunks[0]?.type || mime || "audio/webm" }));
    };
    rec.onerror = () => {
      if (finished || canceled) return;
      finished = true;
      if (rec.state === "recording") rec.stop();
      release(); options.onError(new Error("recording_failed"));
    };
    rec.start(500);
    const started = Date.now();
    timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      options.onSeconds?.(seconds);
      if (seconds >= DICTATION_MAX_SECONDS && rec.state === "recording") rec.stop();
    }, 250);
    return { stop: () => { if (rec.state === "recording") rec.stop(); }, cancel };
  } catch (error) { release(); throw error; }
}
