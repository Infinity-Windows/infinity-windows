import { describe, expect, it } from "vitest";
import { shouldPersistQuery } from "./queryClient";

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
