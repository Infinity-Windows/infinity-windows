// What "watched it" means, in one place.
//
// The owner's question about the video library is two questions: did they watch
// the whole thing, and how many times. Neither can be answered by counting
// presses of play — a lesson left playing to an empty room, or skipped to the
// last second, would answer yes to both. So the app records WHICH SECONDS of a
// lesson were actually played, as a set of ranges, and every answer is derived
// from that.
//
// THIS FILE IS A TWIN. The real arithmetic runs in SQL
// (`merge_watch_ranges` / `learning_video_heartbeat` in
// 20260993000000_learning_time.sql), because the server is the only place a
// phone cannot argue with. The copy here is what the app reads back and what
// the tests exercise, and `TWIN_CASES` below is the shared worked example: the
// same nine cases are written into the migration as a comment, and
// videoWatch.test.ts fails if the two copies ever stop saying the same thing.
// It is not a database test — there is no Postgres in this suite — and it does
// not pretend to be one. It is a pin, so a change to one side cannot land
// quietly without the other.

/** One covered stretch of a lesson, in whole seconds: [start, end]. */
export type WatchRange = [number, number];

/** No beat may claim more than this much of the video. */
export const MAX_BEAT_SECONDS = 15;

/** Covered this much of a lesson and it counts as watched through. */
export const COMPLETE_FRACTION = 0.9;

/**
 * A session counts as one "time watched" once it has covered this many seconds.
 *
 * Thirty, not one: opening a card and closing it is not watching a lesson, and
 * a count that included it would tell an owner somebody watched the safety
 * video eleven times when they scrolled past it eleven times. The number is
 * stated on screen beside the count, so nobody has to guess what it means.
 */
export const WATCH_MIN_SECONDS = 30;

/**
 * Fold one newly-watched stretch into the ranges already covered. PURE.
 *
 * The rule, and it is the same rule in SQL: sort by start, then walk. A stretch
 * that begins at or before the end of the one in hand extends it (so 0-10 and
 * 10-20 become 0-20 — touching is continuous, not two separate viewings);
 * anything else starts a new range. Nothing is ever counted twice, so watching
 * the same thirty seconds four times covers thirty seconds.
 */
export function mergeWatchRanges(
  ranges: readonly WatchRange[],
  start: number,
  end: number,
): WatchRange[] {
  const all: WatchRange[] = [];
  for (const [s, e] of ranges) {
    const lo = Math.max(0, Math.floor(s));
    const hi = Math.floor(e);
    if (hi > lo) all.push([lo, hi]);
  }
  const lo = Math.max(0, Math.floor(Math.min(start, end)));
  const hi = Math.floor(Math.max(start, end));
  if (hi > lo) all.push([lo, hi]);

  all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const out: WatchRange[] = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** How many seconds of a lesson these ranges cover. PURE. */
export function coveredSeconds(ranges: readonly WatchRange[]): number {
  return ranges.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0);
}

/** Covered seconds as a share of the lesson, 0 when the length is unknown. */
export function watchFraction(covered: number, duration: number | null): number {
  if (!duration || duration <= 0) return 0;
  return Math.min(1, Math.max(0, covered / duration));
}

/** The share as a whole percent, for a screen. */
export function watchPercent(covered: number, duration: number | null): number {
  return Math.round(watchFraction(covered, duration) * 100);
}

/**
 * Did they watch the whole thing?
 *
 * Either they covered ninety percent of it, or the player itself said the video
 * ended. The second half is why the percentage is always shown BESIDE this
 * answer and never instead of it: dragging the scrubber to the last second and
 * letting it stop also ends a video, and the honest way to handle that is to
 * let the owner see "finished · 4% watched" rather than to guess at intent.
 * Nothing here can be un-said — a person who finishes a lesson and then rewinds
 * has still finished it.
 */
export function isWatchedThrough(
  covered: number,
  duration: number | null,
  endedFired: boolean,
): boolean {
  return endedFired || watchFraction(covered, duration) >= COMPLETE_FRACTION;
}

export interface BeatWindowInput {
  /** Seconds of wall clock since the last beat of this session (server-side). */
  elapsed: number;
  /** How far the play head moved since the last beat. */
  delta: number;
  /** Was the player playing when this beat was sent? */
  playing: boolean;
  /** False on the very first beat of a session, when there is no marker yet. */
  hasPrevious: boolean;
}

/**
 * How many seconds this beat is allowed to claim, ending at the current
 * position. PURE, and the whole defence against a seek counting as watching.
 *
 * A beat claims the smaller of: the cap, the wall clock that really passed, and
 * the distance the play head actually moved. It claims NOTHING when
 *   - the player was not playing (a pause is not watching);
 *   - there is no previous marker (the first beat of a session has observed no
 *     play time yet — so a session under-reports by up to one beat, which is
 *     the direction to be wrong in);
 *   - the head went backwards (a rewind is watching, and the seconds it
 *     re-covers are already covered);
 *   - the head jumped further forward than the clock could explain, which is a
 *     drag of the scrubber and not ten seconds of anybody's attention.
 *
 * The forward allowance is twice the elapsed time plus two seconds, so watching
 * at double speed is credited (at the slower of the two, deliberately) and a
 * jump is not.
 */
export function beatWindowSeconds(input: BeatWindowInput): number {
  if (!input.playing || !input.hasPrevious) return 0;
  const elapsed = Math.max(0, Math.floor(input.elapsed));
  const delta = Math.floor(input.delta);
  if (delta <= 0) return 0;
  if (delta > elapsed * 2 + 2) return 0;
  return Math.min(MAX_BEAT_SECONDS, elapsed, delta);
}

/**
 * "Times watched": sessions that got through at least WATCH_MIN_SECONDS.
 * One visit is one watch however many times the person pressed play in it.
 */
export function timesWatched(sessions: readonly { watchSeconds: number }[]): number {
  return sessions.filter((s) => s.watchSeconds >= WATCH_MIN_SECONDS).length;
}

// ---------------------------------------------------------------------------
// The twin
// ---------------------------------------------------------------------------

export interface TwinCase {
  /** Why this case is here — printed into the migration beside the numbers. */
  why: string;
  ranges: WatchRange[];
  start: number;
  end: number;
  expect: WatchRange[];
  covered: number;
}

/**
 * The worked examples both copies of the merge have to answer the same way.
 *
 * Nine cases, chosen for the things that actually go wrong: touching ranges,
 * a real gap, a stretch that bridges two, a re-watch that must add nothing,
 * beats that arrive out of order, an empty window, a negative position, and
 * stored ranges that already overlap each other.
 */
export const TWIN_CASES: readonly TwinCase[] = [
  { why: "the first stretch of a fresh session", ranges: [], start: 0, end: 10, expect: [[0, 10]], covered: 10 },
  { why: "touching ranges are one viewing, not two", ranges: [[0, 10]], start: 10, end: 20, expect: [[0, 20]], covered: 20 },
  { why: "a real gap stays a gap", ranges: [[0, 10]], start: 20, end: 30, expect: [[0, 10], [20, 30]], covered: 20 },
  { why: "a stretch that bridges two ranges closes the gap", ranges: [[0, 10], [20, 30]], start: 5, end: 25, expect: [[0, 30]], covered: 30 },
  { why: "watching the same part again adds nothing", ranges: [[0, 30]], start: 5, end: 10, expect: [[0, 30]], covered: 30 },
  { why: "a beat about an earlier part sorts into place", ranges: [[20, 30]], start: 0, end: 10, expect: [[0, 10], [20, 30]], covered: 20 },
  { why: "a window of no length is not a range", ranges: [], start: 10, end: 10, expect: [], covered: 0 },
  { why: "nothing is ever covered before the start of the video", ranges: [], start: -5, end: 10, expect: [[0, 10]], covered: 10 },
  { why: "ranges that already overlap are tidied on the way through", ranges: [[0, 10], [5, 15]], start: 30, end: 40, expect: [[0, 15], [30, 40]], covered: 25 },
];

/** One case as the single line that appears in BOTH copies. */
export function twinCaseLine(c: TwinCase): string {
  const j = (r: readonly WatchRange[]) =>
    `[${r.map(([s, e]) => `[${s},${e}]`).join(",")}]`;
  return `${j(c.ranges)} + ${c.start}..${c.end} -> ${j(c.expect)} covered ${c.covered}`;
}
