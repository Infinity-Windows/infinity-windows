// Browser + Supabase glue for web push. The pure decision/conversion logic
// lives in pushCore.ts; this file is the thin adapter that actually talks to the
// PushManager, the service-worker registration, and the `push_subscriptions`
// table. Everything here degrades to a silent no-op when push is unavailable —
// LOCAL notifications (notifyLocal.ts) keep working regardless.

import { supabase } from "../supabase";
import {
  decidePushSubscribe,
  subscriptionToPayload,
  urlBase64ToUint8Array,
  type PushDecision,
  type PushEnvFacts,
} from "./pushCore";

const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? "";

export interface PushEnableResult {
  ok: boolean;
  /** Why we skipped (for surfacing the iOS install hint); "ok" when subscribed. */
  reason: PushDecision["reason"];
}

/** Detect iOS/iPadOS Safari, including iPadOS reporting itself as a Mac. */
function detectIsIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ masquerades as macOS; the touch-point count gives it away.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Running as an installed PWA (home-screen / standalone)? */
function detectIsStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  // iOS Safari exposes navigator.standalone instead of the media query.
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return mm || iosStandalone;
}

/** Gather the booleans decidePushSubscribe needs from the live environment. */
export function gatherPushFacts(): PushEnvFacts {
  const supported =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window;
  return {
    hasVapidKey: VAPID_PUBLIC_KEY.length > 0,
    pushManagerSupported: supported,
    secureContext: typeof window !== "undefined" ? window.isSecureContext !== false : false,
    isIos: detectIsIos(),
    isStandalone: detectIsStandalone(),
  };
}

/** The user-facing hint shown when iOS web push needs a home-screen install. */
export const IOS_INSTALL_HINT = "Add Forge Windows to your home screen to get alerts.";

async function currentProfileId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribe this device to web push and upsert the subscription to Supabase.
 * Idempotent: safe to call on every app open / whenever notifications are
 * granted. Reuses an existing PushManager subscription when present, and upserts
 * keyed by endpoint so re-runs just refresh the row. Never throws.
 *
 * Call this AFTER notification permission is granted.
 */
export async function enablePush(): Promise<PushEnableResult> {
  const decision = decidePushSubscribe(gatherPushFacts());
  if (decision.action === "skip") return { ok: false, reason: decision.reason };

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      }));

    const row = subscriptionToPayload(
      subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } },
      typeof navigator !== "undefined" ? navigator.userAgent : null,
    );
    if (!row) return { ok: false, reason: "unsupported" };

    const profileId = await currentProfileId();
    const { error } = await supabase
      .from("push_subscriptions")
      .upsert(
        { ...row, profile_id: profileId },
        { onConflict: "endpoint" },
      );
    if (error) return { ok: false, reason: "unsupported" };
    return { ok: true, reason: "ok" };
  } catch {
    // A push failure must never surface to the user or block the app.
    return { ok: false, reason: "unsupported" };
  }
}

/**
 * Turn off web push on THIS device: delete the stored subscription row and
 * unsubscribe from the PushManager. OS-level notification permission can't be
 * revoked from JS, but after this the server has nothing to push to. Never
 * throws.
 */
export async function disablePush(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    if (endpoint) {
      await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    }
    await subscription.unsubscribe();
  } catch {
    // Best-effort — turning push off must never crash a settings flow.
  }
}

/**
 * Wire the service worker's `pushsubscriptionchange` bridge: when the browser
 * rotates a subscription, the SW re-subscribes and posts the new subscription
 * to open clients (see sw.ts). Here we upsert it so the server keeps a live
 * endpoint. If no client is open at rotation time, the next enablePush() on app
 * open refreshes the row instead.
 */
export function installPushChangeListener(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; subscription?: unknown } | undefined;
    if (!data || data.type !== "pushsubscriptionchange") return;
    const row = subscriptionToPayload(
      (data.subscription ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } },
      typeof navigator !== "undefined" ? navigator.userAgent : null,
    );
    if (!row) return;
    void (async () => {
      try {
        const profileId = await currentProfileId();
        await supabase
          .from("push_subscriptions")
          .upsert({ ...row, profile_id: profileId }, { onConflict: "endpoint" });
      } catch {
        // ignore — refreshed on next app open
      }
    })();
  });
}
