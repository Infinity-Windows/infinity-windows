import { describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_AFTER_HIDDEN_MS,
  decideUpdateAction,
  isNewerBuildKnown,
  parseBuildVersion,
  type UpdateFacts,
} from "./updateCore";

/**
 * The one rule that must never bend: an installer mid-capture is holding a voice
 * memo, before/after photos and a video in React state and nowhere else. Nothing
 * reaches IndexedDB until they submit (see installOutbox). So a reload at that
 * moment destroys work that cannot be recovered, and being one build behind is
 * the lesser evil every single time.
 *
 * The other half is that a phone must not be allowed to sit on stale code for a
 * whole shift, which is what an hour-long timer that stops while backgrounded
 * amounted to. So: apply it silently when it is provably safe, ask otherwise,
 * and never, ever reload over unsaved work.
 */

const base: UpdateFacts = {
  runningBuildId: "old-sha",
  latestBuildId: "new-sha",
  swUpdateWaiting: true,
  hasUnsavedWork: false,
  hiddenForMs: null,
};

const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({
  ...base,
  ...over,
});

describe("decideUpdateAction", () => {
  describe("unsaved work always wins", () => {
    it("prompts instead of reloading when capture is in progress", () => {
      expect(
        decideUpdateAction(facts({ hasUnsavedWork: true, hiddenForMs: null })),
      ).toBe("prompt");
    });

    it("still refuses to reload after a long absence", () => {
      // The tempting case: phone was in a pocket for an hour, so a reload looks
      // free. It is not — the photos are still only in memory.
      expect(
        decideUpdateAction(
          facts({
            hasUnsavedWork: true,
            hiddenForMs: 60 * 60 * 1000,
          }),
        ),
      ).toBe("prompt");
    });

    it("refuses however long the app was away", () => {
      for (const hiddenForMs of [0, 1_000, 60_000, 86_400_000]) {
        expect(
          decideUpdateAction(facts({ hasUnsavedWork: true, hiddenForMs })),
        ).toBe("prompt");
      }
    });
  });

  describe("applying it silently when that is safe", () => {
    it("reloads when nothing is unsaved and the app was away long enough", () => {
      expect(
        decideUpdateAction(facts({ hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS })),
      ).toBe("reload");
    });

    it("reloads after a much longer absence too", () => {
      expect(decideUpdateAction(facts({ hiddenForMs: 6 * 60 * 60 * 1000 }))).toBe(
        "reload",
      );
    });

    it("asks rather than reloading for a brief glance away", () => {
      expect(
        decideUpdateAction(
          facts({ hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS - 1 }),
        ),
      ).toBe("prompt");
    });

    it("asks when the app never went out of sight", () => {
      // A page vanishing under someone's thumb is startling even when it costs
      // them nothing.
      expect(decideUpdateAction(facts({ hiddenForMs: null }))).toBe("prompt");
    });
  });

  describe("when there is nothing to apply yet", () => {
    it("checks with the browser once a newer build is known to exist", () => {
      expect(
        decideUpdateAction(
          facts({ swUpdateWaiting: false, latestBuildId: "new-sha" }),
        ),
      ).toBe("check");
    });

    it("does nothing when the published build is the running one", () => {
      expect(
        decideUpdateAction(
          facts({ swUpdateWaiting: false, latestBuildId: "old-sha" }),
        ),
      ).toBe("none");
    });

    it("does nothing when we could not find out", () => {
      // Offline on a job site is the normal case, not a reason to act.
      expect(
        decideUpdateAction(facts({ swUpdateWaiting: false, latestBuildId: null })),
      ).toBe("none");
    });

    it("never reloads on the strength of version.json alone", () => {
      // The new bundle is not downloaded yet; reloading now would just fetch the
      // same cached shell from the old worker.
      expect(
        decideUpdateAction(
          facts({ swUpdateWaiting: false, hiddenForMs: 60 * 60 * 1000 }),
        ),
      ).toBe("check");
    });
  });

  describe("a waiting worker is actionable on its own", () => {
    it("prompts even when version.json could not be read", () => {
      // The service worker has already proved a new build exists by downloading
      // it, so a failed version check must not suppress the banner.
      expect(decideUpdateAction(facts({ latestBuildId: null }))).toBe("prompt");
    });

    it("reloads when safe even without a version.json answer", () => {
      expect(
        decideUpdateAction(
          facts({ latestBuildId: null, hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS }),
        ),
      ).toBe("reload");
    });
  });
});

describe("isNewerBuildKnown", () => {
  it("is true only for a different published build", () => {
    expect(isNewerBuildKnown({ runningBuildId: "a", latestBuildId: "b" })).toBe(
      true,
    );
    expect(isNewerBuildKnown({ runningBuildId: "a", latestBuildId: "a" })).toBe(
      false,
    );
  });

  it("is false when the published build is unknown", () => {
    expect(isNewerBuildKnown({ runningBuildId: "a", latestBuildId: null })).toBe(
      false,
    );
  });

  it("is false when the running build id is missing", () => {
    // An un-substituted __BUILD_ID__ would otherwise make every check look like
    // an update and nag forever.
    expect(isNewerBuildKnown({ runningBuildId: "", latestBuildId: "b" })).toBe(
      false,
    );
  });
});

describe("parseBuildVersion", () => {
  it("reads a well-formed version file", () => {
    expect(
      parseBuildVersion({ buildId: "abc123", builtAt: "2026-07-29T00:00:00Z" }),
    ).toEqual({ buildId: "abc123", builtAt: "2026-07-29T00:00:00Z" });
  });

  it("tolerates a missing builtAt", () => {
    expect(parseBuildVersion({ buildId: "abc123" })).toEqual({
      buildId: "abc123",
      builtAt: "",
    });
  });

  it.each([
    ["null", null],
    ["a string", "abc"],
    ["a number", 7],
    ["an empty object", {}],
    ["an empty buildId", { buildId: "" }],
    ["a non-string buildId", { buildId: 7 }],
    ["an array", []],
  ])("reads %s as unknown rather than as a build", (_label, raw) => {
    // A Pages 404 page or a half-deployed asset must not become a build id we
    // then nag the user about forever.
    expect(parseBuildVersion(raw)).toBeNull();
  });
});
