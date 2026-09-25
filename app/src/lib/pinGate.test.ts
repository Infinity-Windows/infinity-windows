// The device lock's one rule, checked exhaustively: it opens on a definite "no
// PIN" (or an unlock earlier in this launch) and on nothing else. Every
// combination of what the phone can know is walked, so a later change that
// lets "couldn't ask" or "still asking" through fails here by name.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TAB_UNLOCK_KEY,
  isUnlockedInThisTab,
  pinGateView,
  rememberUnlockInThisTab,
  syncPinLockWithAuth,
  type PinGateFacts,
} from "./pinGate";

// The offline unlock has its own tests (offlinePin.test.ts); here it is only
// checked that the lock passes every sign-in change on to it.
const offline = vi.hoisted(() => ({ syncOfflinePinWithAuth: vi.fn() }));
vi.mock("./offlinePin", () => ({
  syncOfflinePinWithAuth: (...a: unknown[]) => offline.syncOfflinePinWithAuth(...a),
}));

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

const ANA = "00000000-0000-4000-8000-0000000000a1";
const BEN = "00000000-0000-4000-8000-0000000000b2";

/** This tab's sessionStorage. */
function tabStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

let tab: ReturnType<typeof tabStorage>;
beforeEach(() => {
  tab = tabStorage();
  offline.syncOfflinePinWithAuth.mockClear();
});

// The per-tab unlock used to be a bare "1" that opened the lock for whoever
// was signed in next (Codex review of #651, 2026-09-25).
describe("the per-tab unlock", () => {
  it("opens only for the person who unlocked", () => {
    expect(isUnlockedInThisTab(ANA, tab)).toBe(false);
    rememberUnlockInThisTab(ANA, tab);
    expect(tab.map.get(TAB_UNLOCK_KEY)).toBe(ANA);
    expect(isUnlockedInThisTab(ANA, tab)).toBe(true);
    expect(isUnlockedInThisTab(BEN, tab)).toBe(false);
  });

  it("the old bare \"1\" is nobody's, so it opens nothing", () => {
    tab.map.set(TAB_UNLOCK_KEY, "1");
    expect(isUnlockedInThisTab(ANA, tab)).toBe(false);
  });

  it("with storage switched off or failing nobody is unlocked, and nothing breaks", () => {
    expect(isUnlockedInThisTab(ANA, null)).toBe(false);
    expect(() => rememberUnlockInThisTab(ANA, null)).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(isUnlockedInThisTab(ANA, broken)).toBe(false);
    expect(() => rememberUnlockInThisTab(ANA, broken)).not.toThrow();
    expect(() => syncPinLockWithAuth("SIGNED_OUT", null, broken)).not.toThrow();
  });
});

describe("syncPinLockWithAuth — every change of who is signed in", () => {
  it("signing out ends the per-tab unlock, and the offline unlock hears of it", () => {
    rememberUnlockInThisTab(ANA, tab);
    syncPinLockWithAuth("SIGNED_OUT", null, tab);
    expect(tab.map.size).toBe(0);
    expect(offline.syncOfflinePinWithAuth).toHaveBeenCalledWith("SIGNED_OUT", null);
  });

  it("somebody else signing in ends it, with no sign-out between", () => {
    rememberUnlockInThisTab(ANA, tab);
    syncPinLockWithAuth("SIGNED_IN", BEN, tab);
    expect(tab.map.size).toBe(0);
    expect(offline.syncOfflinePinWithAuth).toHaveBeenCalledWith("SIGNED_IN", BEN);
  });

  it("the same person carrying on — a token refresh, a return to the app — keeps it", () => {
    rememberUnlockInThisTab(ANA, tab);
    for (const event of ["INITIAL_SESSION", "TOKEN_REFRESHED", "SIGNED_IN", "USER_UPDATED"]) {
      syncPinLockWithAuth(event, ANA, tab);
      expect(isUnlockedInThisTab(ANA, tab)).toBe(true);
    }
  });

  it("a launch that comes back with no session ends it", () => {
    rememberUnlockInThisTab(ANA, tab);
    syncPinLockWithAuth("INITIAL_SESSION", null, tab);
    expect(tab.map.size).toBe(0);
  });

  it("an old bare \"1\" is cleared at the first sign-in it meets", () => {
    tab.map.set(TAB_UNLOCK_KEY, "1");
    syncPinLockWithAuth("INITIAL_SESSION", ANA, tab);
    expect(tab.map.size).toBe(0);
  });
});
