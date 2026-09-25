// The profile, read with no signal (2026-09-24).
//
// "Couldn't ask who is signed in" used to come back as "nobody", and the
// profile read returned null — which React Query then saved over the profile
// the phone had kept, so a launch with no signal emptied every screen that
// needs it (the clock block renders nothing without a profile id). The kept
// read now THROWS instead, and a throw is what makes React Query keep the
// saved copy. e2e/offline-session.spec.ts (b) shows it on a phone; these pin
// each answer the auth client can give.

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: null as unknown,
  sessionError: null as unknown,
  user: null as unknown,
  userError: null as unknown,
  getUserCalls: 0,
}));

const ROW = { id: "u-1", display_name: "E2E Fixture", role: "installer" };

vi.mock("../supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "maybeSingle", "insert", "single"]) builder[m] = () => builder;
  builder.then = (resolve: (value: unknown) => void) => resolve({ data: ROW, error: null });
  return {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: auth.session }, error: auth.sessionError }),
        getUser: async () => {
          auth.getUserCalls += 1;
          return { data: { user: auth.user }, error: auth.userError };
        },
      },
      from: () => builder,
      rpc: async () => ({ data: null, error: null }),
    },
    supabaseConfigured: true,
  };
});

const { ensureMyProfile, getMyProfile, getRealProfile } = await import("./api");

const USER = { id: "u-1", email: "installer@example.com" };
const SESSION = { access_token: "a", refresh_token: "r", expires_at: 2_066_000_000, user: USER };
const noSignal = () => new AuthRetryableFetchError("Failed to fetch", 0);

beforeEach(() => {
  auth.session = SESSION;
  auth.sessionError = null;
  auth.user = USER;
  auth.userError = null;
  auth.getUserCalls = 0;
});

describe("the profile the phone keeps (myProfile)", () => {
  it("reads normally with signal", async () => {
    await expect(getMyProfile()).resolves.toEqual(ROW);
  });

  it("throws, rather than answering nobody, when the sign-in could not be renewed", async () => {
    auth.session = null;
    auth.sessionError = noSignal();
    await expect(getMyProfile()).rejects.toBe(auth.sessionError);
    // And never sat behind getUser, which would wait out the renewal retries.
    expect(auth.getUserCalls).toBe(0);
  });

  it("throws when the sign-in is good but the auth server cannot be reached to check it", async () => {
    auth.user = null;
    auth.userError = noSignal();
    await expect(getMyProfile()).rejects.toBe(auth.userError);
  });

  it("still answers null when nobody is signed in, or the auth server says the sign-in is no good", async () => {
    auth.session = null;
    await expect(getMyProfile()).resolves.toBeNull();

    auth.session = SESSION;
    auth.user = null;
    auth.userError = new AuthSessionMissingError();
    await expect(getMyProfile()).resolves.toBeNull();

    auth.userError = new AuthApiError("User from sub claim in JWT does not exist", 403, "user_not_found");
    await expect(getMyProfile()).resolves.toBeNull();
  });
});

describe("the real profile (myRealProfile — not kept on the phone)", () => {
  it("answers null with no signal, as it always has: there is no saved copy to protect, and an error with no copy loops the landing", async () => {
    auth.session = null;
    auth.sessionError = noSignal();
    await expect(getRealProfile()).resolves.toBeNull();
    auth.session = SESSION;
    auth.user = null;
    auth.userError = noSignal();
    await expect(getRealProfile()).resolves.toBeNull();
  });

  it("reads normally with signal", async () => {
    await expect(getRealProfile()).resolves.toEqual(ROW);
  });
});

describe("making sure a profile row exists (sign-in)", () => {
  it("throws with no signal, so the caller's catch keeps it quiet instead of acting on nobody", async () => {
    auth.session = null;
    auth.sessionError = noSignal();
    await expect(ensureMyProfile()).rejects.toBe(auth.sessionError);
  });
});
