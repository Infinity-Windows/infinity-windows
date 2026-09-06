// Crash monitoring for the edge functions: the ten lines that touch Deno.
//
// WHY: when a function throws, the reason lands in Supabase's own log viewer,
// which nobody watches. It has no alert, nothing anybody keeps, and no way to
// discover that the receipt reader has been failing since Tuesday other than an
// installer mentioning it in passing. This sends the same throw somewhere that
// can wake somebody up.
//
// SENTRY_DSN IS OPTIONAL, in the truthiness-guard form
// scripts/function_secrets.py reads as optional — the same shape monday-sync
// uses for MONDAY_API_TOKEN and send-email for RESEND_API_KEY. Until the owner
// sets it, every function behaves exactly as it does today and the deploy's
// secret gate never fails over a key nobody has added.
//
// THERE IS DELIBERATELY NO `const DSN = Deno.env.get("SENTRY_DSN") ?? ""` HERE.
// That is the exact shape the census counts as REQUIRED, and a required DSN
// would turn the whole backend deploy red over a feature nobody has switched
// on. Read it inside a function, guarded, and it stays optional.
//
// THIS DSN IS A REAL SECRET, unlike the browser's. The app's DSN is compiled
// into a public bundle and can only ever be used to send; this one is a GitHub
// Actions secret pushed into the Supabase project by the backend deploy
// (scripts/sync-function-secrets.sh), and no value is ever printed.
//
// NO SDK. The official Deno SDK would be a remote import in all 23 functions —
// cold-start weight and a supply-chain surface, in a public repo, for something
// that is off by default. One POST of one envelope to Sentry's ingest endpoint
// does the whole job, and the rules around it live in sentryCore.ts where
// vitest runs them. It posts to /envelope/ — /store/ is retired — and says so
// in the function log if Sentry ever answers with anything but ok, because a
// monitor being quietly refused looks exactly like a monitor with nothing to
// report.

import { corsHeaders, jsonResponse } from "./openai.ts";
import {
  UNEXPECTED_ERROR,
  buildFunctionEvent,
  envelopeBody,
  ingestHeaders,
  makeReportCaughtError,
  makeWithSentry,
  parseDsn,
  type RequestFacts,
} from "./sentryCore.ts";

export { UNEXPECTED_ERROR };

/** How long to wait for Sentry before giving up and answering the caller. */
const SEND_TIMEOUT_MS = 2000;

/**
 * True when a DSN is configured.
 *
 * The bare `if (Deno.env.get(...))` is the whole point: it is the shape
 * scripts/function_secrets.py reads as feature detection, so SENTRY_DSN is
 * reported OPTIONAL for every function that imports this module, and required
 * by none of them.
 */
export function crashMonitoringOn(): boolean {
  if (Deno.env.get("SENTRY_DSN")) return true;
  return false;
}

/** The configured DSN, or "" when there is none. Never logged. */
function configuredDsn(): string {
  return Deno.env.get("SENTRY_DSN") ?? "";
}

/**
 * Report one thrown error. Returns whether anything was sent, which is what the
 * tests look at; nothing in the request path does.
 */
export async function captureFunctionError(
  functionName: string,
  req: RequestFacts,
  error: unknown,
): Promise<boolean> {
  if (!crashMonitoringOn()) return false;
  const target = parseDsn(configuredDsn());
  if (!target) return false;
  const event = buildFunctionEvent(
    functionName,
    req,
    error,
    crypto.randomUUID().replace(/-/g, ""),
    Date.now() / 1000,
  );
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: ingestHeaders(target),
      body: envelopeBody(event, new Date().toISOString()),
      // A monitor must never be the reason a request hangs.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Say so. A monitor that is being refused and never mentions it looks
      // exactly like a monitor with nothing to report — which is how a project
      // ends up believing it is watched when it is not. Status only: the
      // endpoint and the key never go in a log line.
      console.warn("Sentry refused a crash report:", res.status);
    }
    return res.ok;
  } catch {
    return false;
  }
}

const deps = {
  capture: captureFunctionError,
  // The same shape every function in this repo answers with: JSON, the app's
  // CORS headers, a plain sentence under `error`.
  respond: (req: Request, message: string) =>
    jsonResponse({ error: message }, 500, corsHeaders(req)),
  log: (line: string, detail: string) => console.error(line, detail),
};

const wrap = makeWithSentry(deps);

/**
 * Report an error a function CAUGHT and is answering itself.
 *
 * withSentry only sees a throw that escapes the handler, and most functions
 * here wrap their whole body in a try. Call this from that catch — before you
 * answer — or the monitor stays quiet about the failures it exists to find.
 * Never throws; safe to await in a catch block.
 */
export const reportCaughtError = makeReportCaughtError(deps);

/**
 * Wrap a Deno.serve handler so an escaped throw is reported and then answered
 * with a plain sentence instead of a stack trace. See sentryCore.ts.
 */
export function withSentry(
  functionName: string,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return wrap(functionName, handler);
}
