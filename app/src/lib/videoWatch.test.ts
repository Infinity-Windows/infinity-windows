// The watch maths, and the pin that keeps its two copies honest.
//
// The arithmetic runs in SQL, because the server is the only place a phone
// cannot argue with. It also runs here, because the app renders what the server
// computed and because no Postgres exists in this suite. Two copies of a rule
// is how a rule drifts, so the second half of this file reads the migration and
// fails unless the worked examples in it are word for word the ones exercised
// above. It does NOT execute SQL and does not pretend to: it is a pin, so a
// change to one copy cannot land without the other.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPLETE_FRACTION,
  TWIN_CASES,
  WATCH_MIN_SECONDS,
  beatWindowSeconds,
  coveredSeconds,
  isWatchedThrough,
  mergeWatchRanges,
  timesWatched,
  twinCaseLine,
  watchPercent,
} from "./videoWatch";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = readFileSync(
  resolve(REPO, "supabase/migrations/20260992000000_learning_time.sql"),
  "utf8",
);
const MIRROR = readFileSync(resolve(REPO, "docs/prototype-migrations.sql"), "utf8");

describe("mergeWatchRanges", () => {
  it("answers every twin case the way the SQL says it does", () => {
    for (const c of TWIN_CASES) {
      const got = mergeWatchRanges(c.ranges, c.start, c.end);
      expect(got, c.why).toEqual(c.expect);
      expect(coveredSeconds(got), `${c.why} (covered)`).toBe(c.covered);
    }
  });

  it("does not mutate the ranges it was handed", () => {
    const before = [[0, 10]] as [number, number][];
    mergeWatchRanges(before, 10, 20);
    expect(before).toEqual([[0, 10]]);
  });

  it("keeps the whole record in order, however the beats arrive", () => {
    let ranges = mergeWatchRanges([], 60, 70);
    ranges = mergeWatchRanges(ranges, 0, 10);
    ranges = mergeWatchRanges(ranges, 30, 40);
    expect(ranges).toEqual([
      [0, 10],
      [30, 40],
      [60, 70],
    ]);
  });
});

describe("watchPercent and isWatchedThrough", () => {
  it("reads a share of the lesson as a whole percent", () => {
    expect(watchPercent(45, 90)).toBe(50);
    expect(watchPercent(90, 90)).toBe(100);
    expect(watchPercent(0, 90)).toBe(0);
  });

  it("says nothing rather than something wrong when the length is unknown", () => {
    // An embed that never loaded reports no duration. Zero percent is a lie
    // shaped like a fact; the screens print "—" for this.
    expect(watchPercent(60, null)).toBe(0);
    expect(watchPercent(60, 0)).toBe(0);
    expect(isWatchedThrough(60, null, false)).toBe(false);
  });

  it("counts ninety percent as watched through", () => {
    expect(COMPLETE_FRACTION).toBe(0.9);
    expect(isWatchedThrough(89, 100, false)).toBe(false);
    expect(isWatchedThrough(90, 100, false)).toBe(true);
  });

  it("believes the player when it says the video ended", () => {
    // And this is exactly why every screen prints the percentage beside the
    // verdict: dragging to the last second also ends a video.
    expect(isWatchedThrough(4, 100, true)).toBe(true);
  });
});

describe("beatWindowSeconds — the seek defence", () => {
  const base = { elapsed: 10, delta: 10, playing: true, hasPrevious: true };

  it("credits a normal beat with the time that really passed", () => {
    expect(beatWindowSeconds(base)).toBe(10);
  });

  it("credits nothing for the first beat of a visit — nothing has been seen yet", () => {
    expect(beatWindowSeconds({ ...base, hasPrevious: false })).toBe(0);
  });

  it("credits nothing while the player is paused", () => {
    expect(beatWindowSeconds({ ...base, playing: false })).toBe(0);
  });

  it("credits nothing for a rewind — those seconds are already covered", () => {
    expect(beatWindowSeconds({ ...base, delta: -120 })).toBe(0);
    expect(beatWindowSeconds({ ...base, delta: 0 })).toBe(0);
  });

  it("credits NOTHING for a drag of the scrubber, which is the whole point", () => {
    // Ten seconds of wall clock cannot explain five minutes of video.
    expect(beatWindowSeconds({ ...base, delta: 300 })).toBe(0);
  });

  it("still credits double-speed playback, at the slower of the two", () => {
    expect(beatWindowSeconds({ ...base, elapsed: 10, delta: 20 })).toBe(10);
  });

  it("never credits more than the cap, however long the phone was asleep", () => {
    // A tab that came back after five minutes paused reports one huge elapsed;
    // the cap is what stops that becoming five minutes of watching.
    expect(beatWindowSeconds({ ...base, elapsed: 300, delta: 300 })).toBe(15);
  });

  it("is bounded by the play head, not just by the clock", () => {
    expect(beatWindowSeconds({ ...base, elapsed: 12, delta: 3 })).toBe(3);
  });
});

describe("timesWatched", () => {
  it("counts the visits that got through half a minute", () => {
    expect(WATCH_MIN_SECONDS).toBe(30);
    expect(
      timesWatched([
        { watchSeconds: 120 },
        { watchSeconds: 30 },
        { watchSeconds: 29 },
        { watchSeconds: 0 },
      ]),
    ).toBe(2);
  });

  it("is zero when a card was only ever scrolled past", () => {
    // The reason the floor exists at all: without it, opening the Videos tab
    // eleven times would read as watching the safety lesson eleven times.
    expect(timesWatched([{ watchSeconds: 2 }, { watchSeconds: 5 }])).toBe(0);
  });
});

describe("the SQL twin says the same thing", () => {
  it("finds the merge function at all, so this test is not vacuous", () => {
    expect(MIGRATION).toContain("create or replace function public.merge_watch_ranges");
    expect(MIGRATION).toContain("TWIN CASES");
  });

  it("carries every worked example, word for word", () => {
    for (const c of TWIN_CASES) {
      const line = twinCaseLine(c);
      expect(MIGRATION, `the migration is missing: ${line}`).toContain(line);
    }
  });

  it("carries them in the mirrored copy too", () => {
    // docs/prototype-migrations.sql is what somebody pastes into a fresh
    // project. A twin that is only right in one of the two files is not a twin.
    for (const c of TWIN_CASES) {
      expect(MIRROR, `the mirror is missing: ${twinCaseLine(c)}`).toContain(twinCaseLine(c));
    }
  });

  it("pins the numbers the two copies share", () => {
    // 15-second cap, 0.9 completion, 30-second floor for a "time watched".
    expect(MIGRATION).toContain("least(15, v_elapsed, v_delta)");
    expect(MIGRATION).toContain(">= 0.9");
    expect(MIGRATION).toContain("v_elapsed * 2 + 2");
  });
});
