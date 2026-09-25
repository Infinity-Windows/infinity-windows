import { createClient, type Session } from "@supabase/supabase-js";
import { timedFetch } from "./offline/weakSignal";
import {
  answerSoonerWhenOffline,
  authStorageKey,
  createRenewalWatch,
  isRenewal,
  readStoredSession,
  sentAsNobody,
  WAITING_TO_RENEW,
} from "./offlineSession";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && key);

const projectUrl = url ?? "http://localhost:54321";
const publicKey = key ?? "anon-key-placeholder";

/**
 * Where the sign-in is kept on this phone — supabase-js's own default key,
 * passed to the client explicitly so App can read the same entry (see
 * lib/offlineSession.ts). Same value as before it was spelled out, so no
 * phone's sign-in moved.
 */
export const AUTH_STORAGE_KEY = authStorageKey(projectUrl);

/**
 * The sign-in kept on this phone, read from storage: no network, no refresh,
 * never throws. Kept means signed in here, with or without signal —
 * supabase-js deletes it itself on every definite refusal.
 */
export function signInOnThisPhone(): Session | null {
  return readStoredSession(
    typeof window === "undefined" ? null : window.localStorage,
    AUTH_STORAGE_KEY,
  );
}

/** Whether the sign-in's renewals are getting through (lib/offlineSession.ts). */
const renewals = createRenewalWatch();

export const supabase = createClient(projectUrl, publicKey, {
  auth: { storageKey: AUTH_STORAGE_KEY },
  global: {
    fetch: async (input, init) => {
      // A phone that is signed in never talks to the database as nobody: a
      // request supabase-js would send with only the public key, because the
      // sign-in could not be renewed yet, fails here as a network failure and
      // waits — see sentAsNobody for what it cost.
      if (sentAsNobody(input, init, publicKey) && signInOnThisPhone()) {
        throw new TypeError(WAITING_TO_RENEW);
      }
      // Database, auth and signed-link calls get a deadline; a miss marks
      // "weak signal" and the screens fall back to their saved copy with a line
      // saying so. Photo uploads get a longer deadline; storage downloads and
      // edge functions are left alone — see
      // lib/offline/weakSignal.ts for why.
      if (!isRenewal(input)) return timedFetch(input, init);
      try {
        const response = await timedFetch(input, init);
        // Any answer from the auth server, a refusal included, is an answer.
        if (response.status >= 500) renewals.trouble();
        else renewals.forget();
        return response;
      } catch (err) {
        renewals.trouble();
        throw err;
      }
    },
  },
});

// No half-minute wait on every call for a renewal that cannot reach the auth
// server — see answerSoonerWhenOffline. Everything else is the library's own.
supabase.auth.getSession = answerSoonerWhenOffline(supabase.auth.getSession.bind(supabase.auth), {
  stored: signInOnThisPhone,
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  renewals,
});
if (typeof window !== "undefined") {
  // Signal is back: the next renewal gets a real try, not the recent failure.
  window.addEventListener("online", () => renewals.forget());
}
