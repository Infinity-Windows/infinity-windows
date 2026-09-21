import { afterEach, describe, expect, it, vi } from "vitest";
import { startVoiceRecording, voiceFilename } from "./voiceRecording";
const stopTrack = vi.fn();
const recordings: Recorder[] = [];
class Recorder {
  static isTypeSupported(type: string) { return type === "audio/mp4"; }
  mimeType = "audio/mp4"; state = "inactive";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void; onerror?: () => void;
  constructor() { recordings.push(this); }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
  finish(bytes = "final mp4 chunk") {
    this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const controllers: AbortController[] = [];
function setup(getUserMedia = async () => ({ getTracks: () => [{ stop: stopTrack }] })) {
  stopTrack.mockClear();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", Recorder);
  const abort = new AbortController(); controllers.push(abort);
  const onComplete = vi.fn(), onError = vi.fn();
  return { abort, onComplete, onError, start: () => startVoiceRecording({ signal: abort.signal, onComplete, onError }) };
}
afterEach(() => { controllers.splice(0).forEach(c => c.abort()); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("voice recorder lifecycle", () => {
  it("waits for the final Safari chunk before releasing the mic and returning audio", async () => {
    const h = setup(), rec = await h.start(); rec.stop();
    expect(stopTrack).not.toHaveBeenCalled(); expect(h.onComplete).not.toHaveBeenCalled();
    recordings.at(-1)!.finish();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(await h.onComplete.mock.calls[0][0].text()).toBe("final mp4 chunk");
    expect(voiceFilename(h.onComplete.mock.calls[0][0])).toBe("memo.mp4");
    recordings.at(-1)!.onstop?.(); expect(h.onComplete).toHaveBeenCalledOnce();
  });
  it("does not save a canceled clip", async () => {
    const h = setup(), rec = await h.start(); rec.cancel(); recordings.at(-1)!.finish();
    expect(h.onComplete).not.toHaveBeenCalled(); expect(stopTrack).toHaveBeenCalled();
  });
  it("releases a microphone granted after its form was closed", async () => {
    let resolve!: (s: {getTracks: () => {stop: typeof stopTrack}[]}) => void;
    const h = setup(() => new Promise(r => { resolve = r; }));
    const pending = h.start(); h.abort.abort();
    resolve({getTracks: () => [{stop: stopTrack}]});
    await expect(pending).rejects.toThrow("recording_canceled");
    expect(stopTrack).toHaveBeenCalled();
    const next = setup(); await next.start();
  });
  it("reports empty capture instead of uploading an unusable recording", async () => {
    const h = setup(); await h.start(); recordings.at(-1)!.finish("");
    expect(h.onComplete).not.toHaveBeenCalled(); expect(h.onError.mock.calls[0][0].message).toBe("empty_audio");
  });
  it("stops after three minutes but still includes the final chunk", async () => {
    vi.useFakeTimers(); const h = setup(); await h.start();
    await vi.advanceTimersByTimeAsync(180000);
    expect(recordings.at(-1)!.state).toBe("inactive"); recordings.at(-1)!.finish();
    expect(h.onComplete).toHaveBeenCalledOnce();
  });
  it("does not let a second form take over an active microphone", async () => {
    const h = setup(); await h.start();
    await expect(startVoiceRecording({signal:new AbortController().signal,onComplete:vi.fn(),onError:vi.fn()})).rejects.toThrow("microphone_busy");
  });
});
