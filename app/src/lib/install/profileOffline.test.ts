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
  // The `profiles` row read failing on its own — a warm, still-valid sign-in,
  // but no signal to reach PostgREST. postgrest-js never rejects; it resolves
  // `{ data: null, error }`, which is what this mimics.
  profileError: null as unknown,
  profileStatus: 200,
}));

const ROW = { id: "u-1", display_name: "E2E Fixture", role: "installer" };

vi.mock("../supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "maybeSingle", "insert", "single"]) builder[m] = () => builder;
  builder.then = (resolve: (value: unknown) => void) =>
    resolve(auth.profileError
      ? { data: null, error: auth.profileError, status: auth.profileStatus }
      : { data: ROW, error: null, status: 200 });
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
  auth.profileError = null;
  auth.profileStatus = 200;
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

  it("throws when the auth server is too busy to say (429 'slow down', a 5xx) — that is not an answer either", async () => {
    auth.user = null;
    auth.userError = new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit");
    await expect(getMyProfile()).rejects.toBe(auth.userError);
    auth.userError = new AuthApiError("upstream failed", 505, undefined);
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

  // review-pr654: a warm, still-valid sign-in (auth answers fine — often from
  // the fixture/session cache) but the `profiles` row itself can't be read
  // (no signal). Before this fix that rejection went unhandled: under
  // networkMode "offlineFirst" a query whose first attempt throws stays
  // PAUSED rather than settled while offline, so useEffectiveRole's isLoading
  // never clears and RoleLanding is stuck on "Loading…" forever
  // (e2e/offline-queued-upgrade.pwa.ts, "known #654 gap" test).
  it("answers null, not a rejection, when the sign-in is fine but the profile row can't be read", async () => {
    auth.profileError = { message: "Failed to fetch" };
    await expect(getRealProfile()).resolves.toBeNull();
  });

  it("settles the role read when the profile server temporarily cannot answer (408, 429, 5xx)", async () => {
    for (const status of [408, 429, 503]) {
      // Postgrest-js puts HTTP status on the result, not on result.error.
      auth.profileStatus = status;
      auth.profileError = { message: status === 429 ? "Rate limit reached" : "Upstream unavailable", code: "" };
      await expect(getRealProfile()).resolves.toBeNull();
    }
  });

  it("still rejects a real (non-network) profile-read failure", async () => {
    auth.profileError = { message: "permission denied for table profiles", code: "42501" };
    await expect(getRealProfile()).rejects.toBe(auth.profileError);
  });

  it("does not hide a server permission denial just because the browser reports offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      for (const status of [401, 403]) {
        auth.profileStatus = status;
        auth.profileError = { message: "Access rejected", code: "" };
        await expect(getRealProfile()).rejects.toBe(auth.profileError);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not mistake a programming TypeError mentioning connection for a network outage", async () => {
    auth.profileError = new TypeError("Cannot read properties of undefined (reading 'connection')");
    await expect(getRealProfile()).rejects.toBe(auth.profileError);
  });

  it("unlike getRealProfile, getMyProfile still throws on the same read failure — it is the one the phone keeps, and a throw is what protects the cached copy", async () => {
    auth.profileError = { message: "Failed to fetch" };
    await expect(getMyProfile()).rejects.toBe(auth.profileError);
  });
});

describe("making sure a profile row exists (sign-in)", () => {
  it("throws with no signal, so the caller's catch keeps it quiet instead of acting on nobody", async () => {
    auth.session = null;
    auth.sessionError = noSignal();
    await expect(ensureMyProfile()).rejects.toBe(auth.sessionError);
  });
});
