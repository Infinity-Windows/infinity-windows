import { withBase } from "./pwa/basePaths";

/**
 * Install this capture listener before BrowserRouter mounts. Native window
 * POP listener ordering differs across engines: requesting capture on a late
 * lazy-route listener does not reliably precede the router's unmount.
 *
 * This dispatcher is inert unless a mounted QC flow registers its guard. It
 * owns no draft/auth state and does not patch the router or history methods.
 */
let activeGuard: ((event: PopStateEvent) => void) | null = null;
const installedTargets = new WeakSet<EventTarget>();

export function installQcReviewPopGuard(target: EventTarget = window): void {
  if (installedTargets.has(target)) return;
  installedTargets.add(target);
  target.addEventListener("popstate", event => activeGuard?.(event as PopStateEvent), true);
}

export function registerQcReviewPopGuard(guard: (event: PopStateEvent) => void): () => void {
  activeGuard = guard;
  return () => { if (activeGuard === guard) activeGuard = null; };
}

export interface QcReviewHistoryEntry {
  url: string;
  history: Record<string, unknown> | null;
}
export function qcReviewHistoryEntry(url: string, history: unknown): QcReviewHistoryEntry {
  return { url, history: history && typeof history === "object" ? { ...history } : null };
}

/** Accept a React location only if it still describes the native entry.
 * A passive effect can lag our synchronous replaceState, or run while a
 * blocked POP temporarily points the browser at another route. Neither may
 * overwrite the entry we must restore. React's pathname omits the basename. */
export function qcReviewEntryForLocation(entry: QcReviewHistoryEntry,
  location: { key: string; pathname: string; search: string; hash: string },
  base: string,
): QcReviewHistoryEntry | null {
  const url = new URL(entry.url);
  return entry.history?.key === location.key
    && url.pathname === withBase(base, location.pathname)
    && url.search === location.search && url.hash === location.hash ? entry : null;
}
