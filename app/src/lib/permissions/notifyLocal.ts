// Local (device) notifications — the payoff for turning notifications on. This
// shows a notification from THIS client only; there is no server/web-push here
// (that's a deliberately deferred follow-up — see the seam note at the bottom).
//
// notifyLocal is a safe no-op unless permission is actually "granted", and it
// dedupes by tag so the same alert can't stack up. The show-decision logic is a
// pure function (planNotification) so the no-op / dedupe guarantees are testable
// without a browser.

export interface LocalNotification {
  title: string;
  body?: string;
  /** Stable id used to dedupe + collapse repeats. Required. */
  tag: string;
  /** Deep link opened when the notification is clicked (best-effort). */
  url?: string;
  /** Small icon; defaults to the app icon. */
  icon?: string;
}

export interface NotifyPlan {
  show: boolean;
  reason: "not-granted" | "duplicate" | "show";
}

/**
 * Pure decision: should we show this notification given the current permission
 * and the set of tags we've already shown? Returns show=false (a no-op) when
 * permission isn't granted or the tag was already shown.
 */
export function planNotification(
  permission: NotificationPermission | null | undefined,
  tag: string,
  seenTags: ReadonlySet<string>,
): NotifyPlan {
  if (permission !== "granted") return { show: false, reason: "not-granted" };
  if (seenTags.has(tag)) return { show: false, reason: "duplicate" };
  return { show: true, reason: "show" };
}

export interface NotifyEnv {
  getPermission(): NotificationPermission | null;
  /** Service-worker registration, if the app has one (preferred delivery). */
  getRegistration(): Promise<ServiceWorkerRegistration | null>;
  /** True when the plain `Notification` constructor exists. */
  canConstructNotification(): boolean;
  /** Construct a page-level notification (fallback path). */
  constructNotification(opts: LocalNotification): void;
}

const seenTags = new Set<string>();

/** Reset the in-memory dedupe set. Exposed for tests. */
export function _resetNotifyDedupe(): void {
  seenTags.clear();
}

const browserNotifyEnv: NotifyEnv = {
  getPermission: () =>
    typeof Notification === "undefined" ? null : Notification.permission,
  getRegistration: async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
      return (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch {
      return null;
    }
  },
  canConstructNotification: () => typeof Notification !== "undefined",
  constructNotification: (opts) => {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: opts.icon,
    });
    if (opts.url) {
      n.onclick = () => {
        try {
          window.focus();
          window.location.assign(opts.url!);
        } catch {
          // ignore — best-effort deep link
        }
      };
    }
  },
};

/**
 * Testable core. Uses the injected env + dedupe set. Returns the plan so callers
 * (and tests) can assert what happened. Delivery prefers the service-worker
 * registration's showNotification (works even when the tab is backgrounded),
 * falling back to the page-level Notification constructor.
 */
export async function notifyLocalWith(
  env: NotifyEnv,
  seen: Set<string>,
  opts: LocalNotification,
): Promise<NotifyPlan> {
  const plan = planNotification(env.getPermission(), opts.tag, seen);
  if (!plan.show) return plan;
  seen.add(opts.tag);
  try {
    const reg = await env.getRegistration();
    if (reg && typeof reg.showNotification === "function") {
      await reg.showNotification(opts.title, {
        body: opts.body,
        tag: opts.tag,
        icon: opts.icon,
        data: opts.url ? { url: opts.url } : undefined,
      });
      return plan;
    }
    if (env.canConstructNotification()) {
      env.constructNotification(opts);
    }
  } catch {
    // A failed notification must never surface to the user or crash a flow.
  }
  return plan;
}

/**
 * Show a local notification for an in-app event. No-op unless the user has
 * granted notification permission; deduped by tag. Never throws.
 *
 * Wire this to existing client-side "what needs you" events (e.g. a new toolbox
 * talk to sign, a timecard approval you can see) — do NOT invent server events.
 *
 * ── WEB-PUSH SEAM (now implemented) ──────────────────────────────────────────
 * Server/web-push delivers the SAME shape ({title, body, tag, url}) via a `push`
 * event handled in the service worker (src/sw.ts), which calls
 * registration.showNotification with identical options — so local and pushed
 * notifications render the same. The server side is the send-push edge function
 * (supabase/functions/send-push); devices subscribe via pushSubscribe.ts. Keep
 * this contract stable across all three.
 */
export function notifyLocal(opts: LocalNotification): Promise<NotifyPlan> {
  return notifyLocalWith(browserNotifyEnv, seenTags, opts);
}
