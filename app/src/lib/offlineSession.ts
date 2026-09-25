// Staying signed in on a phone with no signal (2026-09-24), and never on the
// wrong person or a sign-in the server has ended (Codex review, 2026-09-25).
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
// Not reaching the auth server is not the same as being turned away by it.
// supabase-js keeps the sign-in in storage when a renewal cannot get through,
// so a kept sign-in is what the phone goes on — with two exceptions it has to
// be told about, because storage alone does not say:
//   - a REFUSAL this phone has already seen. supabase-js keeps a sign-in whose
//     renewal is refused while its access token still works, and would hand
//     it back once that ran out with no signal. Every refusal is written down
//     here (createRefusalBook) and a refused sign-in is never used again.
//   - 429 "slow down". supabase-js signs a phone out on it, as if revoked. It
//     is throttling; the fetch below hands it back as the network failure it
//     is (classifyRenewal).
// And an answer can arrive after the person it is about has left: signed out,
// or someone else signed in. Everything that settles later reads the phone
// again (answerSoonerWhenOffline, sessionToKeep), and App drops an answer to a
// question asked before a newer sign-in or sign-out (followSignIn).
//
// The wiring is in lib/supabase.ts and App.tsx.

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

/**
 * The same sign-in: the same person holding the same tokens. Signing out,
 * someone else signing in, and a renewal all change the tokens — so an
 * answer about one of those is not an answer about the other.
 */
export function sameSignIn(a: Session, b: Session): boolean {
  return (
    a.user?.id === b.user?.id &&
    a.refresh_token === b.refresh_token &&
    a.access_token === b.access_token
  );
}

/** What auth just said about who is signed in. */
export type AuthAnswer =
  /** `getSession()` came back. */
  | { from: "load"; session: Session | null }
  /** `onAuthStateChange` fired. */
  | { from: "event"; event: AuthChangeEvent; session: Session | null };

/**
 * The session App should hold after auth answers. `keptNow` is the sign-in on
 * the phone at this moment that may be used: stored, and never refused.
 *
 * SIGNED_OUT is final — supabase-js has already deleted the sign-in, whether
 * the person asked or the server refused it. A sign-in, renewal or update
 * event carries the session supabase-js has just saved, so it wins.
 *
 * `getSession()` and INITIAL_SESSION are different: both are worked out from
 * storage, possibly across a half-minute renewal, so they can arrive after
 * the person they are about has left. They are taken only while the phone
 * still holds that same sign-in; otherwise the phone's own record decides. And
 * "no session" from one of them — a renewal that could not reach the auth
 * server — defers to that record too: kept means signed in, offline.
 */
export function sessionToKeep(answer: AuthAnswer, keptNow: Session | null): Session | null {
  if (answer.from === "event" && answer.event !== "INITIAL_SESSION") {
    if (answer.event === "SIGNED_OUT") return null;
    return answer.session ?? keptNow;
  }
  if (answer.session && keptNow && sameSignIn(answer.session, keptNow)) return answer.session;
  return keptNow;
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

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Is this request a renewal — supabase-js trading the refresh token in? */
export function isRenewal(input: RequestInfo | URL): boolean {
  const url = urlOf(input);
  return url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token");
}

/** The refresh token a renewal is trading in (supabase-js sends it as JSON). */
function refreshTokenSent(init: RequestInit | undefined): string | null {
  try {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { refresh_token?: unknown }) : null;
    return typeof body?.refresh_token === "string" ? body.refresh_token : null;
  } catch {
    return null;
  }
}

export type RenewalOutcome =
  /** A new pair of tokens. */
  | "renewed"
  /** The auth server said no to this refresh token: the sign-in is over. */
  | "refused"
  /** The auth server could not be reached, or could not answer just now. */
  | "unreachable";

/**
 * What an answer to a renewal means for the sign-in on this phone. The one
 * place that decides it.
 *
 * A 4xx is the auth server turning the refresh token away — revoked, unknown,
 * already used, the session ended or the person removed — and that ends the
 * sign-in. Except 408 and 429: a request that took too long, and "slow
 * down", say nothing about the sign-in (Supabase's own error list files 429
 * under rate limits). They, 5xx, and no answer at all are "unreachable": keep
 * the sign-in and try again later.
 */
export function classifyRenewal(status: number): RenewalOutcome {
  if (status >= 200 && status < 300) return "renewed";
  if (status === 408 || status === 429 || status >= 500) return "unreachable";
  if (status >= 400) return "refused";
  return "unreachable";
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
 * The refresh tokens the auth server has refused on this phone — so a refused
 * sign-in is never used again: not in the running app, not offline after its
 * access token runs out, not after a relaunch.
 *
 * Kept as fingerprints, never the tokens: a refresh token is a credential even
 * once refused, and only "was this the one?" is ever asked. The last few only
 * — a sign-in is replaced long before eight have been refused.
 */
export interface RefusalBook {
  has(refreshToken: string): boolean;
  record(refreshToken: string): void;
  /** Hear about each refusal as it happens. */
  subscribe(listener: (refreshToken: string) => void): () => void;
}

const REFUSALS_KEPT = 8;

/** A short, one-way fingerprint (cyrb53). Enough to say "the same token". */
function fingerprint(token: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < token.length; i++) {
    const ch = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function createRefusalBook(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  key: string,
): RefusalBook {
  // Also in memory, for a phone whose storage is switched off.
  let remembered: string[] = [];
  const listeners = new Set<(refreshToken: string) => void>();
  const written = (): string[] => {
    try {
      const list = JSON.parse(storage?.getItem(key) ?? "[]") as unknown;
      return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has(refreshToken) {
      const f = fingerprint(refreshToken);
      return remembered.includes(f) || written().includes(f);
    },
    record(refreshToken) {
      const f = fingerprint(refreshToken);
      remembered = [...remembered.filter((x) => x !== f), f].slice(-REFUSALS_KEPT);
      try {
        const list = [...written().filter((x) => x !== f), f].slice(-REFUSALS_KEPT);
        storage?.setItem(key, JSON.stringify(list));
      } catch {
        /* storage switched off: the memory copy stands for this launch */
      }
      for (const listener of listeners) {
        try {
          listener(refreshToken);
        } catch {
          /* one listener must never stop the others hearing */
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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

/** An answer that arrived after the sign-in it was about had changed. */
const SIGN_IN_CHANGED =
  "Failed to fetch: the sign-in on this phone changed while this was waiting to be renewed; ask again";

type GetSession = SupabaseClient["auth"]["getSession"];

export interface OfflineDeps {
  /** The sign-in in storage right now (readStoredSession). */
  stored: () => Session | null;
  /** The auth server has already refused this sign-in (RefusalBook). */
  isRefused: (session: Session) => boolean;
  /** navigator.onLine — false only when the phone knows it has no network. */
  online: () => boolean;
  renewals: Pick<RenewalWatch, "troubleAt" | "nextTrouble">;
  now?: () => number;
}

/**
 * `getSession()` that does not make the app wait for a renewal that cannot
 * reach the auth server, and never answers for a sign-in the server refused.
 *
 * supabase-js renews an expired token inside `getSession()`, retrying for up
 * to thirty seconds before it gives up — and EVERY database call asks
 * `getSession()` first. With no signal that was half a minute of spinner on
 * every screen, the clock-in tap included, before the same answer came back.
 * This gives that answer as soon as it is known: at once when the phone knows
 * it is offline or a renewal has just failed to get through, and otherwise
 * the moment one does. The answer is the kept sign-in if its token is still
 * good, and otherwise "no session" with a network error — word for word what
 * supabase-js returns after its retries. An answer given later than it was
 * asked reads the phone again first, and is given only for the sign-in the
 * phone still holds: signed out, someone else signed in, or the sign-in
 * renewed or refused meanwhile, it is "no session" — never the person who
 * left.
 *
 * A sign-in that needs no renewing, or a renewal that gets an answer, is the
 * library's own `getSession()`, untouched. The library keeps renewing in the
 * background either way — its own timer, and this very call, which is raced
 * rather than dropped — so the sign-in comes back as soon as signal does.
 */
export function answerSoonerWhenOffline(load: GetSession, deps: OfflineDeps): GetSession {
  const clock = deps.now ?? Date.now;
  return async () => {
    const asked = deps.stored();
    if (!asked) return load();
    // Refused: nobody is signed in on it. Not "no signal" — so no retrying,
    // and no network call to be turned away a second time.
    if (deps.isRefused(asked)) return { data: { session: null }, error: null };
    if (!needsRenewal(asked, clock())) return load();
    const withoutRenewing = () => {
      const current = deps.stored();
      if (!current || !sameSignIn(current, asked) || deps.isRefused(current)) {
        return { data: { session: null }, error: new AuthRetryableFetchError(SIGN_IN_CHANGED, 0) };
      }
      return (current.expires_at ?? 0) * 1000 > clock()
        ? { data: { session: current }, error: null }
        : { data: { session: null }, error: new AuthRetryableFetchError(WAITING_TO_RENEW, 0) };
    };
    if (!deps.online() || clock() - deps.renewals.troubleAt() < RENEWAL_TROUBLE_WINDOW_MS) {
      return withoutRenewing();
    }
    return Promise.race([load(), deps.renewals.nextTrouble().then(withoutRenewing)]);
  };
}

/** The endpoints that act for a PERSON: database, file store, functions. */
const ACTS_FOR_A_PERSON = ["/rest/v1/", "/storage/v1/", "/functions/v1/"];

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
 * signal was lost for good the moment signal came back. signInAwareFetch
 * refuses such a request on the phone, as a network failure, whenever a
 * usable sign-in is kept here — so it waits, and goes out once the sign-in
 * renews.
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

export interface SignInFetchDeps {
  /** The project's public (anon) key: what "nobody" sends. */
  publicKey: string;
  stored: () => Session | null;
  isRefused: (session: Session) => boolean;
  renewals: RenewalWatch;
  refusals: RefusalBook;
  /** The fetch that actually sends (lib/offline/weakSignal's timedFetch). */
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * The client's fetch. Two jobs besides sending:
 *   - a request about to go out as nobody while a usable sign-in is kept on
 *     the phone fails here, as no signal (sentAsNobody). Once the sign-in is
 *     refused the phone is signed out, and the signed-out screens — sign in,
 *     request access, join a crew — talk as nobody like any signed-out phone;
 *   - every renewal's answer is sorted (classifyRenewal): a refusal is written
 *     down, and one that did not get through — 429 "slow down" included — is
 *     handed to supabase-js as the network failure it is, so it keeps the
 *     sign-in and tries again instead of signing the phone out.
 */
export function signInAwareFetch(
  deps: SignInFetchDeps,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    if (sentAsNobody(input, init, deps.publicKey)) {
      const kept = deps.stored();
      if (kept && !deps.isRefused(kept)) throw new TypeError(WAITING_TO_RENEW);
    }
    if (!isRenewal(input)) return deps.send(input, init);
    const refreshToken = refreshTokenSent(init);
    let response: Response;
    try {
      response = await deps.send(input, init);
    } catch (err) {
      deps.renewals.trouble();
      throw err;
    }
    const outcome = classifyRenewal(response.status);
    if (outcome === "unreachable") {
      deps.renewals.trouble();
      throw new TypeError(
        `Failed to fetch: the auth server could not renew the sign-in just now (HTTP ${response.status})`,
      );
    }
    deps.renewals.forget();
    if (outcome === "refused" && refreshToken) deps.refusals.record(refreshToken);
    return response;
  };
}

export interface FollowDeps {
  /** The sign-in in storage right now. */
  stored: () => Session | null;
  /** The auth server has already refused this sign-in. */
  isRefused: (session: Session) => boolean;
  /**
   * Put this session in front of the person; null is the sign-in screen.
   * `why` names what moved it, in onAuthStateChange's words: INITIAL_SESSION
   * for the launch answer, SIGNED_OUT for a refusal — so anything that follows
   * the sign-in (the device lock's offline unlock, #651) can follow it here.
   */
  hold: (session: Session | null, why: AuthChangeEvent) => void;
  /** The server ended the sign-in this phone was using: say so. */
  signedOutByServer: () => void;
  /** The sign-out happening now is one the person asked for (lib/signOut). */
  signOutWasRequested: () => boolean;
}

export interface SignInFollower {
  /**
   * Ask "who is signed in?" now (App's launch `getSession()`). The answer is
   * used only if nothing newer has been said by the time it arrives; it
   * returns what App now holds, or undefined when the answer was out of date.
   */
  asking(): (session: Session | null) => Session | null | undefined;
  /** onAuthStateChange. Returns what App now holds, or undefined when stale. */
  changed(event: AuthChangeEvent, session: Session | null): Session | null | undefined;
  /** The auth server refused this refresh token (seen by signInAwareFetch). */
  refused(refreshToken: string): void;
}

/**
 * What App holds, from everything auth says — in the order it happens, not
 * the order the answers arrive.
 *
 * A sign-in, a sign-out or a refusal moves the follower on; an answer to a
 * question asked before that (the launch `getSession()`, INITIAL_SESSION) is
 * about a moment that has passed and is dropped. Without this a slow launch
 * answer could put the previous person back after the next one signed in, or
 * undo a sign-out. A refusal of the sign-in in use ends it at once, with the
 * notice, rather than when its access token runs out.
 */
export function followSignIn(deps: FollowDeps): SignInFollower {
  const kept = () => {
    const s = deps.stored();
    return s && !deps.isRefused(s) ? s : null;
  };
  /** The sign-in this phone is using: whether a sign-out ended one. */
  let using = deps.stored();
  if (using && deps.isRefused(using)) {
    // Refused before this launch got here — a relaunch after the refusal.
    deps.signedOutByServer();
    using = null;
  }
  /** Moves on at every real change. */
  let changes = 0;
  const hold = (session: Session | null, why: AuthChangeEvent) => {
    using = session;
    deps.hold(session, why);
    return session;
  };
  return {
    asking() {
      const askedAt = changes;
      return (session) =>
        changes !== askedAt
          ? undefined
          : hold(sessionToKeep({ from: "load", session }, kept()), "INITIAL_SESSION");
    },
    changed(event, session) {
      if (event === "INITIAL_SESSION") {
        // The answer as of subscribing, which App does as it starts following.
        return changes !== 0 ? undefined : hold(sessionToKeep({ from: "event", event, session }, kept()), event);
      }
      changes += 1;
      if (event === "SIGNED_OUT" && using && !deps.signOutWasRequested()) deps.signedOutByServer();
      return hold(sessionToKeep({ from: "event", event, session }, kept()), event);
    },
    refused(refreshToken) {
      if (!using || using.refresh_token !== refreshToken) return;
      changes += 1;
      deps.signedOutByServer();
      hold(null, "SIGNED_OUT");
    },
  };
}
