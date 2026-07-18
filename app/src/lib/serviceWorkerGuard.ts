// Durable stale-cache guard (DEV only).
//
// Production registers a real service worker via vite-plugin-pwa for the app
// shell. In development we still purge any orphaned worker left on this origin
// (from a prior prod build or another project on the same port) so hot reload
// is never masked by a stale cached bundle.

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
 * Browser entry point. In production this is a no-op — vite-plugin-pwa owns
 * the real service worker. In DEV we still purge orphaned workers/caches so a
 * leftover production SW (or another app on the same origin) cannot mask hot
 * reloads with a stale bundle.
 */
export function installServiceWorkerGuard(): void {
  if (!import.meta.env.DEV) return;
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
