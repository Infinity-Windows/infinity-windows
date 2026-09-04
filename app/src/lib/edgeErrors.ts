// Getting the sentence an edge function wrote back out of supabase-js.
//
// A non-2xx from `functions.invoke` arrives as a FunctionsHttpError whose
// `message` is the fixed, useless string "Edge Function returned a non-2xx
// status code". The sentence the person actually needs — "Only a foreman or
// above can bring files in from Monday." — is in the response body, which
// supabase-js hands over as `error.context` and otherwise drops on the floor.
//
// This has bitten this repo three times now. lib/crewAccess.ts carries the
// unwrap inline, lib/install/api.ts carries it again, and monday-sync's own
// header records the incident that made the board sync answer 200 with
// `ok: false` instead ("the office saw 'Sync failed.' and nothing else"). This
// is the same code with a name and a test, so the fourth caller does not have
// to rediscover it.

import { formatApiError } from "./errors";

/**
 * supabase-js's own text for any non-2xx.
 *
 * It has to be named here because it defeats the house formatter on its own
 * terms: `formatApiError` passes a short, brace-free server message straight
 * through, and this one is short and brace-free and means nothing. Left to
 * itself the fallback would never fire and the machine noise would win.
 */
const SUPABASE_NON_2XX = "Edge Function returned a non-2xx status code";

/**
 * The plain sentence behind a failed `functions.invoke`.
 *
 * Falls back to `formatApiError` rather than to the raw message, because the
 * house rule is that no error reaches a person as `String(err)`: a bare
 * FunctionsHttpError would otherwise put "Edge Function returned a non-2xx
 * status code" in front of a foreman, which is the exact thing this exists to
 * stop.
 *
 * Reads the body at most once — a Response body cannot be read twice, and
 * anything unreadable (an empty body, HTML from a proxy, a network failure
 * mid-read) falls through to the fallback rather than throwing on its way to
 * reporting an error.
 */
export async function edgeFunctionMessage(
  error: unknown,
  fallback?: string,
): Promise<string> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)
    ?.context;
  if (context && typeof context.json === "function") {
    const parsed = await context.json().catch(() => null);
    const said = (parsed as { error?: unknown } | null)?.error;
    if (typeof said === "string" && said.trim()) return said.trim();
  }
  const raw = error instanceof Error ? error.message : "";
  if (raw.includes(SUPABASE_NON_2XX)) {
    return fallback ?? "Something went wrong. Please try again.";
  }
  return fallback === undefined
    ? formatApiError(error)
    : formatApiError(error, fallback);
}
