// Thin browser adapter over the pure decision in updateCore.ts.
//
// Kept separate and deliberately dull: the interesting rules (never reload over
// unsaved work; auto-apply only after the app has been out of sight a while)
// live in updateCore.ts where they are unit-tested. This file fetches
// version.json — one request at a time, with a deadline — and reports how long
// the page has been hidden and how recently someone tapped or typed.

import { versionUrl } from "./buildInfo";
import { parseBuildVersion, type BuildVersion } from "./updateCore";

/**
 * Ask the server which build is published.
 *
 * `cache: "no-store"` is load-bearing. GitHub Pages serves assets with a
 * max-age, so without it the browser would happily answer from its own HTTP
 * cache and the app would never learn about a new build — the same class of
 * staleness this whole mechanism exists to defeat.
 *
 * Returns null whenever we cannot tell (offline, 404 mid-deploy, junk body).
 * Not knowing must never look like an update.
 */
export async function fetchPublishedVersion(
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
): Promise<BuildVersion | null> {
  try {
    // no-store only reaches the browser's cache. GitHub's CDN in front of
    // Pages keeps its own copy for up to ten minutes (max-age=600), and a
    // phone that asks during those minutes is told nothing changed. A query
    // string the CDN has never seen has to come from the origin. The service
    // worker does not precache version.json, so the query cannot miss a cache
    // the app relies on.
    const res = await fetchImpl(`${versionUrl()}?t=${now()}`, {
      cache: "no-store",
      // A version check is never worth a credential.
      credentials: "omit",
      signal,
    });
    if (!res.ok) return null;
    return parseBuildVersion(await res.json());
  } catch {
    // Offline is the normal case on a job site, not an error worth surfacing.
    return null;
  }
}

/**
 * How long a version.json request may take before it is given up on. A phone
 * on one bar can hold a request open for minutes without ever failing it, and
 * an answer that late is not worth having: the next poll asks again.
 */
export const VERSION_FETCH_TIMEOUT_MS = 8 * 1000;

/**
 * How long `registration.update()` may take. The browser fetches the worker
 * script and compares it; on a stalled connection that, too, can sit forever.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 30 * 1000;

/**
 * Resolve to `undefined` if `promise` has not settled within `ms`. The
 * promise itself is left to finish (or not) on its own; nothing here can
 * cancel a browser's update check. Rejections pass through.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The version check the banner actually calls: fetchPublishedVersion with two
 * properties the raw fetch lacks.
 *
 *   ONE IN FLIGHT. The check runs on a timer, on every return to the app, on
 *   sign-in and whenever a registration or queue changes. On a stalled
 *   connection each of those used to open another request that never closed,
 *   and a phone could sit holding a dozen. A call that arrives while one is
 *   running shares its answer.
 *
 *   A DEADLINE. The request is aborted after `timeoutMs` and reads as "do not
 *   know", which never looks like an update. Before this, the banner awaited
 *   the version fetch BEFORE looking at the service worker, so an update that
 *   was already downloaded and waiting could not be applied — or even offered —
 *   until a request that might never finish had finished (independent review,
 *   2026-09-23). The banner now looks at the worker first; this is the second
 *   half of that fix, for the checks that do need the network.
 *
 * The deadline also resolves the shared promise itself, not only the fetch:
 * a fetch implementation that ignores its abort signal (a test double, an old
 * polyfill) must not be able to wedge every later check behind it.
 */
export function createVersionCheck(opts: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
} = {}): {
  /** The published build, or null: offline, timed out, or not a version file. */
  run: () => Promise<BuildVersion | null>;
  /** Give up on a request in flight (the banner unmounting). */
  abort: () => void;
} {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? VERSION_FETCH_TIMEOUT_MS;
  let inFlight: Promise<BuildVersion | null> | null = null;
  let current: { controller: AbortController; finish: (v: BuildVersion | null) => void } | null =
    null;
  return {
    run() {
      if (inFlight) return inFlight;
      const controller = new AbortController();
      let settle!: (v: BuildVersion | null) => void;
      const shared = new Promise<BuildVersion | null>((resolve) => {
        settle = resolve;
      });
      const finish = (v: BuildVersion | null) => {
        clearTimeout(timer);
        if (inFlight === shared) inFlight = null;
        if (current?.controller === controller) current = null;
        settle(v);
      };
      const timer = setTimeout(() => {
        controller.abort();
        finish(null);
      }, timeoutMs);
      current = { controller, finish };
      inFlight = shared;
      fetchPublishedVersion(fetchImpl, now, controller.signal).then(finish, () => finish(null));
      return shared;
    },
    abort() {
      const active = current;
      if (!active) return;
      active.controller.abort();
      active.finish(null);
    },
  };
}

/**
 * How long the app was just out of sight.
 *
 * The reading is CONSUMED rather than left standing, and that matters. The
 * moment worth acting on is the user picking the phone back up, so the duration
 * is read exactly once, by the decision that returning to the app triggers. If
 * it stayed readable, a phone that spent ten minutes in a pocket would keep
 * looking "safe to reload" for the rest of the session, and an update that
 * arrived while somebody was actively working would reload under their thumb.
 */
export function createHiddenClock(now: () => number = () => Date.now()): {
  markHidden: () => void;
  takeHiddenDuration: () => number | null;
} {
  let hiddenSince: number | null = null;
  return {
    markHidden() {
      hiddenSince = now();
    },
    takeHiddenDuration() {
      if (hiddenSince === null) return null;
      const ms = now() - hiddenSince;
      hiddenSince = null;
      return ms;
    },
  };
}

/**
 * The "fresh moment" facts updateCore needs: how long since the app opened or
 * someone signed in, whether anything has been typed since, and how long since
 * the last tap or keystroke. Starts fresh — creating it IS the app opening.
 */
export function createActivityClock(now: () => number = () => Date.now()): {
  markFresh: () => void;
  noteInteraction: () => void;
  noteTyped: () => void;
  read: () => {
    freshForMs: number;
    typedSinceFresh: boolean;
    msSinceInteraction: number | null;
  };
} {
  let freshSince = now();
  let typed = false;
  let lastInteraction: number | null = null;
  return {
    markFresh() {
      freshSince = now();
      typed = false;
    },
    noteInteraction() {
      lastInteraction = now();
    },
    noteTyped() {
      typed = true;
      lastInteraction = now();
    },
    read() {
      return {
        freshForMs: now() - freshSince,
        typedSinceFresh: typed,
        msSinceInteraction: lastInteraction === null ? null : now() - lastInteraction,
      };
    },
  };
}

// Input types that do not hold typed text. Everything else — text, email,
// number, search, date and anything new a browser invents — counts as typing.
const NOT_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Is this element a place someone types into? */
export function isEditingText(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  const editable = el.getAttribute("contenteditable");
  if (editable === "" || editable === "true" || editable === "plaintext-only") return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  return !NOT_TEXT_INPUTS.has(type);
}
