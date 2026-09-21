import { DICTATION_MAX_SECONDS } from "../../../supabase/functions/_shared/dictation";

/** Normalize MP4/AAC for speech recognition only; the original remains the
 * recording used for playback/storage. Safari can decode its own AAC locally. */
export async function speechAudio(original: Blob): Promise<Blob> {
  if (!/^audio\/(mp4|x-m4a|m4a)(;|$)/i.test(original.type)) return original;
  if (typeof OfflineAudioContext === "undefined") throw new Error("audio_conversion_unavailable");
  const context = new OfflineAudioContext(1, 1, 16000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decoded = await Promise.race([
    original.arrayBuffer().then(bytes => context.decodeAudioData(bytes)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("audio_conversion_timeout")), 10000); }),
  ]).finally(() => clearTimeout(timer));
  if (!decoded.length || decoded.duration > DICTATION_MAX_SECONDS + 1) throw new Error("recording_too_long");
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const source = decoded.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] += source[i] / decoded.numberOfChannels;
  }
  return pcmWav(samples, decoded.sampleRate);
}

export function pcmWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const word = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  word(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); word(8, "WAVE"); word(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  return new Blob([buffer], { type: "audio/wav" });
}
