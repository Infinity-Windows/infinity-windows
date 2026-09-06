// Learning time (owner's ask, 2026-09-05): how long somebody actually spends in
// Learn, and on what. The server stamps every second — see
// supabase/migrations/20260992000000_learning_time.sql. This file is the phone's
// half: the gate that decides when time is real, and the beat that reports it.
//
// WHAT COUNTS. Only VISIBLE, FOCUSED, ATTENDED time. `document.visibilityState`
// is 'visible', `document.hasFocus()` is true, AND somebody has touched the
// screen inside the last ten minutes or has a lesson playing. A locked phone, a
// backgrounded PWA, a tab behind another tab, a window behind the browser —
// none of them are somebody learning, and none of them send anything.
//
// The third condition is the one that is easy to leave out and the one that
// matters most. Visible and focused is the browser's answer to "is this window
// on top", not to "is anybody there": a Learn tab parked on a second monitor
// all day is both, and it is nobody. The server cannot save us from that
// either, because a parked tab produces exactly the real seconds its clamps
// allow. See IDLE_MS below. That is the whole difference between a timer that
// measures study and one that measures leaving a page open.
//
// NO OUTBOX, DELIBERATELY. Every other write in this app that a person could
// lose queues offline (install captures, punches, photos). Learning time does
// not, for two reasons. First, it is a MEASURE, not a record: nobody is owed
// anything by it, no gate opens on it, and a lost beat costs fifteen seconds
// out of a number nobody reads to the second. Second, an outbox would replay
// beats hours later with the phone's own idea of when they happened, which is
// exactly the thing the server-stamped clamp exists to refuse. A failed beat is
// dropped, silently, and the next one carries on.
//
// A PHONE AHEAD OF THE MIGRATION never errors here: a missing function is
// caught like every other "the database has not got this yet" case in the app
// (lib/schemaErrors.ts), and the whole Learn section keeps working with nothing
// recorded.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

/** The five places of Learn this app records time for. Mirrors the SQL check. */
export type LearningItemKind = "tab" | "term" | "quiz" | "sequence" | "video";

/** One beat every 15 seconds of visible, focused time. */
export const HEARTBEAT_MS = 15_000;

/**
 * The visit id. Minted once per page load and thrown away with the page, so one
 * value means "this person, this open tab" — which is what makes a row per
 * visit possible, and what "times watched" counts one table down.
 *
 * Module scope rather than React state on purpose: every hook on the page has
 * to agree about which visit it is, including ones that mount and unmount as
 * tabs change.
 */
let sessionId: string | null = null;

export function learningSessionId(): string {
  if (!sessionId) sessionId = crypto.randomUUID();
  return sessionId;
}

/** Test seam: forget the visit, as a fresh page load would. */
export function resetLearningSession(): void {
  sessionId = null;
}

/**
 * Send one beat. Best effort: every failure is swallowed, including a database
 * that has not had the migration yet.
 *
 * Exported for the hook and for tests; nothing else should call it directly —
 * a caller that beat on its own cadence would be reporting time nobody was
 * looking at.
 */
export async function sendLearningHeartbeat(
  kind: LearningItemKind,
  key: string,
  seconds: number,
): Promise<void> {
  try {
    // The result is deliberately not inspected. Every outcome — a refusal, a
    // database without the function yet, no signal at all — has the same
    // answer: drop it. A beat is never worth a toast, a retry, or a crash on a
    // screen somebody is trying to read. See the "no outbox" note above.
    await supabase.rpc("learning_heartbeat", {
      p_session_id: learningSessionId(),
      p_item_kind: kind,
      p_item_key: key,
      p_seconds: Math.round(seconds),
    });
  } catch {
    // Same answer, for the failures that throw rather than return an error.
  }
}

export interface HeartbeatOptions {
  /** True when the screen is in front of a person right now. */
  isActive: () => boolean;
  /** Subscribe to anything that could change `isActive`; returns an unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  /** Called with the whole interval's worth of seconds, once per interval. */
  onBeat: (seconds: number) => void;
  /** Beat cadence. Default HEARTBEAT_MS. */
  intervalMs?: number;
}

/**
 * The scheduler. PURE of the DOM — everything it needs is injected — so the
 * gating rules are unit-tested rather than reasoned about.
 *
 * THE RULE: a timer runs only while `isActive()`. Going inactive clears it and
 * DROPS the part-interval in progress; coming back starts a fresh full
 * interval. So the count is always whole intervals of uninterrupted attention,
 * and the rounding error goes the honest way — a person who flicks away at
 * fourteen seconds banks nothing for those fourteen seconds, rather than the
 * app rounding up to fifteen it did not watch them spend.
 *
 * Returns the stop function; calling it twice is safe.
 */
export function startHeartbeats(opts: HeartbeatOptions): () => void {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_MS;
  const seconds = Math.round(intervalMs / 1000);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const clear = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const sync = () => {
    if (stopped) return;
    const active = opts.isActive();
    if (active && timer === null) {
      timer = setInterval(() => {
        // Re-checked at the moment of the beat, not only at the moment the
        // timer was armed: a phone can go to sleep without firing any event we
        // subscribed to, and somebody who simply stops touching the screen
        // fires nothing by definition. A beat sent from either is the one lie
        // this whole design is built to avoid.
        if (opts.isActive()) {
          opts.onBeat(seconds);
        } else {
          // Nothing told us, so nothing will tell us when it comes back either
          // — drop the timer here and let the next sign of life arm a fresh
          // whole interval. Otherwise a person returning after an hour away
          // would be paid a full beat for the two seconds they have been back.
          clear();
        }
      }, intervalMs);
    } else if (!active) {
      clear();
    }
  };

  const unsubscribe = opts.subscribe(sync);
  sync();

  return () => {
    stopped = true;
    clear();
    unsubscribe();
  };
}

/**
 * How long a screen may sit untouched and still count as somebody learning.
 *
 * WHY THERE IS AN IDLE GATE AT ALL. Visible and focused is the browser's answer
 * to "is this window on top", not to "is anybody there". A Learn tab parked on a
 * second monitor at seven in the morning is visible, focused, and nobody's; it
 * banks a whole shift on the glossary, and the server cannot tell the two apart
 * because an idle tab produces exactly the real seconds its clamps allow. The
 * promise the crew is shown — "counted only while the screen is in front of
 * you" — is this gate, not the visibility one.
 *
 * WHY TEN MINUTES. Long enough to read a term, work a question, or think, with
 * no keyboard and no pointer; short enough that a forgotten tab costs ten
 * minutes rather than eight hours. A lesson that is really playing is exempt —
 * watching is the one kind of learning that looks exactly like an empty desk.
 */
export const IDLE_MS = 10 * 60_000;

/** When somebody last did anything at all. Module scope: one page, one answer. */
let lastInteractionAt = Date.now();

/** How many lessons are playing right now. Ref-counted; see markLessonPlaying. */
let lessonsPlaying = 0;

/**
 * Say a lesson has really started playing, and get back the way to say it
 * stopped. Called by the video card, which is the only thing that knows.
 *
 * Ref-counted rather than a boolean because two cards could overlap for a
 * moment, and released once so a double cleanup — React runs one in strict mode
 * — cannot take the count below what is really playing.
 */
export function markLessonPlaying(): () => void {
  lessonsPlaying += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lessonsPlaying = Math.max(0, lessonsPlaying - 1);
    // The lesson just ended with somebody in front of it, so the idle clock
    // starts now rather than from whenever they last touched the phone — which
    // could be forty minutes ago and would stop the clock the instant a long
    // lesson finished.
    lastInteractionAt = Date.now();
  };
}

/** Test seam: an untouched page, with nothing playing, as a fresh load is. */
export function resetLearningActivity(at: number = Date.now()): void {
  lastInteractionAt = at;
  lessonsPlaying = 0;
}

/**
 * Is this screen genuinely in front of somebody?
 *
 * Three things have to be true: the browser says the page is visible, the
 * browser says it has focus, and somebody has either touched it inside the idle
 * window or has a lesson playing.
 *
 * Not pure — it reads the document and the two module values above — but `now`
 * is injected, which is what lets the ten minutes be tested rather than waited
 * out. It has no side effects: asking does not reset anything.
 */
export function screenIsActive(now: number = Date.now()): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  // Somebody watching a lesson is learning with their hands off the phone. It
  // is the one case where doing nothing IS the activity.
  if (lessonsPlaying > 0) return true;
  return now - lastInteractionAt < IDLE_MS;
}

/**
 * The events that mean a person is there. Passive and captured, so nothing in
 * the app can stop them arriving and nothing here can delay a scroll.
 */
const INTERACTION_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/** Everything that can change the answer above. */
export function subscribeToScreenActivity(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};

  // Arriving somewhere IS a sign of life, and it has to be counted as one:
  // these listeners only exist while a Learn screen is mounted, so somebody who
  // spent the last hour on the dispatch board and then taps through to Learn
  // did the tap before anything here was listening. Without this seed they
  // would land already idle and record nothing until they touched the screen
  // again. It cannot reopen the parked-tab hole, because a tab that is parked
  // subscribes once, when it is opened, and never again.
  lastInteractionAt = Date.now();

  const noteActivity = () => {
    const wasIdle = Date.now() - lastInteractionAt >= IDLE_MS;
    lastInteractionAt = Date.now();
    // Only wake the scheduler when the answer can actually have changed. These
    // fire in bursts — a single flick of a thumb is a dozen scroll events — and
    // the scheduler has nothing to do while its timer is already running.
    if (wasIdle) onChange();
  };

  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  window.addEventListener("pagehide", onChange);
  for (const ev of INTERACTION_EVENTS) {
    window.addEventListener(ev, noteActivity, { passive: true, capture: true });
  }
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    window.removeEventListener("pagehide", onChange);
    for (const ev of INTERACTION_EVENTS) {
      window.removeEventListener(ev, noteActivity, { capture: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Dates and formatting
// ---------------------------------------------------------------------------

/**
 * The start of the current week, LOCAL time, Monday-based — the same week the
 * pay period and the crew board count in. PURE — unit-tested.
 *
 * Local rather than UTC on purpose: "this week" to somebody in Texas starts at
 * their Monday midnight, and a UTC week would move the boundary into Sunday
 * evening for half the year.
 */
export function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // getDay(): 0 = Sunday. Monday-based means Sunday is six days into the week.
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

/**
 * Seconds as a person would say them: "2h 10m", "14m", "40s". PURE —
 * unit-tested. Never "0h 0m": under a minute reads in seconds, because "0m"
 * beside somebody's name reads as "did nothing" when they did something.
 */
export function formatLearningTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

// ---------------------------------------------------------------------------
// Video watches (L2)
// ---------------------------------------------------------------------------

/** One beat every ten seconds while a lesson is playing. */
export const VIDEO_HEARTBEAT_MS = 10_000;

/**
 * Tell the server where the play head is. Best effort, exactly like the Learn
 * heartbeat above and for the same reasons — see the "no outbox" note at the
 * top of this file.
 *
 * The server decides how much of this is real: it measures the elapsed time
 * itself and credits only a window the wall clock and the play head both agree
 * on, so nothing here can turn a drag of the scrubber into watching.
 */
export async function sendVideoWatchHeartbeat(input: {
  videoId: string;
  positionSeconds: number;
  durationSeconds: number;
  playing: boolean;
}): Promise<void> {
  try {
    await supabase.rpc("learning_video_heartbeat", {
      p_video_id: input.videoId,
      p_session_id: learningSessionId(),
      p_position_s: Math.max(0, Math.round(input.positionSeconds)),
      p_duration_s: Math.max(0, Math.round(input.durationSeconds)),
      p_playing: input.playing,
    });
  } catch {
    // A lesson must never stop playing because a measurement failed.
  }
}

// ---------------------------------------------------------------------------
// Reading it back: a person's own line (L4)
// ---------------------------------------------------------------------------

export interface MyLearningTime {
  /** Seconds on any Learn item since the start of this week (local Monday). */
  weekSeconds: number;
  /** Distinct lessons this person has finished, ever. */
  videosFinished: number;
}

/**
 * What a person is told about themselves at the bottom of Learn.
 *
 * Reads their OWN rows straight through the tables' select policies — no RPC,
 * no rank involved, and nothing here can see anybody else even if it tried.
 * That is the point of the line: a measure of somebody that the person cannot
 * see is a measure they cannot argue with.
 *
 * The week total counts the 'tab' rows only, for the same reason the owner's
 * page does — every minute in Learn lands on one, and the item rows are the
 * same minutes named more precisely.
 */
export async function getMyLearningTime(
  profileId: string,
  now: Date = new Date(),
): Promise<MyLearningTime> {
  const since = startOfWeek(now).toISOString();
  const [time, watches] = await Promise.all([
    supabase
      .from("learning_time")
      .select("active_seconds")
      .eq("profile_id", profileId)
      .eq("item_kind", "tab")
      .gte("last_seen_at", since),
    supabase
      .from("learning_video_watches")
      .select("video_id")
      .eq("profile_id", profileId)
      .eq("completed", true),
  ]);

  // A database that has not had 20260992000000 yet answers "no such table" to
  // both reads. That is not an error a crew member should ever see — the line
  // simply does not appear, and the rest of Learn is untouched. Anything else
  // is a real failure and is thrown, so it shows up where a developer looks.
  if (time.error && !isMissingTable(time.error, "learning_time")) throw time.error;
  if (watches.error && !isMissingTable(watches.error, "learning_video_watches")) {
    throw watches.error;
  }

  const weekSeconds = (time.data ?? []).reduce(
    (sum, r) => sum + Number((r as { active_seconds: number }).active_seconds ?? 0),
    0,
  );
  const finished = new Set(
    (watches.data ?? []).map((r) => String((r as { video_id: string }).video_id)),
  );

  return { weekSeconds, videosFinished: finished.size };
}
