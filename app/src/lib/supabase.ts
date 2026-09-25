import { createClient, type Session } from "@supabase/supabase-js";
import { timedFetch } from "./offline/weakSignal";
import {
  answerSoonerWhenOffline,
  authStorageKey,
  createRefusalBook,
  createRenewalWatch,
  readStoredSession,
  signInAwareFetch,
} from "./offlineSession";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && key);

const projectUrl = url ?? "http://localhost:54321";
const publicKey = key ?? "anon-key-placeholder";
const phoneStorage = typeof window === "undefined" ? null : window.localStorage;

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
