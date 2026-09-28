// The service worker's half of finishing an update: bring the page that asked
// for the switch onto the new build once the new worker is in charge — but
// only a page that is not already reloading itself.
//
// WHY THE WORKER DOES THIS. The page asks a waiting worker to take over by
// posting SKIP_WAITING, and it is the page's job to reload itself when the
// controller changes (PwaBanners.tsx, note 10). On 2026-09-25 that reload
// belonged to vite-plugin-pwa, which only attaches it for a worker that
// workbox-window saw "waiting" 200 ms after it installed — and the app's
// automatic paths apply within milliseconds of the install, so the worker had
// already taken over by then, no reload was ever attached, and every phone
// sat on the old shell under the new worker while the banner offered a
// Refresh that had nothing left to post to. The page-side fix ships in the
// NEW build. A phone on the old build runs the OLD page, which still cannot
// reload itself — and the one piece of new code it does run is this worker,
// the moment it activates. So the worker brings that page across itself.
//
// WHY IT WAITS FIRST. Every build since 2026-09-28 (#669) does reload itself,
// and a page that reloads itself AND is navigated by the worker makes two
// navigations, the second cancelling the first. On 2026-09-28 (the upgrade
// harness on #660's CI run) the worker's navigation won, and three of the new
// entry's imports were aborted in the scramble: the new build never started
// and the app stayed blank until it was reopened. So the worker gives the
// page the first chance. Its own reload is a navigation, and a navigation
// reaches this worker as soon as it is active. The worker waits until it is
// active plus a grace period, and navigates only a page that is still there
// with no navigation seen in that time — a page from before #669, which never
// reloads itself.
//
// Only the page that asked. An unrelated tab's navigation must not suppress
// the asker's fallback, even when both tabs have the same URL. Chromium 151
// measured `FetchEvent.clientId` as the outgoing document's ID, matching the
// SKIP_WAITING message's `source.id`; `resultingClientId` is the new document.
// A missing or empty clientId conservatively suppresses the fallback, since
// it might be the asker. That can leave a legacy page on its old shell if
// an unrelated navigation has no usable ID. WebKit remains unverified.
//
// OWNERSHIP. The original SKIP_WAITING `message` event owns the whole normal
// completion — skipWaiting, waiting for activation, the grace period, and
// the decision to navigate — through ITS `event.waitUntil`. `activate`'s
// waitUntil only claims clients; it must never await the grace period or a
// navigation (that deadlocked the activation itself, 2026-09-25 upgrade
// harness). A second SKIP_WAITING message — the same source resending, or a
// different tab/window asking this worker later — does
// not own anything: it cannot reset the deadline, restart the grace period,
// or cause a second navigation. The first valid ask wins for this worker.
//
// DEADLINE. The page gives up on its OWN wait after TAKEOVER_TIMEOUT_MS — 10
// seconds (updateCore.ts) — and may resume editing. The worker's fallback
// must never navigate that page after the page may have moved on, so
// `finish()` carries its own shorter absolute deadline, TAKEOVER_DEADLINE_MS
// (8 seconds) from the moment of the ask: safely inside the page's 10-second
// window even after clock skew between the worker and page or a slow client
// lookup, never equal to or later than it. That deadline is re-checked after
// the (awaited, hence potentially slow) client lookup — a page can start its
// own reload during that lookup — and again immediately before `navigate()`.
// There is no durable pending-ask state and no late
// retry after the deadline or after an abnormal worker stop: a service
// worker force-stopped by the platform mid-grace has no event left to wake
// it and finish the job, and no future event can safely infer that an old,
// unrelated ask is still wanted. That is a real limitation, not something
// this module can route around — the safe recovery is the user reopening the
// app, not a delayed unsafe navigation.
//
// Pure of the worker's globals so it can be tested: the worker passes its
// `clients`, and a way to know it is active, in.

/**
 * The worker's own absolute deadline, from the moment of the ask. Fixed at 8
 * seconds — safely inside the page's own 10-second TAKEOVER_TIMEOUT_MS
 * (updateCore.ts), so the worker always gives up before the page might, even
 * allowing for clock skew and a slow client lookup. Not derived from
 * TAKEOVER_TIMEOUT_MS itself: the margin between them is the point, so a
 * future change to one must not silently narrow it to zero.
 */
export const TAKEOVER_DEADLINE_MS = 8_000;

/** The part of a WindowClient this needs. */
export interface TakeoverClient {
  url: string;
  navigate?: (url: string) => Promise<unknown>;
}

export interface TakeoverClients {
  get(id: string): Promise<TakeoverClient | undefined>;
}

export interface TakeoverOptions {
  /**
   * Resolves once this worker has finished activating. Until then no fetch
   * reaches it, so a page reloading itself cannot be seen yet.
   */
  activated: () => Promise<void>;
  /** How long, once active, to give the page to reload itself. */
  graceMs?: number;
  /**
   * The absolute time budget from the moment of the ask. Defaults to the
   * page's own TAKEOVER_TIMEOUT_MS (updateCore.ts) — the worker must not act
   * later than the page itself is still willing to wait.
   */
  deadlineMs?: number;
  /** A seam for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** A seam for tests. */
  now?: () => number;
}

/**
 * A page that reloads itself is already waiting when the worker activates:
 * its reload was queued behind the activation. The reload reaches the worker
 * within milliseconds, so three seconds is a wide margin. A page from before
 * #669 waits that much longer to be brought across; nothing else does.
 */
export const SELF_RELOAD_GRACE_MS = 3_000;

export interface TakeoverReload {
  /**
   * A SKIP_WAITING message arrived, carrying the message event's `source`.
   * Returns whether THIS message owns the takeover: true for the first ask
   * (the caller must run `finish()` inside that same event's `waitUntil`),
   * false for a duplicate — a resend from the same source, or any later ask
   * to this worker — which owns nothing and must not be given its own
   * `finish()` call.
   */
  asked(source: { id: string } | null | undefined): boolean;
  /**
   * A page navigation reached this worker, carrying `FetchEvent.clientId` —
   * the navigating client's id from BEFORE the navigation. Only a navigation
   * from the asking client counts; a missing/empty id is treated as
   * if it might be the asker's own (see the file header on why).
   */
  navigationSeen(clientId: string | null | undefined): void;
  /**
   * The worker is in control: once it is active and the grace period has
   * passed, reload the page that asked, unless a navigation was seen in the
   * meantime, the deadline has passed, or the page is gone. Resolves to
   * whether a page was sent to reload. Must only be called by the message
   * event whose `asked()` call returned true; the ask is released either way
   * so a later duplicate cannot restart it.
   */
  finish(): Promise<boolean>;
}

export function createTakeoverReload(
  clients: TakeoverClients,
  options: TakeoverOptions,
): TakeoverReload {
  const graceMs = options.graceMs ?? SELF_RELOAD_GRACE_MS;
  const deadlineMs = options.deadlineMs ?? TAKEOVER_DEADLINE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  // In-memory only, on purpose: a durable "pending ask" that survives a
  // worker restart has no safe late use (see the file header) and only
  // invites a stale, unsafe navigation.
  let asker: string | null = null;
  let deadline = 0;
  let navigated = false;
  let pending = false;
  let accepted = false;
  return {
    asked(source) {
      if (accepted) return false; // first valid ask wins for this worker
      const id = source?.id ?? null;
      if (!id) return false; // nothing to own
      accepted = true;
      asker = id;
      navigated = false;
      deadline = now() + deadlineMs;
      pending = true;
      return true;
    },
    navigationSeen(clientId) {
      if (!pending) return;
      if (clientId == null || clientId === "" || clientId === asker) navigated = true;
    },
    async finish() {
      if (!pending) return false;
      const id = asker;
      try {
        await options.activated();
        await sleep(graceMs);
        // The page is reloading itself, or someone navigated anyway: a
        // navigation now would only cancel it.
        if (navigated) return false;
        // The page's own decision window may have already closed.
        if (now() >= deadline) return false;
        // Gone: it reloaded itself (a reloaded page is a new client) or it
        // closed. Either way there is nothing left to bring across.
        const client = id ? await clients.get(id) : undefined;
        // The client lookup is awaited, so a reload the page started of its
        // own accord during that lookup would not yet have been seen above —
        // and the lookup can be slow, which is its own reason to re-check
        // the deadline too. Both are checked again right before acting.
        if (navigated || now() >= deadline) return false;
        if (!client?.navigate) return false;
        await client.navigate(client.url);
        return true;
      } catch {
        // A browser that will not let a worker navigate a page, or an
        // activation that failed. The page reloads itself when it can.
        return false;
      } finally {
        pending = false;
        asker = null;
      }
    },
  };
}
