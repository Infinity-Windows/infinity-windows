// Which answers from the auth server end a sign-in, and which do not (Codex
// review of #654, finding 2, 2026-09-25) — proved with the real supabase-js
// the app ships (2.110.6), wired the way lib/supabase.ts wires it.
//
// Two ways the first version got this wrong, both reproduced by Codex:
//   - A refusal the phone had already SEEN could still be kept offline.
//     supabase-js keeps a sign-in whose renewal is refused while its access
//     token still works ("proactive"), and the offline fallback took "still in
//     storage" as "never refused": once the token ran out, a relaunch with no
//     signal opened the app on a login the server had revoked.
//   - The opposite: supabase-js signs a phone out on 429 "slow down" exactly
//     as it does on a revoked token. Throttling is not a revocation.
//
// The rule now, in one place (classifyRenewal): the auth server REFUSING the
// renewal (4xx, except 408 and 429) ends the sign-in on this phone — at once,
// and remembered, so no later launch can bring it back. Not reaching it (no
// signal, a timeout, 408, 429, 5xx) keeps it.

import { createClient, type Session } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerSoonerWhenOffline,
  classifyRenewal,
  createRefusalBook,
  createRenewalWatch,
  followSignIn,
  readStoredSession,
  sessionToKeep,
  signInAwareFetch,
} from "./offlineSession";

const NOW = Date.parse("2026-09-25T07:00:00Z");
const KEY = "sb-review-auth-token";
const REFUSALS = "review-refused-sign-ins";
const PUBLIC = "public-key";

function person(id: string, secondsLeft: number): Session {
  return {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + secondsLeft,
    user: { id, email: `${id}@example.com` },
  } as Session;
}

/** A phone's storage, as plain entries. */
function phone(signedIn: Session | null) {
  const values = new Map<string, string>();
  if (signedIn) values.set(KEY, JSON.stringify(signedIn));
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
  return { values, storage };
}

type Phone = ReturnType<typeof phone>;

/**
 * The real client on that phone, with the app's fetch around a fixture auth
 * server that answers every renewal with `status`.
 */
function appOn(p: Phone, status: number, body: Record<string, unknown>) {
  const refusals = createRefusalBook(p.storage, REFUSALS);
  const renewals = createRenewalWatch();
  const stored = () => readStoredSession(p.storage, KEY);
  const isRefused = (s: Session) => refusals.has(s.refresh_token);
  const send = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  const client = createClient("https://review.invalid", PUBLIC, {
    auth: {
      storageKey: KEY,
      storage: p.storage,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
    },
    global: {
      fetch: signInAwareFetch({ publicKey: PUBLIC, stored, isRefused, renewals, refusals, send }),
    },
  });
  const events: string[] = [];
  const sub = client.auth.onAuthStateChange((event) => {
    events.push(event);
  });
  const kept = () => {
    const s = stored();
    return s && !isRefused(s) ? s : null;
  };
  return { client, refusals, renewals, stored, isRefused, kept, events, send, stop: () => sub.data.subscription.unsubscribe() };
}

/** Ask the client who is signed in, and let its retries (half a minute) run out. */
async function askAndWait(app: ReturnType<typeof appOn>) {
  const answer = app.client.auth.getSession();
  await vi.advanceTimersByTimeAsync(40_000);
  return answer;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // supabase-js logs every failed request; the failures are the point here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what the auth server says, sorted", () => {
  it("a new token is a renewal; a refusal is a 4xx; anything else is not reaching it", () => {
    expect(classifyRenewal(200)).toBe("renewed");
    for (const status of [400, 401, 403, 404, 422]) expect(classifyRenewal(status)).toBe("refused");
    for (const status of [408, 429, 500, 502, 503, 504, 507, 520]) expect(classifyRenewal(status)).toBe("unreachable");
  });
});

describe("renewals with the real supabase-js, the token already run out", () => {
  it("429 'slow down' keeps the sign-in — throttling is not a revocation", async () => {
    const p = phone(person("A", -3600));
    const app = appOn(p, 429, { code: "over_request_rate_limit", message: "Request rate limit reached" });
    const { data } = await askAndWait(app);
    expect(data.session).toBeNull(); // not renewed, so no usable token yet…
    expect(p.values.has(KEY)).toBe(true); // …but still signed in on this phone
    expect(app.events).not.toContain("SIGNED_OUT");
    expect(app.refusals.has("refresh-A")).toBe(false);
    expect(app.kept()?.user.id).toBe("A");
    app.stop();
  });

  it("503 keeps it too", async () => {
    const p = phone(person("A", -3600));
    const app = appOn(p, 503, { message: "upstream unavailable" });
    await askAndWait(app);
    expect(p.values.has(KEY)).toBe(true);
    expect(app.events).not.toContain("SIGNED_OUT");
    expect(app.kept()?.user.id).toBe("A");
    app.stop();
  });

  it("a revoked refresh token signs the phone out, and the refusal is remembered", async () => {
    const p = phone(person("A", -3600));
    const app = appOn(p, 400, { code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" });
    await askAndWait(app);
    expect(p.values.has(KEY)).toBe(false);
    expect(app.events).toContain("SIGNED_OUT");
    expect(app.refusals.has("refresh-A")).toBe(true);
    app.stop();
  });
});

describe("a refusal seen while the token still worked", () => {
  it("is never kept offline once the token runs out — not even after a relaunch", async () => {
    const p = phone(person("A", 45));
    const app = appOn(p, 400, { code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" });

    // Renewing early, 45 seconds out, and refused. supabase-js keeps A while
    // its access token still works, and says nothing.
    await askAndWait(app);
    expect(p.values.has(KEY)).toBe(true);
    expect(app.events).not.toContain("SIGNED_OUT");
    // But the phone saw the refusal, and does not count A as signed in.
    expect(app.refusals.has("refresh-A")).toBe(true);
    expect(app.kept()).toBeNull();

    // The token runs out; no signal.
    vi.setSystemTime(Date.now() + 46_000);
    const offline = answerSoonerWhenOffline(app.client.auth.getSession.bind(app.client.auth), {
      stored: app.stored,
      isRefused: app.isRefused,
      online: () => false,
      renewals: app.renewals,
    });
    const { data } = await offline();
    expect(data.session).toBeNull();
    expect(sessionToKeep({ from: "load", session: data.session }, app.kept())).toBeNull();
    app.stop();

    // Relaunch: the refusal was written down, so it is still known.
    const again = createRefusalBook(p.storage, REFUSALS);
    expect(p.values.has(KEY)).toBe(true); // supabase-js never got to delete it
    expect(again.has("refresh-A")).toBe(true);
    const notices: number[] = [];
    const follow = followSignIn({
      stored: () => readStoredSession(p.storage, KEY),
      isRefused: (s) => again.has(s.refresh_token),
      hold: () => {},
      signedOutByServer: () => notices.push(1),
      signOutWasRequested: () => false,
    });
    expect(follow.asking()(null)).toBeNull();
    // And the sign-in screen says why.
    expect(notices).toHaveLength(1);
  });

  it("App lets go of it at once, with the notice, instead of when the token runs out", () => {
    const A = person("A", 45);
    const held: (Session | null)[] = [];
    let notices = 0;
    let refused = false;
    const follow = followSignIn({
      stored: () => A,
      isRefused: () => refused,
      hold: (s) => held.push(s),
      signedOutByServer: () => {
        notices += 1;
      },
      signOutWasRequested: () => false,
    });
    follow.asking()(A);
    expect(held.at(-1)).toBe(A);

    // An older sign-in's refusal is not this one's.
    follow.refused("refresh-someone-before");
    expect(held.at(-1)).toBe(A);
    expect(notices).toBe(0);

    refused = true;
    follow.refused("refresh-A");
    expect(held.at(-1)).toBeNull();
    expect(notices).toBe(1);
  });
});

describe("the list of refusals", () => {
  it("keeps a fingerprint, never the token itself, and only the last few", () => {
    const p = phone(null);
    const book = createRefusalBook(p.storage, REFUSALS);
    for (let i = 0; i < 20; i++) book.record(`refresh-${i}`);
    expect(book.has("refresh-19")).toBe(true);
    expect(book.has("refresh-0")).toBe(false);
    expect(p.values.get(REFUSALS)).not.toContain("refresh-19");
    expect(JSON.parse(p.values.get(REFUSALS) ?? "[]").length).toBeLessThanOrEqual(8);
  });

  it("tells whoever is listening, and still works when storage does not", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    const book = createRefusalBook(broken, REFUSALS);
    const heard: string[] = [];
    const stop = book.subscribe((token) => heard.push(token));
    book.record("refresh-A");
    expect(book.has("refresh-A")).toBe(true);
    expect(heard).toEqual(["refresh-A"]);
    stop();
    book.record("refresh-B");
    expect(heard).toEqual(["refresh-A"]);
  });
});

describe("the app's fetch and a refused sign-in", () => {
  it("still refuses to send as nobody while a usable sign-in is kept", async () => {
    const p = phone(person("A", -3600));
    const app = appOn(p, 503, {});
    await expect(
      signInAwareFetch({ publicKey: PUBLIC, stored: app.stored, isRefused: app.isRefused, renewals: app.renewals, refusals: app.refusals, send: app.send })(
        "https://review.invalid/rest/v1/rpc/clock_in",
        { method: "POST", headers: { Authorization: `Bearer ${PUBLIC}` } },
      ),
    ).rejects.toThrow(/Failed to fetch/);
    app.stop();
  });

  it("lets the signed-out screens talk as nobody once the sign-in was refused (request access, join a crew)", async () => {
    const p = phone(person("A", 45));
    const app = appOn(p, 400, { code: "refresh_token_not_found" });
    app.refusals.record("refresh-A");
    const f = signInAwareFetch({ publicKey: PUBLIC, stored: app.stored, isRefused: app.isRefused, renewals: app.renewals, refusals: app.refusals, send: app.send });
    await expect(
      f("https://review.invalid/rest/v1/rpc/submit_access_request", { method: "POST", headers: { Authorization: `Bearer ${PUBLIC}` } }),
    ).resolves.toBeInstanceOf(Response);
    app.stop();
  });
});
