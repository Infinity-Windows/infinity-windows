import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("./supabase", () => ({ supabase: { functions: { invoke } } }));
import { transcribeDescription, TRANSCRIPTION_TIMEOUT_MS } from "./dictation";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe("bounded transcription requests", () => {
  it("times out a stalled connection, aborts it and leaves the caller's audio reusable", async () => {
    vi.useFakeTimers(); vi.stubGlobal("navigator", { onLine: true });
    invoke.mockImplementation(() => new Promise(() => {}));
    const audio = new Blob(["recorded speech"], {type:"audio/mp4"});
    const result = transcribeDescription(audio,"en",new AbortController().signal);
    const rejection = expect(result).rejects.toThrow("transcription_timeout");
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_TIMEOUT_MS); await rejection;
    expect(invoke.mock.calls[0][1].signal.aborted).toBe(true);
    invoke.mockResolvedValue({data:{text:"Installed four windows."},error:null});
    await expect(transcribeDescription(audio,"en",new AbortController().signal)).resolves.toContain("four windows");
    expect(invoke.mock.calls[1][1].body.get("audio").name).toBe("description.mp4");
  });
  it("cancels an in-flight request promptly even if the transport does not reject", async () => {
    vi.stubGlobal("navigator", { onLine: true }); invoke.mockImplementation(() => new Promise(() => {}));
    const cancel = new AbortController(); const request = transcribeDescription(new Blob(["x"]),"es",cancel.signal);
    cancel.abort(); await expect(request).rejects.toThrow("recording_canceled");
  });
  it("never sends a recording canceled before transcription starts", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const cancel = new AbortController(); cancel.abort();
    await expect(transcribeDescription(new Blob(["x"]), "en", cancel.signal)).rejects.toThrow("recording_canceled");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not attempt an upload when the device is known to be offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(transcribeDescription(new Blob(["x"]),"en",new AbortController().signal)).rejects.toThrow("offline");
    expect(invoke).not.toHaveBeenCalled();
  });
});
