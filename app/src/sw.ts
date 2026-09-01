/// <reference lib="webworker" />
//
// Custom service worker (vite-plugin-pwa `injectManifest` strategy).
//
// This REPLACES the auto-generated generateSW worker so we can add push
// handlers, while preserving the exact precache + runtime-caching behavior the
// offline outbox depends on (the app shell must precache so it loads with no
// signal — see vite.config.ts and the offline-outbox migration).
//
// WEB-PUSH: a `push` event parses the SAME { title, body, tag, url } payload
// notifyLocal uses and calls registration.showNotification with identical
// options, so a pushed alert is indistinguishable from a local one.

import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { resolveNotificationUrl } from "./lib/pwa/basePaths";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// --- Precache the app shell (offline-first) ---------------------------------
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback → precached index.html (matches the previous
// generateSW navigateFallback so deep links load offline). Resolved against the
// SW scope so it works under any base path (root or /infinity-windows/).
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// Runtime image cache (mirrors the prior workbox.runtimeCaching config).
registerRoute(
  ({ request }) => request.destination === "image",
  new CacheFirst({
    cacheName: "infinity-images",
    plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 })],
  }),
);

// Update flow (registerType: 'prompt'): a freshly installed worker WAITS
// instead of skipping straight to active, so the app can surface an "update
// available — Refresh" banner (see PwaBanners). The waiting worker only takes
// over when the client explicitly asks via a SKIP_WAITING message (posted by
// vite-plugin-pwa's updateServiceWorker(true)). Once activated it claims all
// open clients so the reload runs the new shell.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// --- Web push ---------------------------------------------------------------

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  icon?: string;
  urgent?: boolean;
}

function parsePush(event: PushEvent): PushPayload {
  if (!event.data) return {};
  try {
    return event.data.json() as PushPayload;
  } catch {
    // Non-JSON payload → treat the raw text as the body.
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

self.addEventListener("push", (event: PushEvent) => {
  const payload = parsePush(event);
  const title = payload.title || "Forge Windows";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body,
      tag: payload.tag,
      icon: payload.icon,
      // Keep the same data.url contract as notifyLocal so notificationclick
      // can deep-link identically.
      data: payload.url ? { url: payload.url } : undefined,
      // A Summon rings as hard as the platform allows: stays on screen,
      // re-alerts on updates, vibrates. (iOS PWAs still cap this at a
      // standard chime — a true call-style ring is not possible there.)
      ...(payload.urgent
        ? { requireInteraction: true, renotify: true, vibrate: [200, 100, 200, 100, 400] }
        : {}),
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string };
  // Call sites write router paths (`/clock`, `/projects/x?tab=chat`). Opening
  // one verbatim on Pages would land on the domain root, outside the app, so
  // resolve it against this worker's scope — `/infinity-windows/` live, `/`
  // locally. See lib/pwa/basePaths.
  const targetUrl = resolveNotificationUrl(data.url, self.registration.scope);
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing tab if one is open, deep-linking it when possible.
      for (const client of clientList) {
        if ("focus" in client) {
          try {
            if (targetUrl && "navigate" in client) {
              await (client as WindowClient).navigate(targetUrl);
            }
          } catch {
            // navigation may be cross-origin-blocked; focus is enough
          }
          return (client as WindowClient).focus();
        }
      }
      // Otherwise open a fresh window at the deep link.
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});

// Not in every TS lib target — declare the minimal shape we use.
interface PushSubscriptionChangeEventLike extends ExtendableEvent {
  readonly oldSubscription?: PushSubscription | null;
  readonly newSubscription?: PushSubscription | null;
}

// Subscription rotation: re-subscribe and hand the new subscription to any open
// client, which upserts it to Supabase (see installPushChangeListener). Reuses
// the old subscription's applicationServerKey so we never embed the VAPID key
// in the worker.
self.addEventListener("pushsubscriptionchange", (event: Event) => {
  const e = event as PushSubscriptionChangeEventLike;
  e.waitUntil(
    (async () => {
      try {
        const appServerKey = e.oldSubscription?.options?.applicationServerKey ?? undefined;
        const newSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey ?? undefined,
        });
        const clientList = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clientList) {
          client.postMessage({
            type: "pushsubscriptionchange",
            subscription: newSub.toJSON(),
          });
        }
      } catch {
        // Best-effort — refreshed on next app open via enablePush().
      }
    })(),
  );
});
