// Staying signed in on a phone with no signal (2026-09-24).
//
// A phone signs in once and keeps two tokens: an ACCESS token that lasts an
// hour, and a REFRESH token that renews it. Opened after the hour — every
// crew member's first launch of the morning — the app has to renew before it
// can talk to anybody, and on a site with no bars the renewal cannot reach
// the auth server. supabase-js answers that failure with "no session", which
// is also its answer for "nobody is signed in", and the app took it at its
// word: half a minute of "Connecting…" while supabase-js retried, then Sign in
// / Request access, and a crew member on a dead site had no clock until signal
// came back.
//
// The two are not the same, and supabase-js itself knows it. On a definite
// refusal — a revoked or unknown refresh token, a login removed or signed out
// everywhere — it deletes the sign-in from the phone. On a network failure it
// keeps it and tries again later. So the sign-in still sitting in storage IS
// the answer: there, the person is signed in on this phone and the app opens
// for them offline; gone, they are signed out.
//
// The rules, each a plain function so the tests can hold them; the wiring is
// in lib/supabase.ts and App.tsx:
//   - sessionToKeep: which session App holds after auth answers.
//   - answerSoonerWhenOffline: no half-minute wait for a renewal that cannot
//     reach the auth server — the same answer, as soon as that is known.
//   - sentAsNobody: a signed-in phone never talks to the database as nobody.

import {
  AuthRetryableFetchError,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Where supabase-js keeps the sign-in on this phone: its own default key,
 * `sb-<first label of the project host>-auth-token`, spelled out so this app
 * reads the same entry the library writes. lib/supabase.ts passes it to the
 * client explicitly, so the two cannot drift — and a library upgrade that
 * changed its default would not quietly sign every phone out.
 */
export function authStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/**
 * The sign-in supabase-js has kept on this phone, straight from storage: no
 * network, no refresh, never throws. Null when there is none, or when what is
 * there is not a whole sign-in (supabase-js deletes those itself).
 */
export function readStoredSession(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string,
): Session | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session> | null;
    if (!s || typeof s !== "object") return null;
    if (typeof s.access_token !== "string" || typeof s.refresh_token !== "string") return null;
    if (typeof s.expires_at !== "number") return null;
    if (!s.user || typeof s.user.id !== "string") return null;
    return s as Session;
  } catch {
    return null;
  }
}

/** What auth just said about who is signed in. */
export type AuthAnswer =
  /** `getSession()` came back. */
  | { from: "load"; session: Session | null }
  /** `onAuthStateChange` fired. */
  | { from: "event"; event: AuthChangeEvent; session: Session | null };

/**
 * The session App should hold after auth answers.
 *
 * A real session always wins. SIGNED_OUT is final — supabase-js has already
 * deleted the sign-in, whether the person asked or the server refused it. Any
 * other "no session" (a `getSession()` or INITIAL_SESSION whose renewal could
 * not reach the auth server) defers to what the phone still holds: kept means
 * signed in, offline; gone means signed out.
 */
export function sessionToKeep(answer: AuthAnswer, storedNow: Session | null): Session | null {
  if (answer.session) return answer.session;
  if (answer.from === "event" && answer.event === "SIGNED_OUT") return null;
  return storedNow;
}

/**
 * How close to its expiry supabase-js renews an access token before using it:
 * its EXPIRY_MARGIN_MS, three 30-second ticks. Inside it, `getSession()`
 * renews first.
 */
export const RENEW_MARGIN_MS = 90_000;

/** Does using this sign-in mean renewing it first? */
export function needsRenewal(session: Session, now: number): boolean {
  return (session.expires_at ?? 0) * 1000 - now < RENEW_MARGIN_MS;
}

/** Is this request a renewal — supabase-js trading the refresh token in? */
export function isRenewal(input: RequestInfo | URL): boolean {
  const url = urlOf(input);
  return url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token");
}

/**
 * How long after a renewal fails to reach the auth server the phone keeps
 * assuming the next one will too, and answers at once. A little over the
 * thirty seconds supabase-js spends retrying one renewal.
 */
export const RENEWAL_TROUBLE_WINDOW_MS = 60_000;

/**
 * Watches the auth client's renewals go by. lib/supabase.ts sees every one
 * (they go through the same fetch as everything else) and reports whether it
 * got an answer from the auth server — ANY answer, a refusal included — or
 * could not reach it at all.
 */
export interface RenewalWatch {
  /** When a renewal last failed to reach the auth server, or 0. */
  troubleAt(): number;
  /** Settles the next time a renewal fails to reach the auth server. */
  nextTrouble(): Promise<void>;
  /** A renewal could not reach the auth server: no signal, no answer in time, a 5xx. */
  trouble(): void;
  /** A renewal got an answer from the auth server, or the phone just came back online. */
  forget(): void;
}

export function createRenewalWatch(now: () => number = Date.now): RenewalWatch {
  let troubleAt = 0;
  let next: { promise: Promise<void>; resolve: () => void } | null = null;
  return {
    troubleAt: () => troubleAt,
    nextTrouble() {
      if (!next) {
        let resolve = () => {};
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        next = { promise, resolve };
      }
      return next.promise;
    },
    trouble() {
      troubleAt = now();
      const waiting = next;
      next = null;
      waiting?.resolve();
    },
    forget() {
      troubleAt = 0;
    },
  };
}

/**
 * Worded like the browser's own network failure on purpose: every queue and
 * screen in the app already reads "Failed to fetch" as "no signal — keep it
 * and try again later" (isNetworkError, formatApiError), which is exactly
 * what is wanted here.
 */
export const WAITING_TO_RENEW =
  "Failed to fetch: this phone is still signed in, but its sign-in has to be renewed before anything can be sent, and that needs signal";

type GetSession = SupabaseClient["auth"]["getSession"];

export interface OfflineDeps {
  /** The sign-in kept on this phone right now (readStoredSession). */
  stored: () => Session | null;
  /** navigator.onLine — false only when the phone knows it has no network. */
  online: () => boolean;
  renewals: Pick<RenewalWatch, "troubleAt" | "nextTrouble">;
  now?: () => number;
}

/**
 * `getSession()` that does not make the app wait for a renewal that cannot
 * reach the auth server.
 *
 * supabase-js renews an expired token inside `getSession()`, retrying for up
 * to thirty seconds before it gives up — and EVERY database call asks
 * `getSession()` first. With no signal that was half a minute of spinner on
 * every screen, the clock-in tap included, before the same answer came back.
 * This gives that answer as soon as it is known: at once when the phone knows
 * it is offline or a renewal has just failed to get through, and otherwise
 * the moment one does — the kept sign-in if its token is still good, and
 * otherwise "no session" with a network error, word for word what supabase-js
 * returns after its retries.
 *
 * Only then. A sign-in that needs no renewing, or a renewal that gets an
 * answer (a refusal included), is the library's own `getSession()`,
 * untouched. And the library keeps renewing in the background either way —
 * its own timer, and this very call, which is raced rather than dropped — so
 * the sign-in comes back as soon as signal does.
 */
export function answerSoonerWhenOffline(load: GetSession, deps: OfflineDeps): GetSession {
  const clock = deps.now ?? Date.now;
  return async () => {
    const stored = deps.stored();
    if (!stored || !needsRenewal(stored, clock())) return load();
    const withoutRenewing = () =>
      (stored.expires_at ?? 0) * 1000 > clock()
        ? { data: { session: stored }, error: null }
        : { data: { session: null }, error: new AuthRetryableFetchError(WAITING_TO_RENEW, 0) };
    if (!deps.online() || clock() - deps.renewals.troubleAt() < RENEWAL_TROUBLE_WINDOW_MS) {
      return withoutRenewing();
    }
    return Promise.race([load(), deps.renewals.nextTrouble().then(withoutRenewing)]);
  };
}

/** The endpoints that act for a PERSON: database, file store, functions. */
const ACTS_FOR_A_PERSON = ["/rest/v1/", "/storage/v1/", "/functions/v1/"];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Is this request about to reach the database (or file store, or a function)
 * as NOBODY — the public key where a person's token belongs, or no token at
 * all?
 *
 * supabase-js does exactly that when it has no usable session: it sends the
 * public key instead. From a phone that is signed in but could not renew, that
 * is never what anyone meant, and the database answers it as a stranger: a
 * read comes back empty (and would be saved over the phone's copy — a job's
 * openings, the day's schedule), and a queued write is refused with 42501,
 * which the queue rightly treats as permanent, so a clock-in taken with no
 * signal was lost for good the moment signal came back. lib/supabase.ts
 * refuses such a request on the phone, as a network failure, whenever a
 * sign-in is kept here — so it waits, and goes out once the sign-in renews.
 */
export function sentAsNobody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  publicKey: string,
): boolean {
  const url = urlOf(input);
  if (!ACTS_FOR_A_PERSON.some((path) => url.includes(path))) return false;
  const headers = new Headers(
    init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
  );
  const authorization = headers.get("authorization");
  return authorization === null || authorization === `Bearer ${publicKey}`;
}
