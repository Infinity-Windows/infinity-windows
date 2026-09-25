// The three rules that keep a phone signed in with no signal (2026-09-24).
// The browser-level proof — a phone reopened in a dead zone the morning after
// — is e2e/offline-session.spec.ts; these hold each rule on its own.

import { createClient, isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  answerSoonerWhenOffline,
  authStorageKey,
  createRenewalWatch,
  isRenewal,
  readStoredSession,
  RENEW_MARGIN_MS,
  RENEWAL_TROUBLE_WINDOW_MS,
  sentAsNobody,
  sessionToKeep,
  WAITING_TO_RENEW,
} from "./offlineSession";
import { isNetworkError, isRetryableError } from "./offline/outbox-core";
import { formatApiError } from "./errors";

const NOW = Date.parse("2026-09-24T07:00:00Z");

function session(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "access",
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(NOW / 1000) + 3600,
    user: { id: "u-1", email: "installer@example.com" },
    ...overrides,
  } as Session;
}

/** Ran out overnight. */
const expired = () => session({ expires_at: Math.floor(NOW / 1000) - 2 * 3600 });

function storageWith(value: string | null) {
  return { getItem: vi.fn(() => value) };
}

describe("where the sign-in is kept", () => {
  it("is the key supabase-js itself uses, so spelling it out moved nobody's sign-in", () => {
    for (const url of ["https://czprjcskmzzagdztqonm.supabase.co", "http://localhost:54321"]) {
      const client = createClient(url, "anon-key", { auth: { autoRefreshToken: false, persistSession: false } });
      expect(authStorageKey(url)).toBe((client as unknown as { storageKey: string }).storageKey);
    }
    expect(authStorageKey("https://czprjcskmzzagdztqonm.supabase.co")).toBe(
      "sb-czprjcskmzzagdztqonm-auth-token",
    );
  });

  it("reads a whole kept sign-in back", () => {
    const kept = session();
    expect(readStoredSession(storageWith(JSON.stringify(kept)), "k")).toEqual(kept);
  });

  it("finds none when nothing is kept, or what is kept is not a whole sign-in", () => {
    expect(readStoredSession(storageWith(null), "k")).toBeNull();
    expect(readStoredSession(null, "k")).toBeNull();
    expect(readStoredSession(storageWith("{not json"), "k")).toBeNull();
    expect(readStoredSession(storageWith("null"), "k")).toBeNull();
    const { refresh_token: _r, ...noRefresh } = session();
    expect(readStoredSession(storageWith(JSON.stringify(noRefresh)), "k")).toBeNull();
    expect(readStoredSession(storageWith(JSON.stringify({ ...session(), user: null })), "k")).toBeNull();
    expect(readStoredSession(storageWith(JSON.stringify({ ...session(), expires_at: "soon" })), "k")).toBeNull();
  });

  it("never throws, even when storage does", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readStoredSession(broken, "k")).toBeNull();
  });
});

describe("which session App holds", () => {
  it("takes a real session whenever auth gives one", () => {
    const fresh = session({ access_token: "renewed" });
    expect(sessionToKeep({ from: "load", session: fresh }, expired())).toBe(fresh);
    for (const event of ["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"] as const) {
      expect(sessionToKeep({ from: "event", event, session: fresh }, null)).toBe(fresh);
    }
  });

  it("stays signed in when the renewal could not reach the auth server — the phone still holds the sign-in", () => {
    const kept = expired();
    expect(sessionToKeep({ from: "load", session: null }, kept)).toBe(kept);
    expect(sessionToKeep({ from: "event", event: "INITIAL_SESSION", session: null }, kept)).toBe(kept);
  });

  it("signs out when supabase-js has deleted the sign-in — a definite refusal", () => {
    expect(sessionToKeep({ from: "load", session: null }, null)).toBeNull();
    expect(sessionToKeep({ from: "event", event: "INITIAL_SESSION", session: null }, null)).toBeNull();
  });

  it("treats SIGNED_OUT as final, whatever is still in storage", () => {
    expect(sessionToKeep({ from: "event", event: "SIGNED_OUT", session: null }, expired())).toBeNull();
  });
});

describe("getSession when the sign-in cannot be renewed", () => {
  type Answer = Awaited<ReturnType<Parameters<typeof answerSoonerWhenOffline>[0]>>;
  const NO_SESSION: Answer = { data: { session: null }, error: null };

  /** A renewal watch on the test clock, and the library's getSession as a spy. */
  function rig(stored: Session | null, { online = true } = {}) {
    let now = NOW;
    const renewals = createRenewalWatch(() => now);
    let finish: (a: Answer) => void = () => {};
    const load = vi.fn(() => new Promise<Answer>((resolve) => (finish = resolve)));
    const deps = { stored: () => stored, online: () => online, renewals, now: () => now };
    return {
      getSession: answerSoonerWhenOffline(load, deps),
      load,
      renewals,
      /** The library's own getSession comes back with this. */
      finish: (a: Answer) => finish(a),
      goOnline: () => {
        online = true;
      },
      wait: (ms: number) => {
        now += ms;
      },
    };
  }

  it("is the library's own getSession for a sign-in that needs no renewing, or no sign-in at all", async () => {
    for (const stored of [session(), null]) {
      const r = rig(stored, { online: false });
      const answer = r.getSession();
      r.finish(NO_SESSION);
      await expect(answer).resolves.toBe(NO_SESSION);
      expect(r.load).toHaveBeenCalledTimes(1);
    }
  });

  it("answers an expired sign-in at once when the phone knows it is offline: no session and a network error, what supabase-js says after half a minute of retries", async () => {
    const r = rig(expired(), { online: false });
    const { data, error } = await r.getSession();
    expect(r.load).not.toHaveBeenCalled();
    expect(data.session).toBeNull();
    expect(isAuthRetryableFetchError(error)).toBe(true);
  });

  it("hands back a sign-in inside the renewal margin that has not actually run out", async () => {
    const nearlyDue = session({ expires_at: Math.floor((NOW + RENEW_MARGIN_MS / 2) / 1000) });
    const { data, error } = await rig(nearlyDue, { online: false }).getSession();
    expect(data.session).toBe(nearlyDue);
    expect(error).toBeNull();
  });

  it("with a network, waits for the renewal — and takes its answer when it gets one", async () => {
    const r = rig(expired());
    const answer = r.getSession();
    const renewed = { data: { session: session({ access_token: "renewed" }) }, error: null } as Answer;
    r.finish(renewed);
    await expect(answer).resolves.toBe(renewed);
  });

  it("stops waiting the moment a renewal fails to reach the auth server (one bar: the phone thinks it is online)", async () => {
    const r = rig(expired());
    const answer = r.getSession();
    expect(r.load).toHaveBeenCalledTimes(1);
    r.renewals.trouble();
    const { data, error } = await answer;
    expect(data.session).toBeNull();
    expect(isAuthRetryableFetchError(error)).toBe(true);
  });

  it("after a failed renewal, answers at once for a while — then gives the next renewal a real try", async () => {
    const r = rig(expired());
    r.renewals.trouble();
    await r.getSession();
    expect(r.load).not.toHaveBeenCalled();
    r.wait(RENEWAL_TROUBLE_WINDOW_MS);
    void r.getSession();
    expect(r.load).toHaveBeenCalledTimes(1);
  });

  it("gives the renewal a real try again as soon as one gets an answer, or the phone comes back online", async () => {
    const answered = rig(expired());
    answered.renewals.trouble();
    answered.renewals.forget();
    void answered.getSession();
    expect(answered.load).toHaveBeenCalledTimes(1);

    const offline = rig(expired(), { online: false });
    await offline.getSession();
    expect(offline.load).not.toHaveBeenCalled();
    offline.goOnline();
    void offline.getSession();
    expect(offline.load).toHaveBeenCalledTimes(1);
  });

  it("tells a renewal from every other request", () => {
    expect(isRenewal("https://p.supabase.co/auth/v1/token?grant_type=refresh_token")).toBe(true);
    expect(isRenewal("https://p.supabase.co/auth/v1/token?grant_type=password")).toBe(false);
    expect(isRenewal("https://p.supabase.co/auth/v1/user")).toBe(false);
    expect(isRenewal("https://p.supabase.co/rest/v1/profiles?select=id")).toBe(false);
  });
});

describe("a signed-in phone never talks to the database as nobody", () => {
  const KEY = "public-key";
  const REST = "https://p.supabase.co/rest/v1/rpc/clock_in";

  it("spots the public key where a person's token belongs", () => {
    expect(sentAsNobody(REST, { headers: { Authorization: `Bearer ${KEY}` } }, KEY)).toBe(true);
    expect(sentAsNobody(REST, { headers: new Headers({ authorization: `Bearer ${KEY}` }) }, KEY)).toBe(true);
    expect(
      sentAsNobody("https://p.supabase.co/storage/v1/object/install-media/a.jpg", { headers: [["Authorization", `Bearer ${KEY}`]] }, KEY),
    ).toBe(true);
  });

  it("spots no token at all, which is how a function call goes out as nobody", () => {
    expect(sentAsNobody("https://p.supabase.co/functions/v1/transcribe", { headers: {} }, KEY)).toBe(true);
    expect(sentAsNobody(REST, undefined, KEY)).toBe(true);
  });

  it("lets a person's own token through", () => {
    expect(sentAsNobody(REST, { headers: { Authorization: "Bearer eyJ.person.token" } }, KEY)).toBe(false);
    const request = new Request(REST, { headers: { Authorization: "Bearer eyJ.person.token" } });
    expect(sentAsNobody(request, undefined, KEY)).toBe(false);
  });

  it("leaves the auth server alone — renewing a sign-in is sent with the public key by design", () => {
    expect(
      sentAsNobody("https://p.supabase.co/auth/v1/token?grant_type=refresh_token", { headers: { Authorization: `Bearer ${KEY}` } }, KEY),
    ).toBe(false);
    expect(sentAsNobody("http://localhost:5173/assets/index.js", undefined, KEY)).toBe(false);
  });

  it("fails the way no signal fails, so every queue waits and every screen keeps its saved copy", () => {
    // The postgrest client wraps a thrown fetch error as `${name}: ${message}`.
    const asTheDatabaseClientReportsIt = { message: `TypeError: ${WAITING_TO_RENEW}`, code: "" };
    expect(isNetworkError(asTheDatabaseClientReportsIt)).toBe(true);
    expect(isRetryableError(asTheDatabaseClientReportsIt)).toBe(true);
    expect(isNetworkError(new TypeError(WAITING_TO_RENEW))).toBe(true);
    expect(formatApiError(asTheDatabaseClientReportsIt)).toBe(
      "You appear to be offline. Check your connection and try again.",
    );
  });
});
