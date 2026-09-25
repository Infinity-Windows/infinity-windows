// The device lock's one rule, checked exhaustively: it opens on a definite "no
// PIN" (or an unlock earlier in this launch) and on nothing else. Every
// combination of what the phone can know is walked, so a later change that
// lets "couldn't ask" or "still asking" through fails here by name.

import { describe, expect, it } from "vitest";
import { pinGateView, type PinGateFacts } from "./pinGate";

const base: PinGateFacts = {
  unlocked: false,
  restoring: false,
  hasPin: undefined,
  asking: false,
  profileLoading: false,
  waitedOut: false,
};

const view = (over: Partial<PinGateFacts>) => pinGateView({ ...base, ...over });

describe("pinGateView", () => {
  it("never opens without a definite no-PIN answer or an unlock this launch", () => {
    for (const restoring of [false, true])
      for (const hasPin of [undefined, true, false])
        for (const asking of [false, true])
          for (const profileLoading of [false, true])
            for (const waitedOut of [false, true]) {
              const facts = { unlocked: false, restoring, hasPin, asking, profileLoading, waitedOut };
              if (pinGateView(facts) === "open") {
                expect(facts, "opened without a definite no").toMatchObject({ hasPin: false, restoring: false });
              }
            }
  });

  it("an unlock earlier in this launch opens, whatever else is going on", () => {
    expect(view({ unlocked: true })).toBe("open");
    expect(view({ unlocked: true, restoring: true, hasPin: true, asking: true })).toBe("open");
  });

  it("holds on Checking while the phone's saved copy is read back", () => {
    expect(view({ restoring: true })).toBe("checking");
    expect(view({ restoring: true, hasPin: false })).toBe("checking");
    expect(view({ restoring: true, waitedOut: true })).toBe("checking");
  });

  it("with signal: checks, then the pad or the app (unchanged)", () => {
    expect(view({ asking: true })).toBe("checking");
    expect(view({ hasPin: true })).toBe("pin");
    expect(view({ hasPin: false })).toBe("open");
    // The name on the pad is waited for, as before…
    expect(view({ hasPin: true, profileLoading: true })).toBe("checking");
    expect(view({ hasPin: false, profileLoading: true })).toBe("checking");
  });

  it("…but never for longer than the lock's wait", () => {
    expect(view({ hasPin: true, profileLoading: true, waitedOut: true })).toBe("pin");
    expect(view({ hasPin: false, profileLoading: true, waitedOut: true })).toBe("open");
  });

  it("no answer yet: Checking while asking, then a plain message — never an endless spinner", () => {
    expect(view({ asking: true })).toBe("checking");
    expect(view({ asking: true, waitedOut: true })).toBe("no-answer");
    // The read failed (no signal): no waiting for the timer at all.
    expect(view({ asking: false })).toBe("no-answer");
  });

  it("a saved answer is used straight away, even while a re-check hangs", () => {
    expect(view({ hasPin: true, asking: true })).toBe("pin");
    expect(view({ hasPin: false, asking: true })).toBe("open");
  });
});
