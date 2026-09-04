import { describe, expect, it, vi } from "vitest";
import { shouldPersistQuery } from "./queryClient";
// api.ts reaches for supabase at import time; nothing here calls the network.
vi.mock("./supabase", () => ({ supabase: {} }));
import { byProjectId } from "./api";
import type { ScopeCounts } from "./scope";

/**
 * A gate is only as offline-proof as the fact that CLEARS it.
 *
 * Twice now the same shape of bug has shipped: a read that raises a gate was
 * kept in the offline cache and the read that satisfies it was not, so after a
 * reload with no signal the app refused work that was already done and gave
 * nobody a way past it.
 *
 * - toolboxToday (installer audit, 2026-08-17): the talk was cached, the
 *   signature on it was not, so every Start install was silently refused.
 * - openingPhases (review, 2026-09-02): the opening was cached, so
 *   `needs_flashing = true` came back; the submitted flashing phase that
 *   clears it was not, so Submit went dead on an already-flashed unit and the
 *   install could not even be queued for later.
 *
 * These pairs are listed together here so the next one is a failing test
 * rather than a field report.
 */
describe("offline cache: a gate and the fact that clears it travel together", () => {
  const PAIRS: Array<[string, string, string]> = [
    ["the toolbox talk", "todayTalk", "toolboxToday"],
    ["the flashing gate", "opening", "openingPhases"],
  ];

  for (const [what, raises, clears] of PAIRS) {
    it(`${what}: both halves survive an offline reload`, () => {
      expect(shouldPersistQuery([raises, "project-1"])).toBe(true);
      expect(shouldPersistQuery([clears, "project-1"])).toBe(true);
    });
  }

  it("still keeps volatile and heavy reads out", () => {
    expect(shouldPersistQuery(["openingPhotos", "opening-1"])).toBe(false);
    expect(shouldPersistQuery([])).toBe(false);
  });
});

/**
 * A persisted answer goes to localStorage through `JSON.stringify` and comes
 * back through `JSON.parse`, so it has to be made of things JSON can carry.
 *
 * A `Map` is not: it stringifies to `{}`, losing every key. Wave X very nearly
 * shipped `listScopeCounts()` answering with one — the restored value would
 * have been a truthy object with no `.get`, so the jobs list and the manager
 * Home (the two most-used landings) would have thrown on the SECOND launch and
 * every launch after, because the bad value is written back each time. The
 * crash is only reachable from the persisted cache, which is why no rendering
 * test would have caught it and this one lives beside the key list.
 */
describe("a persisted answer survives the round trip localStorage puts it through", () => {
  const row = (id: string): ScopeCounts => ({
    project_id: id,
    openings: 40,
    installed: 32,
    windows: 32,
    doors: 8,
    door_sliders: 5,
    door_french: 2,
    door_bifold: 1,
    door_swing: 0,
    door_other: 0,
    unknown_units: 0,
  });

  it("scopeCounts is persisted, so it must be JSON-native", () => {
    expect(shouldPersistQuery(["scopeCounts"])).toBe(true);

    const fresh = byProjectId([row("job-1"), row("job-2")]);
    const restored: Record<string, ScopeCounts> = JSON.parse(
      JSON.stringify(fresh),
    );

    // The lookup both landings do at render, on the value read back from disk.
    expect(restored["job-1"]?.doors).toBe(8);
    expect(restored["job-2"]?.openings).toBe(40);
    expect(restored["not-a-job"]).toBeUndefined();
  });

  it("the same rows in a Map would have lost every key", () => {
    const asMap = new Map([["job-1", row("job-1")]]);
    expect(JSON.parse(JSON.stringify(asMap))).toEqual({});
  });
});
