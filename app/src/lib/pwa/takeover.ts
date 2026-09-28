// The service worker's half of finishing an update: bring the page that asked
// for the switch onto the new build once the new worker is in charge.
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
// Only the page that asked. Another tab, mid-capture, that did not ask for
// the switch is left alone, the same rule the banner keeps for itself.
//
// Pure of the worker's globals so it can be tested: the worker passes its
// `clients` in.

/** The part of a WindowClient this needs. */
export interface TakeoverClient {
  url: string;
  navigate?: (url: string) => Promise<unknown>;
}

export interface TakeoverClients {
  get(id: string): Promise<TakeoverClient | undefined>;
}

export interface TakeoverReload {
  /** SKIP_WAITING arrived from this client (the message event's `source`). */
  asked(source: { id: string } | null | undefined): void;
  /**
   * The worker is active and in control: reload the page that asked, if it
   * is still there and the browser lets a worker navigate it. Resolves to
   * whether a page was sent to reload. The ask is consumed either way — a
   * later activation, with no new ask, reloads nobody.
   */
  finish(): Promise<boolean>;
}

export function createTakeoverReload(clients: TakeoverClients): TakeoverReload {
  let asker: string | null = null;
  return {
    asked(source) {
      asker = source?.id ?? null;
    },
    async finish() {
      const id = asker;
      asker = null;
      if (!id) return false;
      try {
        const client = await clients.get(id);
        if (!client?.navigate) return false;
        await client.navigate(client.url);
        return true;
      } catch {
        // A page that closed, or a browser that will not let a worker
        // navigate it. The page reloads itself when it can; nothing to do.
        return false;
      }
    },
  };
}
