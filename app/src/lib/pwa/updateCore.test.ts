import { describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_AFTER_HIDDEN_MS,
  decideUpdateAction,
  FRESH_WINDOW_MS,
  SETTLE_MS,
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

describe("safe moments: opening the app, signing in, the sign-in screen", () => {
  // The owner's call (2026-09-23): phones kept running an old build after being
  // opened, because only "came back after a minute away" ever applied an update
  // silently. Opening and signing in hold nothing to lose, so they count too —
  // but never over unsaved work, a focused text field or a tap in progress, and
  // (after the independent review the same day) only on a screen that has
  // said it is safe: the sign-in screen, or the Work landing with no sheet up.
  const safe = (over: Partial<UpdateFacts> = {}) => facts({ onSafeSurface: true, ...over });

  it("applies an update that is ready right after the app opens", () => {
    expect(decideUpdateAction(safe({ freshForMs: 2_000 }))).toBe("reload");
  });

  it("still applies it at the very end of the fresh window", () => {
    expect(decideUpdateAction(safe({ freshForMs: FRESH_WINDOW_MS }))).toBe("reload");
  });

  it("asks once the fresh window has passed", () => {
    expect(decideUpdateAction(safe({ freshForMs: FRESH_WINDOW_MS + 1 }))).toBe("prompt");
  });

  it("asks when anything has been typed since opening", () => {
    // Most forms never claim unsaved work — only capture does — so typing is
    // the only sign a note is half-written.
    expect(
      decideUpdateAction(safe({ freshForMs: 5_000, typedSinceFresh: true })),
    ).toBe("prompt");
  });

  it("never reloads over unsaved work, fresh or not", () => {
    expect(
      decideUpdateAction(safe({ freshForMs: 1_000, hasUnsavedWork: true })),
    ).toBe("prompt");
    expect(
      decideUpdateAction(safe({ signedIn: false, hasUnsavedWork: true })),
    ).toBe("prompt");
  });

  it("applies it on the sign-in screen, where nothing can be lost", () => {
    expect(decideUpdateAction(safe({ signedIn: false }))).toBe("reload");
  });

  it("treats an unknown sign-in state as signed in", () => {
    expect(decideUpdateAction(safe({ signedIn: null }))).toBe("prompt");
    expect(decideUpdateAction(safe({ signedIn: undefined }))).toBe("prompt");
  });

  it("waits while a text field has focus instead of reloading", () => {
    expect(decideUpdateAction(safe({ freshForMs: 1_000, typing: true }))).toBe("defer");
    expect(decideUpdateAction(safe({ signedIn: false, typing: true }))).toBe("defer");
  });

  it("waits a few seconds after a tap", () => {
    expect(
      decideUpdateAction(safe({ freshForMs: 1_000, msSinceInteraction: SETTLE_MS - 1 })),
    ).toBe("defer");
    expect(
      decideUpdateAction(safe({ freshForMs: 1_000, msSinceInteraction: SETTLE_MS })),
    ).toBe("reload");
  });

  it("asks, not waits, when someone returns to a focused text field", () => {
    // Returning is a one-off reading; there is no later moment to wait for,
    // and the field may hold typing from before they left.
    expect(
      decideUpdateAction(
        facts({ hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS, typing: true }),
      ),
    ).toBe("prompt");
  });

  it("does not reload on the strength of a fresh moment alone", () => {
    // Nothing downloaded yet: the fresh moment only makes the browser check.
    expect(
      decideUpdateAction(safe({ swUpdateWaiting: false, freshForMs: 1_000 })),
    ).toBe("check");
    expect(
      decideUpdateAction(
        safe({ swUpdateWaiting: false, signedIn: false, latestBuildId: "old-sha" }),
      ),
    ).toBe("none");
  });

  describe("only on a screen that said it is safe", () => {
    // The first version of the opening window treated ANY screen as safe
    // once four seconds passed without a tap — including one with a voice
    // memo recording (independent review, 2026-09-23). A screen is safe
    // because it claimed so, never because it stayed quiet.
    it("asks, right after opening, on a screen that has not claimed", () => {
      expect(decideUpdateAction(facts({ freshForMs: 2_000 }))).toBe("prompt");
      expect(
        decideUpdateAction(facts({ freshForMs: 2_000, onSafeSurface: false })),
      ).toBe("prompt");
    });

    it("asks on the sign-in path too, without a claim", () => {
      expect(decideUpdateAction(facts({ signedIn: false }))).toBe("prompt");
    });

    it("asks when a sheet is open over the landing", () => {
      // The registry reads "claimed, but covered" as not safe; the fact
      // arrives here as false.
      expect(
        decideUpdateAction(facts({ freshForMs: 2_000, onSafeSurface: false })),
      ).toBe("prompt");
    });

    it("does not need a claim to reload on return after a long absence", () => {
      // That path predates the claim and is guarded by the unsaved-work and
      // queued-work checks instead.
      expect(
        decideUpdateAction(facts({ hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS })),
      ).toBe("reload");
    });
  });

  describe("a dismissal means not now", () => {
    it("turns the opening window off", () => {
      // Without this, dismissing the banner four seconds into the window was
      // followed by the very reload that was just declined.
      expect(
        decideUpdateAction(safe({ freshForMs: 2_000, dismissed: true })),
      ).toBe("prompt");
    });

    it("turns the sign-in screen path off", () => {
      expect(decideUpdateAction(safe({ signedIn: false, dismissed: true }))).toBe("prompt");
    });

    it("is cleared by coming back to the app, so a return still applies it", () => {
      // The banner resets the dismissal before it evaluates a return; the
      // fact is false by then. A dismissed update is never forgotten.
      expect(
        decideUpdateAction(
          facts({ hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS, dismissed: false }),
        ),
      ).toBe("reload");
    });
  });
});

describe("queued work holds an automatic reload", () => {
  // The outboxes replay clock punches, installs and photos in the background.
  // A reload mid-drain can send the same punch twice, and clock_out is not
  // idempotent on the server. So every automatic path waits for the queues —
  // and asks again the moment they change, which is what "hold" means.

  it("holds the opening window while anything is still being sent", () => {
    expect(
      decideUpdateAction(facts({ onSafeSurface: true, freshForMs: 2_000, queuedWork: true })),
    ).toBe("hold");
  });

  it("holds the sign-in screen path", () => {
    expect(
      decideUpdateAction(facts({ onSafeSurface: true, signedIn: false, queuedWork: true })),
    ).toBe("hold");
  });

  it("holds the return after a long absence", () => {
    expect(
      decideUpdateAction(facts({ hiddenForMs: AUTO_RELOAD_AFTER_HIDDEN_MS, queuedWork: true })),
    ).toBe("hold");
  });

  it("holds ahead of the typing and tap checks", () => {
    // Typing is asked about again in four seconds; a queue is asked about
    // again when it changes. The queue is the longer wait, so it decides.
    expect(
      decideUpdateAction(
        facts({ onSafeSurface: true, freshForMs: 2_000, queuedWork: true, typing: true }),
      ),
    ).toBe("hold");
  });

  it("reloads once the queues are empty again", () => {
    expect(
      decideUpdateAction(facts({ onSafeSurface: true, freshForMs: 2_000, queuedWork: false })),
    ).toBe("reload");
  });

  it("never turns a prompt into a hold", () => {
    // Not a safe moment: the banner is the answer, queue or no queue. And
    // unsaved work still outranks everything.
    expect(decideUpdateAction(facts({ queuedWork: true }))).toBe("prompt");
    expect(
      decideUpdateAction(facts({ queuedWork: true, hasUnsavedWork: true, freshForMs: 1_000, onSafeSurface: true })),
    ).toBe("prompt");
  });

  it("is not a reason to check for a build", () => {
    expect(
      decideUpdateAction(facts({ swUpdateWaiting: false, queuedWork: true, latestBuildId: "new-sha" })),
    ).toBe("check");
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
