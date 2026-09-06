// The heartbeat scheduler is the whole honesty of learning time on the phone
// side: the server clamps what it is told, but only this decides whether a
// second in front of somebody's face happened at all. So the gating is tested
// rather than reasoned about — a regression here is a report that says a person
// studied all afternoon because they left a tab open.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_MS,
  formatLearningTime,
  learningSessionId,
  resetLearningSession,
  startHeartbeats,
  startOfWeek,
} from "./learningTime";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = readFileSync(
  resolve(REPO, "supabase/migrations/20260992000000_learning_time.sql"),
  "utf8",
);
const MIRROR = readFileSync(resolve(REPO, "docs/prototype-migrations.sql"), "utf8");

/** A fake screen: visible/focused is one boolean, and it publishes changes. */
function fakeScreen(active = true) {
  const listeners = new Set<() => void>();
  const state = { active };
  return {
    isActive: () => state.active,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Hide the tab / lock the phone / click another window. */
    set(next: boolean) {
      state.active = next;
      for (const fn of [...listeners]) fn();
    },
    /** Go inactive WITHOUT telling anybody — a phone falling asleep. */
    setSilently(next: boolean) {
      state.active = next;
    },
    listenerCount: () => listeners.size,
  };
}

describe("startHeartbeats", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("beats once per interval while the screen is visible and focused", () => {
    const screen = fakeScreen(true);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      onBeat: (s) => beats.push(s),
    });

    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(beats).toEqual([15, 15, 15]);
    stop();
  });

  it("sends the interval's own seconds, whatever the interval is", () => {
    const screen = fakeScreen(true);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      intervalMs: 10_000,
      onBeat: (s) => beats.push(s),
    });

    vi.advanceTimersByTime(20_000);
    expect(beats).toEqual([10, 10]);
    stop();
  });

  it("never beats while the screen is hidden — not once, not at the start", () => {
    const screen = fakeScreen(false);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      onBeat: (s) => beats.push(s),
    });

    vi.advanceTimersByTime(HEARTBEAT_MS * 10);
    expect(beats).toEqual([]);
    stop();
  });

  it("stops on hide and starts again on show", () => {
    const screen = fakeScreen(true);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      onBeat: (s) => beats.push(s),
    });

    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(beats).toHaveLength(2);

    screen.set(false);
    vi.advanceTimersByTime(HEARTBEAT_MS * 10);
    expect(beats, "a hidden tab banks nothing, however long it sits").toHaveLength(2);

    screen.set(true);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(beats).toHaveLength(3);
    stop();
  });

  it("drops the part-interval it was in the middle of when the screen goes away", () => {
    // The honest direction to round: fourteen seconds of attention followed by
    // a locked phone is worth nothing, not a full beat. Coming back starts a
    // fresh interval rather than finishing the old one a second later.
    const screen = fakeScreen(true);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      onBeat: (s) => beats.push(s),
    });

    vi.advanceTimersByTime(HEARTBEAT_MS - 1000);
    screen.set(false);
    screen.set(true);
    vi.advanceTimersByTime(1000);
    expect(beats, "the old interval did not finish").toEqual([]);

    vi.advanceTimersByTime(HEARTBEAT_MS - 1000);
    expect(beats).toEqual([15]);
    stop();
  });

  it("re-checks at the moment of the beat, for a phone that slept without saying so", () => {
    // visibilitychange does not always fire before a device sleeps. The timer
    // is armed, the beat comes due, and the only thing standing between that
    // and a lie is this second check.
    const screen = fakeScreen(true);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      onBeat: (s) => beats.push(s),
    });

    screen.setSilently(false);
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    expect(beats).toEqual([]);
    stop();
  });

  it("unsubscribes and disarms when it is stopped, and stays stopped", () => {
    const screen = fakeScreen(true);
    const beats: number[] = [];
    const stop = startHeartbeats({
      isActive: screen.isActive,
      subscribe: screen.subscribe,
      onBeat: (s) => beats.push(s),
    });

    stop();
    expect(screen.listenerCount()).toBe(0);
    screen.set(false);
    screen.set(true);
    vi.advanceTimersByTime(HEARTBEAT_MS * 5);
    expect(beats).toEqual([]);

    // Calling it twice is safe — React runs a cleanup more than once in strict
    // mode, and a second call must not resurrect anything.
    expect(() => stop()).not.toThrow();
  });
});

describe("learningSessionId", () => {
  beforeEach(() => resetLearningSession());

  it("is one value for the life of the page, so every hook agrees which visit it is", () => {
    const first = learningSessionId();
    expect(learningSessionId()).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is a NEW value after a fresh page load", () => {
    const first = learningSessionId();
    resetLearningSession();
    expect(learningSessionId()).not.toBe(first);
  });
});

describe("formatLearningTime", () => {
  it("says minutes and hours the way a person would", () => {
    expect(formatLearningTime(0)).toBe("0s");
    expect(formatLearningTime(45)).toBe("45s");
    expect(formatLearningTime(60)).toBe("1m");
    expect(formatLearningTime(14 * 60 + 59)).toBe("14m");
    expect(formatLearningTime(60 * 60)).toBe("1h");
    expect(formatLearningTime(2 * 3600 + 10 * 60)).toBe("2h 10m");
  });

  it("never prints 0m for time somebody really spent", () => {
    // "0m" beside a name reads as "did nothing". Under a minute says seconds.
    expect(formatLearningTime(1)).toBe("1s");
    expect(formatLearningTime(59)).toBe("59s");
  });

  it("shrugs off nonsense rather than printing NaN", () => {
    expect(formatLearningTime(-500)).toBe("0s");
    expect(formatLearningTime(Number.NaN)).toBe("0s");
  });
});

describe("startOfWeek", () => {
  it("counts a week from Monday, like the pay period does", () => {
    // 2026-09-05 is a Saturday.
    expect(startOfWeek(new Date(2026, 8, 5, 13, 0)).getDate()).toBe(31);
    // Monday itself is the start of its own week, at midnight.
    const monday = startOfWeek(new Date(2026, 8, 7, 23, 59));
    expect(monday.getDate()).toBe(7);
    expect(monday.getHours()).toBe(0);
  });

  it("puts Sunday at the END of the week it belongs to, not the start", () => {
    // 2026-09-06 is a Sunday; its week began Monday the 31st of August.
    const d = startOfWeek(new Date(2026, 8, 6, 9, 0));
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(31);
  });
});

// ---------------------------------------------------------------------------
// The clamps that live in SQL
// ---------------------------------------------------------------------------
// No Postgres runs in this suite, so these do not execute the rules — they PIN
// them. Every line below is a defence somebody could delete while the app still
// built, every test passed and the owner's page still drew a chart; what would
// change is that a phone could write any number into it. A pin is the cheapest
// thing that makes that deletion loud.
//
// The mirror is checked as well as the migration, because
// docs/prototype-migrations.sql is what gets pasted into a fresh project and a
// defence that is only in one of the two files is not a defence.

describe("the server's own clamps on a heartbeat", () => {
  it("finds the writer at all, so these tests are not vacuous", () => {
    expect(MIGRATION).toContain("create or replace function public.learning_heartbeat");
    expect(MIRROR).toContain("create or replace function public.learning_heartbeat");
  });

  it("opens a row worth nothing, so inventing visits invents no seconds", () => {
    // The row key carries a session id the PHONE mints. If the insert credited
    // the beat, a fresh uuid per call would be thirty seconds per call, as fast
    // as a script could send them — with no clock anywhere to answer to.
    for (const sql of [MIGRATION, MIRROR]) {
      expect(sql).toContain("values (v_me, p_item_kind, v_key, p_session_id, 0)");
    }
  });

  it("measures a beat against the KIND, not against the row it names", () => {
    // The clamp that matters. A per-row ceiling is a clean wall clock per row,
    // and rows are free — so the reference is the last time this person banked
    // anything of this kind, from any visit and any item.
    for (const sql of [MIGRATION, MIRROR]) {
      expect(sql).toContain("and t.item_kind = p_item_kind");
      expect(sql).toContain("order by t.last_seen_at desc");
      expect(sql).toContain(
        "greatest(0, floor(extract(epoch from (now() - coalesce(v_kind_seen, now()))))::int)",
      );
    }
  });

  it("keeps the per-row belt exact, with no beat of slack left in it", () => {
    // The slack used to be `+ 30`, which let a burst of calls walk a row up to
    // its whole age. With the insert banking nothing there is nothing to make
    // room for, so the belt is level with the row's age.
    for (const sql of [MIGRATION, MIRROR]) {
      expect(sql).toContain(
        "floor(extract(epoch from (now() - learning_time.started_at)))::int\n",
      );
      expect(sql).not.toContain(
        "floor(extract(epoch from (now() - learning_time.started_at)))::int + 30",
      );
    }
  });
});

describe("the server's own check on which item a beat names", () => {
  it("only lets a 'tab' beat name a tab that exists", () => {
    // The tab rows ARE the person's total on the owner's page
    // (foldByPerson, learningTimeReport.ts). An unchecked key is an unlimited
    // supply of them.
    for (const sql of [MIGRATION, MIRROR]) {
      expect(sql).toContain(
        "and v_key not in ('daily', 'quiz', 'sequence', 'glossary', 'videos') then",
      );
      expect(sql).toContain("if p_item_kind in ('quiz', 'sequence') and v_key <> 'round' then");
    }
  });

  it("makes a 'video' beat name a lesson the library really has", () => {
    for (const sql of [MIGRATION, MIRROR]) {
      expect(sql).toContain("from learning_videos lv where lv.id::text = v_key");
    }
  });

  it("caps the length of any key, so a long one is a sentence not a btree error", () => {
    for (const sql of [MIGRATION, MIRROR]) {
      expect(sql).toContain("if length(v_key) > 64 then");
    }
  });

  it("names the five tabs the app really ships", () => {
    // Pinned against the Tab union in pages/Education.tsx: a tab added there
    // and not here is time that silently stops being recorded.
    const tabs = ["daily", "quiz", "sequence", "glossary", "videos"];
    const page = readFileSync(resolve(REPO, "app/src/pages/Education.tsx"), "utf8");
    expect(page).toContain(
      `type Tab = ${tabs.map((t) => `"${t}"`).join(" | ")};`,
    );
  });
});
