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
  result: { data: null as unknown, error: null as unknown },
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

const { myPinStatus } = await import("./api");

beforeEach(() => {
  rpc.calls = [];
  rpc.result = { data: null, error: null };
});

describe("myPinStatus", () => {
  it("asks my_pin_status and returns the server's answer", async () => {
    rpc.result = { data: true, error: null };
    await expect(myPinStatus()).resolves.toBe(true);
    rpc.result = { data: false, error: null };
    await expect(myPinStatus()).resolves.toBe(false);
    expect(rpc.calls).toEqual(["my_pin_status", "my_pin_status"]);
  });

  it("throws when there is no signal instead of saying there is no PIN", async () => {
    // What postgrest-js hands back when fetch itself rejects.
    rpc.result = {
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
    };
    await expect(myPinStatus()).rejects.toBeTruthy();
  });

  it("throws when the request ran out of time on weak signal", async () => {
    rpc.result = {
      data: null,
      error: { message: "TypeError: Request timed out: weak signal", details: "", hint: "", code: "" },
    };
    await expect(myPinStatus()).rejects.toBeTruthy();
  });

  it("throws when the server refuses the caller", async () => {
    rpc.result = {
      data: null,
      error: { message: "permission denied for function my_pin_status", code: "42501" },
    };
    await expect(myPinStatus()).rejects.toBeTruthy();
  });

  it("says no PIN on a database that predates the RPC", async () => {
    rpc.result = {
      data: null,
      error: { message: "Could not find the function public.my_pin_status", code: "PGRST202" },
    };
    await expect(myPinStatus()).resolves.toBe(false);
  });
});
