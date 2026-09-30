import { supabase } from "./supabase";
import { commentaryEvent, readLiveEvent } from "./liveAskProtocol";
import { DICTATION_MAX_SECONDS } from "../../../supabase/functions/_shared/dictation";

/**
 * Live Ask: a spoken conversation over WebRTC, microphone in and speaker out,
 * with every factual or operational turn answered by Ask's ordinary send path.
 *
 * Who holds what:
 *  - The OpenAI key never reaches the phone. The phone sends its SDP offer to
 *    our edge function (`live-ask-session`), which checks the caller, books
 *    the session against the AI spend guard and exchanges the SDP with the
 *    provider. The phone only ever gets the SDP answer back.
 *  - The voice model knows nothing about the business. On each delegation we
 *    cut the microphone recording immediately. The page saves that exact
 *    segment, transcribes it, and sends the resulting words through Ask as a
 *    voice request. The delegation ID deduplicates the request and binds its
 *    result to the spoken reply.
 *  - Evidence: the microphone is recorded on the phone in segments, cut when
 *    GPT-Live delegates. The next segment starts before the previous
 *    one stops, so no speech falls between them; a segment runs from the end
 *    of the last finalized turn to the end of this one, so it holds the whole
 *    utterance (plus any pause before it). The session is capped at
 *    DICTATION_MAX_SECONDS, so no segment can outgrow the memo limits.
 *
 * No automatic reconnect: every session is a booked, paid reservation. ICE is
 * allowed to recover a blip on its own ("unstable"); a failed connection ends
 * the session and the person taps Start again.
 */

export type LiveStatus = "idle" | "starting" | "live" | "unstable" | "ended" | "failed";
export type LiveEndReason = "user" | "cap" | "account" | "connection" | "error" | "unmount";

export interface LiveTurn { itemId: string; audio: Blob | null }

/** A recorder over the live microphone that hands back one segment per cut. */
export interface SegmentRecorder { cut(): Promise<Blob | null>; stop(): void }

export interface LivePeer {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
}

export interface LiveDeps {
  getMicrophone(): Promise<MediaStream>;
  createPeer(): LivePeer;
  /** Our edge function: offer SDP in, answer SDP and the session cap out. */
  exchange(offerSdp: string, signal: AbortSignal): Promise<{ sdp: string; maxSeconds: number }>;
  recorder(stream: MediaStream): SegmentRecorder;
  playRemote(stream: MediaStream | null): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface LiveOptions {
  deps?: Partial<LiveDeps>;
  onStatus(status: LiveStatus, detail?: LiveEndReason | string): void;
  /** Save the memo, then send through Ask. Resolves to the commentary to speak. */
  handleTurn(turn: LiveTurn): Promise<string>;
  /** Spoken when a delegation never matched a finished utterance. */
  notHeard(): string;
}

export interface LiveSession { end(reason?: LiveEndReason): void; readonly status: LiveStatus }

export function startLiveSession(options: LiveOptions): LiveSession {
  const deps: LiveDeps = { ...browserDeps(), ...options.deps };
  const delegations = new Set<string>();
  const abort = new AbortController();
  const timers = new Set<unknown>();
  let status: LiveStatus = "starting";
  let stream: MediaStream | null = null;
  let peer: LivePeer | null = null;
  let rec: SegmentRecorder | null = null;
  let closing = false;
  // Ask requests run one at a time, in the order they were said.
  let queue: Promise<void> = Promise.resolve();

  const set = (next: LiveStatus, detail?: LiveEndReason | string) => {
    if (status === "ended" || status === "failed") return;
    status = next;
    options.onStatus(next, detail);
  };
  const timer = (fn: () => void, ms: number) => {
    const h = deps.setTimer(() => { timers.delete(h); fn(); }, ms);
    timers.add(h);
  };
  const say = (delegationId: string, content: string) => {
    if (peer?.channel.readyState === "open") {
      try { peer.channel.send(commentaryEvent(delegationId, content)); } catch { /* channel closing: the screen has it */ }
    }
  };
  const delegate = (id: string) => {
    if (closing || status === "ended" || status === "failed") return;
    if (delegations.has(id)) return;
    delegations.add(id);
    // The cut happens when GPT-Live delegates, not after a previous Ask reply.
    const audio = rec ? rec.cut().catch(() => null) : Promise.resolve(null);
    queue = queue.then(async () => {
      let content: string;
      try { content = await options.handleTurn({ itemId: id, audio: await audio }); }
      catch { content = options.notHeard(); }
      say(id, content);
    });
  };

  const teardown = () => {
    abort.abort();
    for (const h of timers) deps.clearTimer(h);
    timers.clear();
    rec?.stop(); rec = null;
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    if (peer) {
      peer.pc.onconnectionstatechange = null; peer.pc.ontrack = null;
      peer.channel.onmessage = null; peer.channel.onclose = null;
      try { peer.channel.close(); } catch { /* already closed */ }
      try { peer.pc.getSenders().forEach((s) => s.track?.stop()); } catch { /* closed */ }
      try { peer.pc.close(); } catch { /* already closed */ }
      peer = null;
    }
    deps.playRemote(null);
  };

  const end = (reason: LiveEndReason = "user") => {
    if (status === "ended" || status === "failed") return;
    // The data channel must remain open long enough to receive the provider's
    // final session.closed and usage event. Stop the microphone immediately.
    if ((reason === "user" || reason === "cap" || reason === "account" || reason === "unmount") &&
        peer?.channel.readyState === "open") {
      closing = true;
      rec?.stop(); rec = null;
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      deps.playRemote(null);
      try { peer.channel.send(JSON.stringify({ type: "session.close" })); }
      catch { teardown(); }
      timer(teardown, 10_000);
    } else teardown();
    // Turns already cut keep going: their audio is in hand and each one is
    // checked against the signed-in account before it is saved or sent.
    set(reason === "connection" || reason === "error" ? "failed" : "ended", reason);
  };

  void (async () => {
    try {
      stream = await deps.getMicrophone();
      if (abort.signal.aborted) { teardown(); return; }
      peer = deps.createPeer();
      const { pc, channel } = peer;
      stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream!));
      pc.ontrack = (e) => deps.playRemote(e.streams[0] ?? null);
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "connected" && rec) set("live");
        else if (s === "disconnected") set("unstable");
        else if (s === "failed" || s === "closed") end("connection");
      };
      channel.onclose = () => { if (closing) teardown(); else if (status === "live" || status === "unstable") end("connection"); };
      channel.onmessage = (m) => {
        const e = readLiveEvent(m.data);
        if (e.kind === "started" && !rec && stream) { rec = deps.recorder(stream); set("live"); }
        else if (e.kind === "delegation") delegate(e.delegationId);
        else if (e.kind === "closed") { if (closing) teardown(); else end("connection"); }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // GPT-Live's WebRTC guide requires complete ICE candidates in the SDP.
      if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const timeout = deps.setTimer(() => reject(new Error("ice_timeout")), 10_000);
        const ready = () => {
          if (pc.iceGatheringState !== "complete") return;
          deps.clearTimer(timeout);
          pc.removeEventListener("icegatheringstatechange", ready);
          resolve();
        };
        pc.addEventListener("icegatheringstatechange", ready);
        ready();
      });
      const answer = await deps.exchange(pc.localDescription?.sdp ?? offer.sdp ?? "", abort.signal);
      if (abort.signal.aborted) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      const cap = Math.min(Math.max(1, answer.maxSeconds), DICTATION_MAX_SECONDS);
      timer(() => end("cap"), cap * 1000);
    } catch (e) {
      if (abort.signal.aborted) return;
      teardown();
      set("failed", e instanceof Error ? e.message : "error");
    }
  })();

  return { end, get status() { return status; } };
}

// ---------------------------------------------------------------------------
// Browser implementations
// ---------------------------------------------------------------------------

function browserDeps(): LiveDeps {
  let audio: HTMLAudioElement | null = null;
  return {
    getMicrophone: async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("live_unsupported");
      // Echo cancellation matters doubly here: the speaker is on while the
      // microphone listens, and without it the voice would hear itself.
      try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
      catch { throw new Error("microphone_permission"); }
    },
    createPeer: () => {
      const pc = new RTCPeerConnection();
      // GPT-Live's WebRTC data channel is named "oai-events".
      const channel = pc.createDataChannel("oai-events");
      return { pc, channel };
    },
    exchange: exchangeSdp,
    recorder: mediaSegmentRecorder,
    playRemote: (s) => {
      if (!s) { if (audio) { audio.pause(); audio.srcObject = null; } audio = null; return; }
      audio ??= new Audio();
      audio.autoplay = true;
      audio.srcObject = s;
      void audio.play().catch(() => undefined);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** Our edge function's refusal codes, passed up as the error message. */
export async function exchangeSdp(offerSdp: string, signal: AbortSignal): Promise<{ sdp: string; maxSeconds: number }> {
  if (!navigator.onLine) throw new Error("offline");
  const { data, error } = await supabase.functions.invoke("live-ask-session", { body: { sdp: offerSdp }, signal });
  if (error) {
    let code = "live_failed";
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      const payload = await ctx.json().catch(() => null);
      if (typeof payload?.error === "string") code = payload.error;
    }
    throw new Error(code);
  }
  if (typeof data?.sdp !== "string" || !data.sdp.startsWith("v=")) throw new Error("live_failed");
  return { sdp: data.sdp, maxSeconds: Number(data.maxSeconds) || DICTATION_MAX_SECONDS };
}

export const LIVE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

/**
 * One MediaRecorder per segment over the same microphone stream. A cut
 * starts the next recorder BEFORE stopping the current one, so the overlap
 * (a few milliseconds of audio in both) is the price of never losing any.
 * If the browser refuses a second concurrent recorder, the next starts right
 * after the stop and the gap is that handover.
 */
export function mediaSegmentRecorder(stream: MediaStream): SegmentRecorder {
  const mime = typeof MediaRecorder === "undefined" ? undefined : LIVE_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  let current: { r: MediaRecorder; chunks: Blob[] } | null = null;
  let stopped = false;
  const begin = () => {
    const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
    const seg = { r, chunks: [] as Blob[] };
    r.ondataavailable = (e) => { if (e.data.size) seg.chunks.push(e.data); };
    r.start(500);
    return seg;
  };
  const finish = (seg: { r: MediaRecorder; chunks: Blob[] }) => new Promise<Blob | null>((resolve) => {
    // Safari delivers its last MP4 chunk after stop(): wait for onstop.
    seg.r.onstop = () => resolve(seg.chunks.length ? new Blob(seg.chunks, { type: seg.r.mimeType || mime || "audio/webm" }) : null);
    if (seg.r.state === "inactive") seg.r.onstop(new Event("stop"));
    else seg.r.stop();
  });
  current = begin();
  return {
    cut: async () => {
      if (stopped || !current) return null;
      const old = current;
      try { current = begin(); }
      catch { current = null; const blob = await finish(old); if (!stopped) current = begin(); return blob; }
      return finish(old);
    },
    stop: () => {
      stopped = true;
      if (current && current.r.state !== "inactive") { current.r.onstop = null; current.r.stop(); }
      current = null;
    },
  };
}
