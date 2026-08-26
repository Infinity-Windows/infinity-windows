// Warehouse sounds (pick 29): two Web-Audio-generated tones, no audio files
// to bundle or license — a soft short tick for success, a flat double-buzz
// for refusal. Off by default; the one Settings toggle ("Warehouse sounds")
// persists the choice in localStorage.
//
// Autoplay policy: browsers block audio that starts with no preceding user
// gesture. Every call site here already fires from inside a gesture-rooted
// handler (a scan, a check-in tap, an arrival submit) — none of them are
// wired to run on mount or off a timer/realtime event — so that rule is
// satisfied by construction. The one extra bit of care an AudioContext needs
// beyond a plain <audio> tag: some browsers still hand back a `suspended`
// context even when it was constructed during a gesture, and a suspended
// context renders total silence with no error to catch. playTone() resumes
// it every time, which is a harmless no-op once the context is already
// running.

const STORAGE_KEY = "infinity.warehouseSounds";

/** Whether the crew has turned warehouse sounds on. Off (false) by default,
 * and on any storage failure — a locked-down browser should stay silent,
 * not throw. */
export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Flip the toggle. Storage failing just means the choice won't survive a
 * reload — never a crash, same tolerance readTheme/applyTheme use. */
export function setSoundsEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no persistence, no sound — same as a fresh visit */
  }
}

let sharedCtx: AudioContext | null = null;

/** Lazily construct the ONE AudioContext this tab will ever need. Never
 * called until a sound actually plays, so nothing about page load — or even
 * flipping the Settings toggle on — so much as constructs one. */
function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/** Drop the cached context so the next sound builds a fresh one. Only real
 * caller is this module's own test suite, which stubs a new fake
 * AudioContext per test and would otherwise keep talking to the first one. */
export function resetAudioContextForTests(): void {
  sharedCtx = null;
}

/** One short sine tone, gain-enveloped so it clicks on and off instead of
 * popping. `startAt`/`freq` are in the context's own clock/units. */
function scheduleTone(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  peakGain: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Shared entry point for both tones: bail out silently unless the toggle is
 * on and Web Audio actually exists, then make sure the context is running
 * before scheduling anything (see the autoplay-policy note up top). */
function playIfEnabled(schedule: (ctx: AudioContext, now: number) => void): void {
  if (!soundsEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  schedule(ctx, ctx.currentTime);
}

/** Soft short tick — success (tailgate arrive, store, scan-resolve). */
export function playSuccessTone(): void {
  playIfEnabled((ctx, now) => scheduleTone(ctx, 880, now, 0.07, 0.15));
}

/** Flat double-buzz — refusal (tailgate arrive, store). Same low tone twice,
 * a beat apart, so it reads as "no" rather than "a low version of yes". */
export function playErrorTone(): void {
  playIfEnabled((ctx, now) => {
    scheduleTone(ctx, 220, now, 0.09, 0.18);
    scheduleTone(ctx, 220, now + 0.12, 0.09, 0.18);
  });
}
