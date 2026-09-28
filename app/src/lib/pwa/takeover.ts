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
// Only the page that asked. Another tab, mid-capture, that did not ask for
// the switch is left alone, the same rule the banner keeps for itself.
//
// Pure of the worker's globals so it can be tested: the worker passes its
// `clients`, and a way to know it is active, in.

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
  /** A seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A page that reloads itself is already waiting when the worker activates:
 * its reload was queued behind the activation. The reload reaches the worker
 * within milliseconds, so three seconds is a wide margin. A page from before
 * #669 waits that much longer to be brought across; nothing else does.
 */
export const SELF_RELOAD_GRACE_MS = 3_000;

export interface TakeoverReload {
  /** SKIP_WAITING arrived from this client (the message event's `source`). */
  asked(source: { id: string } | null | undefined): void;
  /**
   * A page navigation reached this worker: some page is already loading from
   * it. Almost always the page that asked, reloading itself.
   */
  navigationSeen(): void;
  /**
   * The worker is in control: once it is active and the grace period has
   * passed, reload the page that asked, unless a navigation was seen in the
   * meantime or the page is gone. Resolves to whether a page was sent to
   * reload. The ask is consumed either way — a later activation, with no new
   * ask, reloads nobody.
   */
  finish(): Promise<boolean>;
}

export function createTakeoverReload(
  clients: TakeoverClients,
  options: TakeoverOptions,
): TakeoverReload {
  const graceMs = options.graceMs ?? SELF_RELOAD_GRACE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let asker: string | null = null;
  let navigated = false;
  return {
    asked(source) {
      asker = source?.id ?? null;
      navigated = false;
    },
    navigationSeen() {
      navigated = true;
    },
    async finish() {
      const id = asker;
      asker = null;
      if (!id) return false;
      try {
        await options.activated();
        await sleep(graceMs);
        // The page is reloading itself, or someone navigated anyway: a
        // navigation now would only cancel it.
        if (navigated) return false;
        // Gone: it reloaded itself (a reloaded page is a new client) or it
        // closed. Either way there is nothing left to bring across.
        const client = await clients.get(id);
        if (!client?.navigate) return false;
        await client.navigate(client.url);
        return true;
      } catch {
        // A browser that will not let a worker navigate a page, or an
        // activation that failed. The page reloads itself when it can.
        return false;
      }
    },
  };
}
