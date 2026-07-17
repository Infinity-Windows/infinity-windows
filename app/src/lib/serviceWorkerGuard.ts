// Durable stale-cache guard.
//
// This app is NOT a PWA — it never registers a service worker. But a service
// worker is scoped to an *origin*, not a project, so any worker left behind by
// a *previous* app on the same origin (e.g. an earlier build, or a different
// project that once ran on http://localhost:5173) keeps intercepting requests
// and can serve a stale, cached bundle — masking brand-new code even after a
// git sync + Vite restart. A plain hard-refresh does not reliably kill it.
//
// The fix: on every boot, actively unregister any service worker on this origin
// and delete its Cache Storage, then reload once so the page runs fresh code.
// Because the app has no legitimate worker, this is always safe.

export interface ServiceWorkerGuardEnv {
  getRegistrations: () => Promise<
    ReadonlyArray<{ unregister: () => Promise<boolean> }>
  >;
  cacheKeys: () => Promise<string[]>;
  deleteCache: (key: string) => Promise<boolean>;
  hasReloaded: () => boolean;
  markReloaded: () => void;
  reload: () => void;
}

export interface ServiceWorkerGuardResult {
  unregistered: number;
  clearedCaches: number;
  reloaded: boolean;
}

/**
 * Pure, testable core: unregisters every service worker, clears all caches, and
 * — only if a worker was actually killed and we have not already reloaded this
 * session — triggers a single reload to pull the fresh build.
 */
export async function purgeStaleServiceWorkers(
  env: ServiceWorkerGuardEnv,
): Promise<ServiceWorkerGuardResult> {
  let unregistered = 0;
  const registrations = await env.getRegistrations();
  for (const registration of registrations) {
    if (await registration.unregister()) unregistered += 1;
  }

  let clearedCaches = 0;
  const keys = await env.cacheKeys();
  for (const key of keys) {
    if (await env.deleteCache(key)) clearedCaches += 1;
  }

  let reloaded = false;
  // Reload only when we removed a worker (the current page may already be
  // running its stale cached code). The session flag prevents a reload loop.
  if (unregistered > 0 && !env.hasReloaded()) {
    env.markReloaded();
    env.reload();
    reloaded = true;
  }

  return { unregistered, clearedCaches, reloaded };
}

const RELOAD_FLAG = "infinity-sw-purged";

/**
 * Browser entry point. Reads globals defensively so it is a no-op in any
 * environment without the Service Worker API, and never blocks app startup.
 */
export function installServiceWorkerGuard(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  void purgeStaleServiceWorkers({
    getRegistrations: () => navigator.serviceWorker.getRegistrations(),
    cacheKeys: () =>
      typeof caches !== "undefined" ? caches.keys() : Promise.resolve([]),
    deleteCache: (key) =>
      typeof caches !== "undefined"
        ? caches.delete(key)
        : Promise.resolve(false),
    hasReloaded: () => {
      try {
        return sessionStorage.getItem(RELOAD_FLAG) === "1";
      } catch {
        // If storage is unavailable, report "already reloaded" so we never loop.
        return true;
      }
    },
    markReloaded: () => {
      try {
        sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        // ignore
      }
    },
    reload: () => window.location.reload(),
  }).catch(() => {
    // Cache cleanup must never crash the app.
  });
}
