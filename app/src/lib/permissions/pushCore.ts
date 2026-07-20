// Web-push follow-up to the LOCAL notification path (see notifyLocal.ts).
//
// This module is the PURE, browser-free heart of the client subscribe flow so
// every tricky bit is unit-testable without a real PushManager, service worker,
// or Supabase:
//   - urlBase64ToUint8Array: the VAPID applicationServerKey conversion.
//   - decidePushSubscribe: "should we even try?" (supported / secure /
//     ios-not-installed / missing-key) — degrade silently otherwise.
//   - subscriptionToPayload: shape a PushSubscription into a DB row.
//   - endpointsToPrune / isGoneStatus: which subscriptions the server should
//     delete after a 404/410 (the endpoint is gone).
//
// The browser + Supabase glue lives in pushSubscribe.ts behind a thin adapter.

/**
 * Convert a base64url VAPID public key into the Uint8Array the PushManager
 * wants for `applicationServerKey`. Pure; works in Node and the browser.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = decodeBase64(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function decodeBase64(input: string): string {
  if (typeof atob === "function") return atob(input);
  // Node fallback (tests / SSR). Never reached in the browser.
  return Buffer.from(input, "base64").toString("binary");
}

export type PushSkipReason =
  | "missing-key"
  | "unsupported"
  | "insecure"
  | "ios-not-installed";

export interface PushDecision {
  action: "subscribe" | "skip";
  reason: "ok" | PushSkipReason;
}

/** Environment facts the subscribe decision depends on (all booleans, testable). */
export interface PushEnvFacts {
  /** VITE_VAPID_PUBLIC_KEY is present and non-empty. */
  hasVapidKey: boolean;
  /** serviceWorker + PushManager both exist. */
  pushManagerSupported: boolean;
  /** https or localhost. */
  secureContext: boolean;
  /** iOS/iPadOS Safari (web push only works there once installed to home screen). */
  isIos: boolean;
  /** Running as an installed PWA (standalone display mode). */
  isStandalone: boolean;
}

/**
 * Pure decision: should we attempt a push subscription? Returns skip (a silent
 * no-op — local notifications still work) with a specific reason otherwise. The
 * `ios-not-installed` reason is surfaced to the user as a short "add to home
 * screen" hint; every other skip is silent.
 */
export function decidePushSubscribe(f: PushEnvFacts): PushDecision {
  if (!f.secureContext) return { action: "skip", reason: "insecure" };
  if (!f.pushManagerSupported) return { action: "skip", reason: "unsupported" };
  // Surface the iOS install hint before the missing-key check so an iOS user on
  // an un-installed PWA gets the actionable message, not silence.
  if (f.isIos && !f.isStandalone) return { action: "skip", reason: "ios-not-installed" };
  if (!f.hasVapidKey) return { action: "skip", reason: "missing-key" };
  return { action: "subscribe", reason: "ok" };
}

export interface PushSubscriptionKeys {
  p256dh?: string;
  auth?: string;
}

/** The serializable shape of a PushSubscription (PushSubscription.toJSON()). */
export interface PushSubscriptionShape {
  endpoint?: string;
  keys?: PushSubscriptionKeys;
}

/** A row in the `push_subscriptions` table (minus server-assigned columns). */
export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  user_agent: string | null;
}

/**
 * Shape a PushSubscription (its toJSON form) into a DB row. Returns null when
 * there is no endpoint (nothing to store / send to).
 */
export function subscriptionToPayload(
  sub: PushSubscriptionShape,
  userAgent: string | null,
): PushSubscriptionRow | null {
  if (!sub.endpoint) return null;
  return {
    endpoint: sub.endpoint,
    p256dh: sub.keys?.p256dh ?? null,
    auth: sub.keys?.auth ?? null,
    user_agent: userAgent ?? null,
  };
}

/** A push endpoint is "gone" (should be pruned) when it returns 404 or 410. */
export function isGoneStatus(status: number): boolean {
  return status === 404 || status === 410;
}

export interface PushSendResult {
  endpoint: string;
  statusCode: number;
}

/**
 * Given per-endpoint send results, return the endpoints whose subscriptions are
 * gone and should be deleted. Shared contract with the send-push edge function
 * (which reimplements the same rule in Deno).
 */
export function endpointsToPrune(results: PushSendResult[]): string[] {
  return results.filter((r) => isGoneStatus(r.statusCode)).map((r) => r.endpoint);
}
