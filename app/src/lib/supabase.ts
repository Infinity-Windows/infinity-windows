import { createClient } from "@supabase/supabase-js";
import { timedFetch } from "./offline/weakSignal";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && key);

export const supabase = createClient(
  url ?? "http://localhost:54321",
  key ?? "anon-key-placeholder",
  {
    // Database, auth and signed-link calls get a deadline; a miss marks
    // "weak signal" and the screens fall back to their saved copy with a line
    // saying so. Photo uploads get a longer deadline; storage downloads and
    // edge functions are left alone — see
    // lib/offline/weakSignal.ts for why.
    global: { fetch: (input, init) => timedFetch(input, init) },
  },
);

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
