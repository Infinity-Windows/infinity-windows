// A sign-out the person asked for is marked for exactly as long as it takes
// (2026-09-24). App reads the mark when SIGNED_OUT arrives — supabase-js
// delivers that event before signOut() returns — to tell "you tapped Sign
// out" from "the server ended your sign-in", which is the one that gets a
// sentence on the sign-in screen.

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  /** Stands in for App's listener, which supabase-js calls inside signOut(). */
  listener: () => {},
  fail: false,
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      signOut: async () => {
        auth.listener();
        if (auth.fail) throw new Error("no signal");
        return { error: null };
      },
    },
  },
}));

const { signOutOnRequest, signOutWasRequested } = await import("./signOut");

let seenBySignedOut: boolean | null = null;

beforeEach(() => {
  seenBySignedOut = null;
  auth.fail = false;
  auth.listener = () => {
    seenBySignedOut = signOutWasRequested();
  };
});

describe("signing out on request", () => {
  it("is marked while the sign-out runs, and not before or after", async () => {
    expect(signOutWasRequested()).toBe(false);
    await signOutOnRequest();
    expect(seenBySignedOut).toBe(true);
    expect(signOutWasRequested()).toBe(false);
  });

  it("drops the mark even when the sign-out fails, so a later refusal by the server still gets its sentence", async () => {
    auth.fail = true;
    await expect(signOutOnRequest()).rejects.toThrow("no signal");
    expect(signOutWasRequested()).toBe(false);
  });
});
