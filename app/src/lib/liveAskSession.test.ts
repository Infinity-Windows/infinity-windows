import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));

import { mediaSegmentRecorder, startLiveSession, type LiveDeps, type LiveStatus } from "./liveAskSession";
import { canContinueLive, liveAskPilotEnabled, liveStatusLine } from "./liveAskPilot";

/** A fake phone: microphone, peer connection, data channel, recorder, timers. */
function rig(opts: { exchange?: LiveDeps["exchange"]; micDelay?: Promise<void> } = {}) {
  const track = { stop: vi.fn(), kind: "audio", enabled: true };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const sent: string[] = [];
  const channel = {
    readyState: "open", send: (s: string) => sent.push(s), close: vi.fn(),
    onmessage: null as null | ((m: { data: string }) => void), onclose: null as null | (() => void),
  };
  const pc = {
    connectionState: "new", addTrack: vi.fn(), close: vi.fn(), getSenders: () => [{ track }],
    iceGatheringState: "complete", localDescription: { sdp: "v=0 offer" },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}),
    onconnectionstatechange: null as null | (() => void), ontrack: null as null | ((e: unknown) => void),
  };
  let segment = 0;
  const recorder = {
    cut: vi.fn(async () => new Blob([`seg-${++segment}`], { type: "audio/webm" })),
    finish: vi.fn(async () => new Blob([`seg-${++segment}`], { type: "audio/webm" })),
    stop: vi.fn(),
  };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let hidden: (() => void) | null = null;
  const played: (MediaStream | null)[] = [];
  const exchange = vi.fn(opts.exchange ?? (async () => ({ sdp: "v=0 answer", maxSeconds: 180 })));
  const deps: LiveDeps = {
    getMicrophone: async () => { await opts.micDelay; return stream; },
    createPeer: () => ({ pc: pc as unknown as RTCPeerConnection, channel: channel as unknown as RTCDataChannel }),
    exchange,
    recorder: () => recorder,
    playRemote: (s) => { played.push(s); },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    watchPageHidden: (fn) => { hidden = fn; return () => { hidden = null; }; },
  };
  const statuses: [LiveStatus, string | undefined][] = [];
  const handleTurn = vi.fn(async (turn: { itemId: string; audio: Blob | null }) => `RESULT for ${turn.itemId} (${turn.audio ? await turn.audio.text() : "no audio"})`);
  const interrupted: Blob[] = [];
  const interruptErrors: string[] = [];
  const emit = (event: object) => channel.onmessage?.({ data: JSON.stringify(event) });
  const connect = (state: string) => { pc.connectionState = state; pc.onconnectionstatechange?.(); };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const session = startLiveSession({ deps, onStatus: (s, d) => statuses.push([s, d]), handleTurn,
    onInterruptedAudio: (audio) => { void audio.then((blob) => { if (blob) interrupted.push(blob); }).catch((error) => interruptErrors.push(String(error))); },
    notHeard: () => "NOT HEARD" });
  return { session, track, channel, pc, recorder, timers, played, exchange, sent, statuses, handleTurn, interrupted, interruptErrors, emit, connect, flush, hide: () => hidden?.() };
}

const started = { type: "session.started", session: { id: "live-test" } };
const delegation = (id: string) => ({ type: "session.delegation.created", delegation: { id, metadata: {} } });

describe("startLiveSession", () => {
  it("exchanges SDP through our server, never with a key on the phone, and reports live", async () => {
    const r = rig();
    await r.flush();
    expect(r.exchange).toHaveBeenCalledWith("v=0 offer", expect.any(AbortSignal));
    expect(r.pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });
    r.emit(started);
    r.connect("connected");
    expect(r.statuses.at(-1)).toEqual(["live", undefined]);
  });

  it("cuts one audio segment per delegation and returns Ask's result once", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    r.connect("connected");
    r.emit(delegation("d1"));
    r.emit(delegation("d1")); // replay
    await r.flush();
    expect(r.handleTurn).toHaveBeenCalledTimes(1);
    expect(r.sent).toHaveLength(1);
    expect(JSON.parse(r.sent[0])).toEqual({ type: "session.commentary.append", delegation_id: "d1", content: "RESULT for d1 (seg-1)" });
  });

  it("runs Ask requests one at a time, in the order they were said", async () => {
    const r = rig();
    await r.flush();
    let release!: () => void;
    const order: string[] = [];
    r.handleTurn.mockImplementationOnce(async (t) => { order.push(`start ${t.itemId}`); await new Promise<void>((res) => { release = res; }); order.push(`end ${t.itemId}`); return "A"; });
    r.handleTurn.mockImplementationOnce(async (t) => { order.push(`start ${t.itemId}`); return "B"; });
    r.emit(started);
    r.emit(delegation("one"));
    r.emit(delegation("two"));
    await r.flush();
    expect(order).toEqual(["start one"]);
    // Both segments were cut at delegation, before the Ask queue got there.
    expect(r.recorder.cut).toHaveBeenCalledTimes(2);
    release();
    await r.flush();
    expect(order).toEqual(["start one", "end one", "start two"]);
  });

  it("does not invent a recording if a delegation arrives before session.started", async () => {
    const r = rig();
    await r.flush();
    r.emit(delegation("d1"));
    await r.flush();
    expect(r.handleTurn).toHaveBeenCalledWith({ itemId: "d1", audio: null });
  });

  it("End stops recording, requests a graceful close, then releases the connection after final usage", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    r.connect("connected");
    r.session.end("user");
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.recorder.stop).toHaveBeenCalled();
    expect(JSON.parse(r.sent.at(-1)!)).toEqual({ type: "session.close" });
    expect(r.channel.close).not.toHaveBeenCalled();
    r.emit({ type: "session.closed", usage: { seconds: 16 } });
    expect(r.channel.close).toHaveBeenCalled();
    expect(r.pc.close).toHaveBeenCalled();
    expect(r.played.at(-1)).toBeNull();
    expect(r.timers.every((t) => !t.live)).toBe(true);
    expect(r.statuses.at(-1)).toEqual(["ended", "user"]);
    expect(r.recorder.finish).not.toHaveBeenCalled();
    expect(r.interrupted).toHaveLength(0);
    // Nothing after the end reopens it.
    r.emit(started);
    r.connect("connected");
    expect(r.statuses.at(-1)).toEqual(["ended", "user"]);
  });

  it("ends at the session cap", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    const cap = r.timers.find((t) => t.ms === 180_000)!;
    cap.fn();
    expect(r.statuses.at(-1)).toEqual(["ended", "cap"]);
    expect(r.track.stop).toHaveBeenCalled();
    expect(JSON.parse(r.sent.at(-1)!)).toEqual({ type: "session.close" });
    await r.flush();
    expect(r.recorder.stop).toHaveBeenCalled();
    expect(r.recorder.finish).not.toHaveBeenCalled();
    expect(r.interrupted).toHaveLength(0);
  });

  it("mutes the same microphone without ending or reconnecting the paid session", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    r.session.setMuted(true);
    expect(r.session.muted).toBe(true);
    expect(r.track.enabled).toBe(false);
    expect(r.session.status).toBe("live");
    expect(r.exchange).toHaveBeenCalledTimes(1);
    r.session.setMuted(false);
    expect(r.track.enabled).toBe(true);
    r.session.end();
    expect(r.track.stop).toHaveBeenCalled();
  });

  it("closes the microphone and provider session before a phone backgrounds", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    r.hide();
    expect(r.statuses.at(-1)).toEqual(["ended", "background"]);
    expect(r.track.stop).toHaveBeenCalled();
    expect(JSON.parse(r.sent.at(-1)!)).toEqual({ type: "session.close" });
    r.hide();
    expect(r.sent).toHaveLength(1);
  });

  it("rides out a blip, and ends (no paid auto-reconnect) when the connection fails", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    r.connect("connected");
    r.connect("disconnected");
    expect(r.statuses.at(-1)?.[0]).toBe("unstable");
    r.connect("connected");
    expect(r.statuses.at(-1)?.[0]).toBe("live");
    r.connect("failed");
    expect(r.statuses.at(-1)).toEqual(["failed", "connection"]);
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.exchange).toHaveBeenCalledTimes(1);
    expect(r.recorder.finish).toHaveBeenCalledOnce();
    await r.flush();
    expect(await r.interrupted[0].text()).toBe("seg-1");
    expect(r.handleTurn).not.toHaveBeenCalled();
    r.connect("failed");
    expect(r.interrupted).toHaveLength(1);
  });

  it("reports a final-recorder failure while still closing the microphone", async () => {
    const r = rig();
    await r.flush();
    r.emit(started);
    r.recorder.finish.mockImplementationOnce(() => { throw new Error("final chunk unavailable"); });
    r.connect("failed");
    await r.flush();
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.statuses.at(-1)).toEqual(["failed", "connection"]);
    expect(r.interruptErrors).toEqual(["Error: final chunk unavailable"]);
  });

  it("releases the microphone when the server refuses, with the server's reason", async () => {
    const r = rig({ exchange: async () => { throw new Error("live_not_configured"); } });
    await r.flush();
    expect(r.statuses.at(-1)).toEqual(["failed", "live_not_configured"]);
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.pc.close).toHaveBeenCalled();
  });

  it("an end while the microphone permission is pending still releases it", async () => {
    let grant!: () => void;
    const r = rig({ micDelay: new Promise<void>((res) => { grant = res; }) });
    r.session.end("account");
    grant();
    await r.flush();
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.exchange).not.toHaveBeenCalled();
    expect(r.statuses).toEqual([["ended", "account"]]);
  });
});

describe("mediaSegmentRecorder", () => {
  it("delivers the final chunk after stopping without opening another recorder", async () => {
    const instances: FakeRecorder[] = [];
    class FakeRecorder {
      static isTypeSupported() { return false; }
      state: "inactive" | "recording" = "inactive";
      mimeType = "audio/mp4";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      constructor() { instances.push(this); }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob([`part-${instances.indexOf(this) + 1}`], { type: this.mimeType }) } as BlobEvent);
          this.onstop?.(new Event("stop"));
        });
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    try {
      const recorder = mediaSegmentRecorder({} as MediaStream);
      const first = await recorder.cut();
      expect(await first?.text()).toBe("part-1");
      const last = await recorder.finish();
      expect(await last?.text()).toBe("part-2");
      expect(instances).toHaveLength(2);
      expect(await recorder.finish()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("liveAskPilot", () => {
  it("offers a deliberate continuation only after recoverable stops", () => {
    expect(canContinueLive("ended", "cap")).toBe(true);
    expect(canContinueLive("ended", "background")).toBe(true);
    expect(canContinueLive("failed", "connection")).toBe(true);
    expect(canContinueLive("ended", "account")).toBe(false);
    expect(canContinueLive("ended", "user")).toBe(false);
    expect(canContinueLive("failed", "live_limit")).toBe(false);
  });
  it("exposes the owner pilot in production, with a build-time stop switch", () => {
    expect(liveAskPilotEnabled({})).toBe(false);
    expect(liveAskPilotEnabled({ VITE_LIVE_ASK_PILOT: "1" })).toBe(false);
    expect(liveAskPilotEnabled({ VITE_LIVE_ASK_PILOT: "true" })).toBe(true);
    expect(liveAskPilotEnabled({ PROD: true })).toBe(true);
    expect(liveAskPilotEnabled({ PROD: true, VITE_LIVE_ASK_PILOT: "false" })).toBe(false);
  });

  it("explains every way a session ends, in English and Spanish", () => {
    expect(liveStatusLine(false, "failed", "live_not_configured")).toMatch(/isn't turned on/);
    expect(liveStatusLine(true, "failed", "live_limit")).toMatch(/límite/);
    expect(liveStatusLine(false, "ended", "account")).toMatch(/account changed/);
    expect(liveStatusLine(false, "ended", "cap")).toMatch(/time limit/);
    expect(liveStatusLine(true, "unstable")).toMatch(/recuperarla/);
    expect(liveStatusLine(false, "failed", "anything_else")).toMatch(/Tap Start to try again/);
  });
});
