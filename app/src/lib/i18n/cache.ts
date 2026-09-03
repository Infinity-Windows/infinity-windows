// The per-device language cache.
//
// Two jobs, one key:
//   1. INSTANT FIRST PAINT. The profile query has not returned on a cold load,
//      so the very first render reads the cached language here and is already in
//      the right language — no English flash before Spanish settles in.
//   2. "HAS THIS PERSON CHOSEN?" The first-login picker shows until someone
//      picks. profiles.language is NOT NULL DEFAULT 'en', so the column cannot
//      tell "picked English" from "defaulted to English"; the presence of this
//      cache key is what records that a choice was made. That makes the picker a
//      once-per-device event (the common case — a crew keeps their own phones).
//      A returning person on a brand-new device sees it once more; harmless.
//
// Every access is wrapped: storage can be blocked (private windows, locked-down
// phones), and a throw here must never take down a paint.

import { isLang, type Lang } from "./translate";

const KEY = "infinity.language";

/** The cached language, or null when none has been stored on this device. */
export function readCachedLang(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** Record the choice for instant future paints and to dismiss the picker. */
export function writeCachedLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Storage blocked — the choice still persists on the profile via the RPC;
    // only the instant-paint shortcut and the once-per-device picker gate are
    // lost, and the picker showing again is a mild re-ask, never a break.
  }
}
