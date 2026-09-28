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
import { createTakeoverReload, TAKEOVER_DEADLINE_MS } from "./lib/pwa/takeover";
import { isPrivateTrainingMediaUrl } from "./lib/privateMedia";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Update flow (registerType: 'prompt'): a freshly installed worker WAITS
// instead of skipping straight to active, so the app can surface an "update
// available — Refresh" banner (see PwaBanners). The waiting worker only takes
// over when the client explicitly asks via a SKIP_WAITING message (posted by
// PwaBanners, directly and through vite-plugin-pwa's updateServiceWorker(true)).
// Once activated it claims all open clients. The page that asked reloads
// itself on the controller change when it can; a page on a build from before
// 2026-09-28 cannot (lib/pwa/takeover.ts says why), and the worker is the
// only new code it runs, so the worker brings that page across itself — but
// only when the page has not reloaded by then. Doing both made two racing
// navigations, and the loser could take the new build's imports with it.
// Only the page that asked: a tab that did not is left where it is.
const takeover = createTakeoverReload(self.clients, { activated: whenActivated });

// A page loading from this worker: most often the page that asked for the
// switch, reloading itself, which the takeover must not interrupt. Only
// watched, never answered: the routes registered below answer it.
//
// Registered BEFORE precacheAndRoute()/registerRoute(), on purpose. Workbox's
// navigation route calls `event.respondWith()`, which stops the fetch event
// from reaching any listener registered after it — a real-worker
// reproduction (Claude Peer Review, 2026-09-24) showed a listener registered
// after Workbox seeing ZERO navigations for a reload Workbox answered, which
// made the takeover blind to the very reload it exists to observe. Listeners
// run in registration order; this one never calls `respondWith` or
// `preventDefault`, so registering it first only means it gets to LOOK
// before Workbox responds — routing is unaffected.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") takeover.navigationSeen(event.clientId);
});

// --- Precache the app shell (offline-first) ---------------------------------
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback → precached index.html (matches the previous
// generateSW navigateFallback so deep links load offline). Resolved against the
// SW scope so it works under any base path (root or /infinity-windows/).
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// Runtime image cache (mirrors the prior workbox.runtimeCaching config).
// Private walkthrough posters are left to the network: a signed link is only
// good for an hour and only for the account that asked (lib/privateMedia.ts).
registerRoute(
  ({ request, url }) =>
    request.destination === "image" && !isPrivateTrainingMediaUrl(url.href),
  new CacheFirst({
    cacheName: "infinity-images",
    plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 })],
  }),
);

/**
 * Resolves only after THIS worker has activated and can answer fetches.
 *
 * Deliberately NOT `self.registration.active?.state !== "activating"`: that
 * reads the registration's current active worker, which — right up until
 * THIS worker's own activate event fires — is still the PREVIOUS worker,
 * sitting at `state: "activated"`. Polling that resolved immediately, before
 * this worker had activated at all, so `finish()` could look up and navigate
 * a client before this worker was actually answering fetches. A promise this
 * worker's own `activate` listener resolves (below) can only resolve for
 * ITS activation.
 */
let resolveActivated: () => void;
const activatedPromise = new Promise<void>((resolve) => {
  resolveActivated = resolve;
});
async function whenActivated(): Promise<void> {
  const deadline = Date.now() + TAKEOVER_DEADLINE_MS;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker activation timed out")), TAKEOVER_DEADLINE_MS);
    void activatedPromise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  // Our activate listener resolves after clients.claim(), but Workbox may
  // have other activate.waitUntil work. Fetches are delivered only once the
  // worker reaches "activated", so wait for that state as well.
  while (self.registration.active?.state !== "activated") {
    if (Date.now() >= deadline) throw new Error("worker activation timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

// The original SKIP_WAITING message owns the whole normal completion through
// its OWN event.waitUntil — skipWaiting, waiting for activation, the grace
// period, the decision to navigate. A duplicate ask (the same source
// resending, or a second tab/window asking this worker later) still calls
// skipWaiting() — harmless and idempotent, there is only
// ever one waiting worker to promote — but owns none of that and gets no
// waitUntil chain of its own: it cannot reset the deadline, restart the
// grace period, or cause a second navigation (see takeover.ts).
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    const owns = takeover.asked(event.source as { id: string } | null);
    if (owns) {
      event.waitUntil(
        (async () => {
          await self.skipWaiting();
          await takeover.finish();
        })(),
      );
    } else {
      void self.skipWaiting();
    }
  }
});

// Our activate listener only claims clients, then signals whenActivated()
// to wait for the whole activation. It must NEVER itself await the grace
// period or a navigation: the page's reload is a navigation this worker has
// to answer, and a worker answers no fetch until its activation has
// finished, so awaiting either one inside activate's waitUntil deadlocks the
// activation itself (found in the upgrade harness, 2026-09-25). finish()
// runs from the SKIP_WAITING message event instead (above), which is free
// to wait — resolveActivated() is a plain call, not awaited here.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.claim().then(() => {
      resolveActivated();
    }),
  );
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
