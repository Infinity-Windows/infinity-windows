import { createClient, type Session } from "@supabase/supabase-js";
import { timedFetch } from "./offline/weakSignal";
import {
  answerSoonerWhenOffline,
  authStorageKey,
  createRefusalBook,
  createRenewalWatch,
  readPhoneStorage,
  readStoredSession,
  signInAwareFetch,
} from "./offlineSession";
import {
  admitWorkshopConfig,
  describeRefusal,
  fenceWorkshopNetwork,
  workshopPageProblems,
  type WorkshopEnv,
} from "./workshopIsolation";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Forge Workshop only (`vite --mode workshop`): refuse to build either client
// unless the settings name a non-production backend exactly, and fence the
// page's network to that backend before anything can call out. Normal mode
// never enters this block — see lib/workshopIsolation.ts.
if (import.meta.env.MODE === "workshop") {
  function refuse(message: string): never {
    if (typeof document !== "undefined") {
      const root = document.getElementById("root");
      if (root) root.textContent = `Forge Workshop could not open. ${message}`;
    }
    throw new Error(message);
  }
  const admission = admitWorkshopConfig(import.meta.env as WorkshopEnv);
  if (!admission.ok) refuse(describeRefusal(admission.problems));
  if (typeof window !== "undefined") {
    const misplaced = workshopPageProblems(window.location.origin, admission.config);
    if (misplaced.length) refuse(describeRefusal(misplaced));
    fenceWorkshopNetwork(window as unknown as Parameters<typeof fenceWorkshopNetwork>[0], admission.config);
  }
}

export const supabaseConfigured = Boolean(url && key);

const projectUrl = url ?? "http://localhost:54321";
const publicKey = key ?? "anon-key-placeholder";
const phoneStorage = readPhoneStorage(typeof window === "undefined" ? null : window);

/**
 * Where the sign-in is kept on this phone — supabase-js's own default key,
 * passed to the client explicitly so App can read the same entry (see
 * lib/offlineSession.ts). Same value as before it was spelled out, so no
 * phone's sign-in moved.
 */
export const AUTH_STORAGE_KEY = authStorageKey(projectUrl);

/** Refresh tokens the auth server has refused on this phone (fingerprints). */
const refusals = createRefusalBook(phoneStorage, "wops-refused-sign-ins");

/** Whether the sign-in's renewals are getting through. */
const renewals = createRenewalWatch();

/** The sign-in supabase-js has in storage right now — refused or not. */
export function storedSignIn(): Session | null {
  return readStoredSession(phoneStorage, AUTH_STORAGE_KEY);
}

/** The auth server has refused this sign-in's renewal on this phone. */
export function signInRefused(session: Session): boolean {
  return refusals.has(session.refresh_token);
}

/**
 * The sign-in on this phone that can still be used: kept by supabase-js and
 * never refused. Read from storage — no network, no refresh, never throws.
 * Kept means signed in here, with or without signal.
 */
export function signInOnThisPhone(): Session | null {
  const s = storedSignIn();
  return s && !signInRefused(s) ? s : null;
}

/** Hear the moment the auth server refuses a renewal (App signs out on it). */
export function onSignInRefused(listener: (refreshToken: string) => void): () => void {
  return refusals.subscribe(listener);
}

export const supabase = createClient(projectUrl, publicKey, {
  auth: { storageKey: AUTH_STORAGE_KEY },
  global: {
    // Never talks to the database as nobody while a usable sign-in is kept,
    // and sorts every renewal's answer — see signInAwareFetch.
    fetch: signInAwareFetch({
      publicKey,
      stored: storedSignIn,
      isRefused: signInRefused,
      renewals,
      refusals,
      // Database, auth and signed-link calls get a deadline; a miss marks
      // "weak signal" and the screens fall back to their saved copy with a
      // line saying so. Photo uploads get a longer deadline; storage downloads
      // and edge functions are left alone — see lib/offline/weakSignal.ts for
      // why.
      send: (input, init) => timedFetch(input, init),
    }),
  },
});

// No half-minute wait on every call for a renewal that cannot reach the auth
// server, and no answer for a sign-in the server refused — see
// answerSoonerWhenOffline. Everything else is the library's own.
supabase.auth.getSession = answerSoonerWhenOffline(supabase.auth.getSession.bind(supabase.auth), {
  stored: storedSignIn,
  isRefused: signInRefused,
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  renewals,
});
if (typeof window !== "undefined") {
  // Signal is back: the next renewal gets a real try, not the recent failure.
  window.addEventListener("online", () => renewals.forget());
}

/**
 * A client that sends ONE access token and no other (2026-09-25).
 *
 * The shared client above asks auth for the current session on every
 * request, which is right for a screen and wrong for a queued write: a write
 * A queued with no signal, sent after B signed in, went out with B's token,
 * and the server filed it under B (Codex review of #654, finding 3). The
 * outbox checks the owner against the session it read, then sends through one
 * of these, built from that same session's token — so a sign-in landing in
 * the middle of the send cannot change whose write it is.
 *
 * With `accessToken` set, supabase-js builds no auth client of its own (no
 * second session, no refresh timer, no storage). The token is not refreshed
 * here: an expired one fails the send, and the next attempt reads a fresh
 * session. The last client is kept, since a drain sends many writes on one
 * token.
 */
let lastBound: { token: string; client: typeof supabase } | null = null;
export function clientWithToken(accessToken: string): typeof supabase {
  if (lastBound?.token === accessToken) return lastBound.client;
  const client = createClient(url ?? "http://localhost:54321", key ?? "anon-key-placeholder", {
    accessToken: async () => accessToken,
    global: { fetch: (input, init) => timedFetch(input, init) },
  });
  lastBound = { token: accessToken, client };
  return client;
}
