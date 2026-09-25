// @vitest-environment happy-dom
//
// Release 0, K0.5: the memory of this device's last clock check, and the stamp
// every punch sends the server. The server decides trust; this side only has
// to report honestly — and to keep checking often enough that an honest phone
// is trusted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const authListeners: Array<(event: string) => void> = [];
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: {
      onAuthStateChange: (cb: (event: string) => void) => {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
  supabaseConfigured: true,
}));

import {
  CLOCK_RECHECK_MS,
  clockCheckIsFresh,
  clockTrustStamp,
  ensureClockChecked,
  forgetClockCheck,
  installClockCheck,
  lastClockCheck,
  recordClockCheck,
} from "./clockSkew";
import { carriedPunch, isPendingShiftRef, mintPunch, newClockActionId } from "./clockPunch";
import { pendingCompletionOf } from "./toolboxSign";

const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);

beforeEach(() => {
  forgetClockCheck();
  rpc.mockReset();
});
afterEach(() => forgetClockCheck());

describe("recordClockCheck / lastClockCheck", () => {
  it("remembers the device time, the server time and the skew between them", () => {
    recordClockCheck(T0 + 40_000, T0);
    expect(lastClockCheck()).toEqual({ deviceAtMs: T0 + 40_000, serverAtMs: T0, skewMs: 40_000 });
  });

  it("survives a reload through localStorage", () => {
    recordClockCheck(T0 + 40_000, T0);
    forgetClockCheckInMemoryOnly();
    expect(lastClockCheck()?.skewMs).toBe(40_000);
  });

  it("ignores a corrupt stored value rather than trusting garbage", () => {
    localStorage.setItem("iw:clockCheck", '{"deviceAtMs":"soon"}');
    expect(lastClockCheck()).toBeNull();
  });

  it("keeps the in-memory copy when storage is unavailable", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      recordClockCheck(T0 + 5, T0);
      expect(lastClockCheck()?.skewMs).toBe(5);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe("clockTrustStamp", () => {
  it("sends nulls for a phone that has never checked — the server then uses arrival time", () => {
    expect(clockTrustStamp(T0)).toEqual({
      tappedAt: "2026-09-23T12:00:00.000Z",
      clockCheckedAt: null,
      clockSkewMs: null,
    });
  });

  it("sends the SERVER time of the last check, so its age is measured on one clock", () => {
    recordClockCheck(T0 - 3600_000 + 90_000, T0 - 3600_000);
    expect(clockTrustStamp(T0)).toEqual({
      tappedAt: "2026-09-23T12:00:00.000Z",
      clockCheckedAt: new Date(T0 - 3600_000).toISOString(),
      clockSkewMs: 90_000,
    });
  });
});

describe("clockCheckIsFresh mirrors the server's rule", () => {
  it("is false with no check, past a day, or past two minutes of skew", () => {
    expect(clockCheckIsFresh(T0)).toBe(false);
    recordClockCheck(T0 - 25 * 3600_000, T0 - 25 * 3600_000);
    expect(clockCheckIsFresh(T0)).toBe(false);
    recordClockCheck(T0 - 60_000 + 121_000, T0 - 60_000);
    expect(clockCheckIsFresh(T0)).toBe(false);
  });
  it("is true for a recent check within two minutes", () => {
    recordClockCheck(T0 - 23 * 3600_000 + 119_000, T0 - 23 * 3600_000);
    expect(clockCheckIsFresh(T0)).toBe(true);
  });
});

describe("ensureClockChecked", () => {
  it("asks the server when there is no check yet, and records the answer", async () => {
    rpc.mockResolvedValueOnce({ data: new Date(T0).toISOString(), error: null });
    const check = await ensureClockChecked(T0);
    expect(rpc).toHaveBeenCalledWith("server_now");
    expect(check?.serverAtMs).toBe(T0);
    expect(lastClockCheck()?.serverAtMs).toBe(T0);
  });

  it("does not bother the server again inside the recheck window", async () => {
    recordClockCheck(T0, T0);
    expect(await ensureClockChecked(T0 + CLOCK_RECHECK_MS - 1)).toEqual(lastClockCheck());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks again once the window has passed", async () => {
    recordClockCheck(T0, T0);
    rpc.mockResolvedValueOnce({ data: new Date(T0 + CLOCK_RECHECK_MS).toISOString(), error: null });
    await ensureClockChecked(T0 + CLOCK_RECHECK_MS + 1);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good check when the server cannot be reached", async () => {
    recordClockCheck(T0 - 2 * CLOCK_RECHECK_MS, T0 - 2 * CLOCK_RECHECK_MS);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    const check = await ensureClockChecked(T0);
    expect(check?.serverAtMs).toBe(T0 - 2 * CLOCK_RECHECK_MS);
    expect(lastClockCheck()?.serverAtMs).toBe(T0 - 2 * CLOCK_RECHECK_MS);
  });
});

describe("the punch", () => {
  it("carries the id it is given, or mints a uuid", () => {
    expect(mintPunch("keep", T0).clientId).toBe("keep");
    expect(newClockActionId()).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("carries the device's last check beside the tap time", () => {
    recordClockCheck(T0 - 1000 + 250, T0 - 1000);
    const p = mintPunch(null, T0);
    expect(p.tappedAt).toBe("2026-09-23T12:00:00.000Z");
    expect(p.clockCheckedAt).toBe(new Date(T0 - 1000).toISOString());
    expect(p.clockSkewMs).toBe(250);
  });
  it("knows a made-up shift id when it sees one", () => {
    expect(isPendingShiftRef("pending:abc")).toBe(true);
    expect(isPendingShiftRef("11111111-2222-4333-8444-555555555555")).toBe(false);
    expect(isPendingShiftRef(null)).toBe(false);
    expect(isPendingShiftRef(undefined)).toBe(false);
  });
});

// A tap handed from the landing block (or Start day) to the clock sheet is the
// SAME punch when the sheet sends it — never re-stamped at the sheet's later
// tap, which lost the time in between when the first request never arrived
// (Codex review of #640). The one exception is today's talk signed after the
// tap: paid time starts at the signature, under the same id.
describe("a carried punch", () => {
  const TAPPED = {
    clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77",
    tappedAt: "2026-09-23T12:00:00.000Z",
    clockCheckedAt: "2026-09-23T11:58:30.000Z",
    clockSkewMs: 1500,
  };

  it("is sent exactly as it was stamped when the talk was signed before the tap, or not at all", () => {
    expect(carriedPunch(TAPPED, "2026-09-23T11:05:00.000Z")).toBe(TAPPED);
    expect(carriedPunch(TAPPED, TAPPED.tappedAt)).toBe(TAPPED);
    expect(carriedPunch(TAPPED, null)).toBe(TAPPED);
    expect(carriedPunch(TAPPED, undefined)).toBe(TAPPED);
    expect(carriedPunch(TAPPED, "not a time")).toBe(TAPPED);
  });

  it("is stamped at the signature, under the same id, when the talk was signed after the tap", () => {
    recordClockCheck(T0 - 1000 + 250, T0 - 1000);
    const signedAt = "2026-09-23T12:00:40.000Z";
    const sent = carriedPunch(TAPPED, signedAt);
    expect(sent.clientId).toBe(TAPPED.clientId);
    expect(sent.tappedAt).toBe(signedAt);
    // Stamped the way every tap is: with this phone's current clock check.
    expect(sent.clockCheckedAt).toBe(new Date(T0 - 1000).toISOString());
    expect(sent.clockSkewMs).toBe(250);
  });

  // Offline toolbox signing (2026-09-25): a talk signed with no signal is
  // still on the phone when the sheet sends the carried tap. The gates read it
  // as today's completion (useToolboxToday), and its signing time — the
  // phone's clock at the signature — is what the tap is re-stamped at, the
  // same as for a signature Forge already has.
  it("is stamped at a signature still on the phone, when that was made after the tap", () => {
    const onPhone = pendingCompletionOf({
      entryId: "sig-1",
      clientId: "sig-1",
      profileId: "me",
      talkId: "t1",
      typedName: "Dana",
      signedAt: "2026-09-23T12:00:40.000Z",
      status: "queued",
      lastError: null,
    });
    const sent = carriedPunch(TAPPED, onPhone.signed_at);
    expect(sent.clientId).toBe(TAPPED.clientId);
    expect(sent.tappedAt).toBe("2026-09-23T12:00:40.000Z");
    // Signed on the phone BEFORE the tap: the tap stands, untouched.
    const early = pendingCompletionOf({
      entryId: "sig-2",
      clientId: "sig-2",
      profileId: "me",
      talkId: "t1",
      typedName: "Dana",
      signedAt: "2026-09-23T11:59:00.000Z",
      status: "queued",
      lastError: null,
    });
    expect(carriedPunch(TAPPED, early.signed_at)).toBe(TAPPED);
  });
});

/** Drop only the module's in-memory copy, leaving localStorage as a reload would. */
function forgetClockCheckInMemoryOnly() {
  const stored = localStorage.getItem("iw:clockCheck");
  forgetClockCheck();
  if (stored) localStorage.setItem("iw:clockCheck", stored);
}

describe("installClockCheck wires the check to the moments a phone has signal", () => {
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("checks at install, on sign-in, on coming back to the foreground and when the network returns — once each, throttled", async () => {
    rpc.mockResolvedValue({ data: new Date().toISOString(), error: null });
    installClockCheck();
    // Sign-in lands in the same instant as start-up: one question, not two.
    for (const cb of authListeners) cb("SIGNED_IN");
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    // The throttle: a check just landed, so none of these ask again ...
    for (const cb of authListeners) cb("SIGNED_IN");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    // ... until the last check is stale.
    forgetClockCheck();
    for (const cb of authListeners) cb("SIGNED_IN");
    await settle();
    expect(rpc).toHaveBeenCalledTimes(2);
    forgetClockCheck();
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(rpc).toHaveBeenCalledTimes(3);
    // Installing twice wires nothing twice, and signing out asks nothing.
    installClockCheck();
    forgetClockCheck();
    for (const cb of authListeners) cb("SIGNED_OUT");
    await settle();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(authListeners).toHaveLength(1);
  });
});
