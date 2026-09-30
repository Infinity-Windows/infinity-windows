import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));

import { startLiveSession, type LiveDeps, type LiveStatus } from "./liveAskSession";
import { liveAskPilotEnabled, liveStatusLine } from "./liveAskPilot";

/** A fake phone: microphone, peer connection, data channel, recorder, timers. */
function rig(opts: { exchange?: LiveDeps["exchange"]; micDelay?: Promise<void> } = {}) {
  const track = { stop: vi.fn(), kind: "audio" };
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
  const recorder = { cut: vi.fn(async () => new Blob([`seg-${++segment}`], { type: "audio/webm" })), stop: vi.fn() };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
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
  };
  const statuses: [LiveStatus, string | undefined][] = [];
  const handleTurn = vi.fn(async (turn: { itemId: string; audio: Blob | null }) => `RESULT for ${turn.itemId} (${turn.audio ? await turn.audio.text() : "no audio"})`);
  const emit = (event: object) => channel.onmessage?.({ data: JSON.stringify(event) });
  const connect = (state: string) => { pc.connectionState = state; pc.onconnectionstatechange?.(); };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const session = startLiveSession({ deps, onStatus: (s, d) => statuses.push([s, d]), handleTurn, notHeard: () => "NOT HEARD" });
  return { session, track, channel, pc, recorder, timers, played, exchange, sent, statuses, handleTurn, emit, connect, flush };
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
    // Nothing after the end reopens it.
    r.emit(started);
    r.connect("connected");
    expect(r.statuses.at(-1)).toEqual(["ended", "user"]);
  });

  it("ends at the session cap", async () => {
    const r = rig();
    await r.flush();
    const cap = r.timers.find((t) => t.ms === 180_000)!;
    cap.fn();
    expect(r.statuses.at(-1)).toEqual(["ended", "cap"]);
    expect(r.track.stop).toHaveBeenCalled();
    expect(JSON.parse(r.sent.at(-1)!)).toEqual({ type: "session.close" });
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

describe("liveAskPilot", () => {
  it("is off unless the build turns it on", () => {
    expect(liveAskPilotEnabled({})).toBe(false);
    expect(liveAskPilotEnabled({ VITE_LIVE_ASK_PILOT: "1" })).toBe(false);
    expect(liveAskPilotEnabled({ VITE_LIVE_ASK_PILOT: "true" })).toBe(true);
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
