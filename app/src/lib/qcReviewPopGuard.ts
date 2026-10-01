/**
 * Install before BrowserRouter mounts. Native popstate targets window, where
 * listeners run in registration order, irrespective of capture. A listener
 * added by the lazy QC route can run after the router has unmounted it.
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
