// Reusable bad-signal network shapes for Playwright (spec K-X1).
//
// One bar of signal in a conex does not look like "offline" — `page.route`'s
// own `route.abort()` with no delay is the easy, unrealistic case. It looks
// like one of these three things happening to a request that otherwise looks
// completely normal:
//
//   - SLOW: the response eventually arrives, just late (delayRoute)
//   - HUNG: the response never arrives, and the connection never says so
//     either — the request just sits there until the APP gives up on it, not
//     the network (hangRoute)
//   - DROPPED: the connection dies partway through — indistinguishable, from
//     the browser's side, from "the server did the work and the reply never
//     made it back" (dropReplyRoute)
//
// Built for K0.7 (a lazy screen's chunk request) and meant to outlive it —
// K-X1's release rule asks for the SAME three shapes against the clock and
// photo uploads in later releases, so this lives in support/, not in one
// spec file. All three take a Playwright `Page` and a URL pattern (the same
// shape `page.route` itself takes) and return a handle whose `release()`
// stops the injected failure — call it before the action that triggers the
// request, same as any other `page.route` call, and `release()` once the
// test wants the SAME pattern to start succeeding normally.
//
// hangRoute's request is a dead end on purpose: once a specific request has
// been left unresolved, nothing — not even `release()` — can complete THAT
// request from here (Playwright is waiting on this handler to decide, and it
// never will). `release()` only stops the pattern from catching requests made
// AFTER it runs. A spec proving "Try again succeeds" wants delayRoute instead,
// where the original request genuinely finishes; a spec proving "there is
// always a way out" (Go to Work, never Try again) is what hangRoute is for.

import type { Page, Route } from "@playwright/test";

export interface BadSignalHandle {
  /** Stop injecting the failure. Requests made after this go through normally. */
  release(): Promise<void>;
}

async function installRoute(
  page: Page,
  pattern: string | RegExp,
  handler: (route: Route) => void | Promise<void>,
): Promise<BadSignalHandle> {
  await page.route(pattern, handler);
  return { release: () => page.unroute(pattern, handler) };
}

/** Delay every matching response by `delayMs` before letting it through. */
export function delayRoute(page: Page, pattern: string | RegExp, delayMs: number) {
  return installRoute(page, pattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.continue();
  });
}

/**
 * Hang every matching request forever — never fulfilled, continued or
 * aborted. This is what a stalled connection looks like to the code that
 * asked for it: no error, no data, just silence. Whatever deadline the app
 * itself enforces (weakSignal's REQUEST_TIMEOUT_MS, K0.7's 20-second lazy-route
 * limit) is the only thing that ever ends it for the person waiting — which is
 * the point: this proves the APP's own deadline, not the network's.
 */
export function hangRoute(page: Page, pattern: string | RegExp) {
  return installRoute(page, pattern, () => {
    // Deliberately no fulfill/continue/abort — see the file header.
  });
}

/**
 * Let a matching request go out, then kill the connection before any response
 * arrives — a lost reply, indistinguishable on the client from "the server
 * did the work and I never heard back." `afterMs` (default 0) is how long the
 * connection stays open before dying, standing in for however long the
 * server's own write actually took.
 */
export function dropReplyRoute(
  page: Page,
  pattern: string | RegExp,
  afterMs = 0,
) {
  return installRoute(page, pattern, async (route) => {
    if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
    await route.abort("connectionclosed");
  });
}
