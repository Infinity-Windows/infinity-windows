// "Couldn't ask" is not "no PIN" (2026-09-24).
//
// my_pin_status answers one question — does the signed-in person have a device
// PIN — and the lock in PinGate opens on "no". This read used to answer `false`
// for EVERY error, so with no signal (a refused request, a timed-out one, a
// token the server would not take) a person who has a PIN reopened the app
// straight past the lock. The one error that IS an answer is a database that
// predates the RPC: there is no PIN feature there, so nobody has one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown, status: 200 },
  calls: [] as string[],
}));

vi.mock("../supabase", () => ({
  supabase: {
    rpc: (fn: string) => {
      rpc.calls.push(fn);
      return Promise.resolve(rpc.result);
    },
  },
  supabaseConfigured: true,
}));

const { checkMyPin, myPinStatus } = await import("./api");
const { pinGateView } = await import("../pinGate");

beforeEach(() => {
  rpc.calls = [];
  rpc.result = { data: null, error: null, status: 200 };
});

describe("myPinStatus", () => {
  it("asks my_pin_status and returns the server's answer", async () => {
    rpc.result = { data: true, error: null, status: 200 };
    await expect(myPinStatus()).resolves.toBe(true);
    rpc.result = { data: false, error: null, status: 200 };
    await expect(myPinStatus()).resolves.toBe(false);
    expect(rpc.calls).toEqual(["my_pin_status", "my_pin_status"]);
  });

  it("throws when there is no signal instead of saying there is no PIN", async () => {
    // What postgrest-js hands back when fetch itself rejects.
    rpc.result = {
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
      status: 0,
    };
    await expect(myPinStatus()).rejects.toBeTruthy();
  });

  it("throws when the request ran out of time on weak signal", async () => {
    rpc.result = {
      data: null,
      error: { message: "TypeError: Request timed out: weak signal", details: "", hint: "", code: "" },
      status: 0,
    };
    await expect(myPinStatus()).rejects.toBeTruthy();
  });

  it("throws when the server refuses the caller", async () => {
    rpc.result = {
      data: null,
      error: { message: "permission denied for function my_pin_status", code: "42501" },
      status: 403,
    };
    await expect(myPinStatus()).rejects.toBeTruthy();
  });

  // Codex's review of #651 (2026-09-25): this read used to answer "no PIN" for
  // a missing function. PostgREST says the same thing (PGRST202) for a stale
  // schema cache, while the function is there and the person has a PIN — and
  // the lock opened on it with no PIN asked.
  it("a stale schema cache (PGRST202) is not a no: the lock stays shut and offers Try again", async () => {
    rpc.result = {
      data: null,
      error: {
        message: "Could not find the function public.my_pin_status in the schema cache",
        code: "PGRST202",
      },
      status: 404,
    };
    const hasPin = await myPinStatus().then(
      (answer) => answer,
      () => undefined,
    );
    expect(hasPin).toBeUndefined();
    expect(
      pinGateView({ unlocked: false, restoring: false, hasPin, asking: false, profileLoading: false, waitedOut: false }),
    ).toBe("no-answer");
  });
});

// Which failures count as "the server could not be reached" decides whether
// PinGate may fall back to the offline unlock (lib/offlinePin.ts) — so an
// answer from the server must never be read as one.
describe("checkMyPin", () => {
  const failure = (status: number) => ({
    data: null,
    error: { message: status ? "server said no" : "TypeError: Failed to fetch", code: "" },
    status,
  });

  it("a yes and a no from the server are exactly that", async () => {
    rpc.result = { data: true, error: null, status: 200 };
    await expect(checkMyPin("4821")).resolves.toEqual({ ok: true });
    rpc.result = { data: false, error: null, status: 200 };
    await expect(checkMyPin("1111")).resolves.toEqual({ ok: false, reason: "wrong" });
    expect(rpc.calls).toEqual(["check_my_pin", "check_my_pin"]);
  });

  it("no answer at all — no signal, a dropped or timed-out request — is \"network\"", async () => {
    rpc.result = failure(0);
    await expect(checkMyPin("4821")).resolves.toEqual({ ok: false, reason: "network" });
  });

  it("the server itself failing is \"network\" too: it cannot judge", async () => {
    for (const status of [500, 502, 503, 504]) {
      rpc.result = failure(status);
      await expect(checkMyPin("4821")).resolves.toEqual({ ok: false, reason: "network" });
    }
  });

  it("the server answering and refusing is \"error\", never \"network\"", async () => {
    for (const status of [400, 401, 403, 404]) {
      rpc.result = failure(status);
      await expect(checkMyPin("4821")).resolves.toEqual({ ok: false, reason: "error" });
    }
  });
});
