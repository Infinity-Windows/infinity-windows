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
): Promise<BuildVersion | null> {
  try {
    const res = await fetchImpl(versionUrl(), {
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
