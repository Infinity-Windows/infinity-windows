// Thin browser adapter over the pure decision in updateCore.ts.
//
// Kept separate and deliberately dull: the interesting rules (never reload over
// unsaved work; auto-apply only after the app has been out of sight a while)
// live in updateCore.ts where they are unit-tested. This file only fetches
// version.json and reports how long the page has been hidden.

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
    });
    if (!res.ok) return null;
    return parseBuildVersion(await res.json());
  } catch {
    // Offline is the normal case on a job site, not an error worth surfacing.
    return null;
  }
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
