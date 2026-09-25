// Helpers for the `*.pwa.ts` specs: the installed app, its service worker,
// and the harness that serves two real builds (pwaHarness.ts).

import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

export interface HarnessBuild {
  name: "old" | "new";
  dir: string;
  /** The hashed entry chunk index.html loads, e.g. `assets/index-Ab12Cd34.js`. */
  entry: string;
  buildId: string;
}

export interface HarnessState {
  serving: "old" | "new";
  missing: string[];
  builds: { old: HarnessBuild; new: HarnessBuild };
}

/** Which build the harness is serving, and what both builds are. */
export async function harnessState(request: APIRequestContext): Promise<HarnessState> {
  const res = await request.get("/__pwa-harness/state");
  expect(res.ok(), "the pwa harness answered").toBe(true);
  return (await res.json()) as HarnessState;
}

/**
 * Deploy: switch the origin to the other build. `missing` makes the harness
 * answer 404 for those paths while this build is served — a deploy caught
 * halfway, or a file the new deploy simply no longer has.
 */
export async function serveBuild(
  request: APIRequestContext,
  build: "old" | "new",
  missing: string[] = [],
): Promise<void> {
  const query = missing.length ? `?missing=${encodeURIComponent(missing.join(","))}` : "";
  const res = await request.post(`/__pwa-harness/serve/${build}${query}`);
  expect(res.ok(), `the harness switched to the ${build} build`).toBe(true);
}

/**
 * Wait until the service worker is installed — its install step IS the
 * precache, so "activated" means every listed file is on the phone — and in
 * control of this page.
 */
export async function serviceWorkerReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return reg?.active?.state === "activated" && navigator.serviceWorker.controller !== null;
        }),
      { timeout: 90_000, message: "the service worker never finished installing" },
    )
    .toBe(true);
}

/**
 * Empty the browser's own HTTP cache. GitHub Pages sends max-age=600, so a
 * phone opened more than ten minutes after its last load has nothing in that
 * cache; every file comes from the service worker's copy or the network.
 */
export async function expireBrowserCache(page: Page, context: BrowserContext): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.detach();
}

/** No network, and nothing left in the browser's HTTP cache to fall back on. */
export async function cutTheNetwork(page: Page, context: BrowserContext): Promise<void> {
  await expireBrowserCache(page, context);
  await context.setOffline(true);
}

/** Every request for one of the app's own files that failed, from now on. */
export function failedAppFiles(page: Page): string[] {
  const failed: string[] = [];
  page.on("requestfailed", (req) => {
    const url = new URL(req.url());
    if (url.host.startsWith("localhost") && /\.(js|css)$/.test(url.pathname)) failed.push(url.pathname);
  });
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.host.startsWith("localhost") && /\.(js|css)$/.test(url.pathname) && res.status() >= 400) {
      failed.push(`${url.pathname} (${res.status()})`);
    }
  });
  return failed;
}

/** The entry chunk the page on screen is running, e.g. `assets/index-Ab12Cd34.js`. */
export async function runningEntry(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    return script ? new URL(script.src).pathname.replace(/^\//, "") : null;
  });
}

/** The sign-in button: the first thing a signed-out phone draws. */
export function signInButton(page: Page) {
  return page.getByRole("button", { name: "Sign in", exact: true });
}

/** The "new version" banner, in either of its wordings. */
export function updateBanner(page: Page) {
  return page.locator(".pwa-banner-update");
}

/**
 * Make the app look again now, the way coming back to it does, instead of
 * waiting for its five-minute poll. Dispatching visibilitychange while the
 * document is visible is exactly what the app sees on a return.
 */
export async function nudgeUpdateCheck(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}
