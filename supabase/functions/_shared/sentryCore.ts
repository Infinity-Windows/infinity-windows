// The testable half of the edge functions' crash monitoring.
//
// WHY IT IS SPLIT IN TWO. Everything under _shared/ that this app's own vitest
// suite reaches into — crewInvites, estimate, pin, emailSender, spendGuard — is
// Deno-free, and that is not an accident: the app's TypeScript build compiles
// whatever it imports, and `Deno.env.get` is not a name the browser build knows.
// So the rules live here, where vitest can run them for real, and the ten lines
// that actually touch Deno.env and Deno's fetch live in sentry.ts beside it.
//
// What that buys: the thing worth proving — that a thrown error is REPORTED and
// then answered with one plain sentence rather than a stack trace — is proved by
// running it, not by reading it.

import { routePattern, scrubEvent, scrubText, type ScrubbableEvent } from "./scrub.ts";

/**
 * What an installer or an office screen reads when a function falls over.
 *
 * One sentence, and an instruction. NOT `String(err)`, which is what the
 * unhandled case gives today: a Postgres constraint name or a stack trace,
 * shown to somebody standing at a window opening who can do nothing with it.
 */
export const UNEXPECTED_ERROR = "Something went wrong. Try again in a minute.";

export interface SentryTarget {
  url: string;
  key: string;
}

/**
 * Turn a DSN into the endpoint to POST to and the public key to sign with.
 *
 * A DSN reads `https://<key>@<host>/<projectId>`. Returns null for anything
 * that does not, because guessing at a malformed DSN would mean posting a crash
 * report at whatever host happened to parse out of it.
 */
export function parseDsn(raw: string): SentryTarget | null {
  try {
    const u = new URL(raw.trim());
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId || !/^\d+$/.test(projectId)) return null;
    return { url: `${u.protocol}//${u.host}/api/${projectId}/store/`, key: u.username };
  } catch {
    return null;
  }
}

export interface Frame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
}

/**
 * V8 stack text into Sentry frames, oldest first — the order Sentry renders
 * bottom-up. Best effort: a line this cannot read is skipped rather than
 * guessed at, and no stack at all still makes a perfectly good report.
 */
export function parseStack(stack: string | undefined | null): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    frames.push({
      function: m[1] ?? "<anonymous>",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    });
  }
  return frames.reverse();
}

/** A non-Error throwable, described without ever reaching "[object Object]". */
export function describeThrowable(error: unknown): string {
  if (typeof error === "string") return scrubText(error);
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return scrubText(message);
  }
  return "A value that is not an Error was thrown.";
}

/** The little bit of a Request this is allowed to look at. */
export interface RequestFacts {
  method?: string;
  url?: string;
}

/**
 * The event that would be sent, built and scrubbed. Exported so a test can
 * assert exactly what leaves the server without anything leaving it.
 *
 * The request contributes its METHOD and its ROUTE PATTERN and nothing else —
 * no headers (the caller's JWT is in there), no body (the install row, the
 * note, the photo), no query string (PostgREST puts the filter there).
 */
export function buildFunctionEvent(
  functionName: string,
  req: RequestFacts | null,
  error: unknown,
  eventId: string,
  nowSeconds: number,
): ScrubbableEvent {
  const err = error instanceof Error ? error : null;
  const method = req?.method ?? "";
  let route = "";
  if (req?.url) {
    try {
      route = routePattern(new URL(req.url).pathname);
    } catch {
      route = "";
    }
  }
  const event: ScrubbableEvent = {
    event_id: eventId,
    timestamp: nowSeconds,
    platform: "javascript",
    level: "error",
    logger: "edge-function",
    // The function's own name is the tag that answers "what is broken" — the
    // one thing Supabase's log viewer makes hard to see across 23 of them.
    tags: {
      function: functionName,
      ...(method ? { method } : {}),
      ...(route ? { route } : {}),
    },
    exception: {
      values: [
        {
          type: err?.name ?? typeof error,
          value: err?.message ? scrubText(err.message) : describeThrowable(error),
          stacktrace: { frames: parseStack(err?.stack) },
        },
      ],
    },
  };
  // The same scrubber the app runs. Belt and braces: nothing above puts a
  // header or a body in, and this is what guarantees it stays that way when
  // somebody adds a field here in a hurry.
  return scrubEvent(event);
}

/** The headers Sentry's ingest wants. The key is public; there is no signature. */
export function ingestHeaders(target: SentryTarget): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Sentry-Auth":
      `Sentry sentry_version=7, sentry_client=forge-edge/1, sentry_key=${target.key}`,
  };
}

export interface WithSentryDeps {
  /** Report one error. Must never throw; returns whether anything was sent. */
  capture: (
    functionName: string,
    req: RequestFacts,
    error: unknown,
  ) => Promise<boolean>;
  /** Build the answer the caller gets. Supplied by sentry.ts so this file
   *  stays free of the Deno-tainted module jsonResponse/corsHeaders live in. */
  respond: (req: Request, message: string) => Response;
  /** Where the reason goes when there is no DSN — which is the shipping state. */
  log?: (line: string, detail: string) => void;
}

/**
 * Build the `withSentry(name, handler)` wrapper.
 *
 * Every function in this repo already catches its own errors and answers in its
 * own words; this is for the throw that gets PAST that — a body that will not
 * parse, a failure inside the catch block, a rejected top-level await. Today
 * that is an unhandled rejection: the platform answers 500 with a stack trace,
 * which is useless to whoever is holding the phone and is exactly the leak
 * lib/errors.ts exists to prevent.
 *
 * So: report it, then answer with one plain sentence. In that order, and the
 * report never decides whether the caller gets an answer — if Sentry is slow or
 * down or absent, the sentence still goes out.
 */
export function makeWithSentry(deps: WithSentryDeps) {
  return function withSentry(
    functionName: string,
    handler: (req: Request) => Response | Promise<Response>,
  ): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
      try {
        return await handler(req);
      } catch (error) {
        // The console line is the part that works with no DSN set at all,
        // which is the state this ships in.
        deps.log?.(
          `${functionName} threw:`,
          error instanceof Error ? error.message : describeThrowable(error),
        );
        try {
          await deps.capture(functionName, { method: req.method, url: req.url }, error);
        } catch {
          // A monitor that can fail loudly turns one broken request into two.
        }
        return deps.respond(req, UNEXPECTED_ERROR);
      }
    };
  };
}
