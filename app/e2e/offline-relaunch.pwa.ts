// The installed app, reopened with no signal, from the service worker's copy
// alone (run with `npx playwright test --config playwright.pwa.config.ts`).
//
// A phone that has opened Forge once has a service worker holding every chunk
// the build lists in its precache. With no signal, that copy is all it has:
// the browser's own cache is short-lived (Pages sends max-age=600) and a
// phone evicts it whenever it likes. So each test here lets the worker
// install, THROWS AWAY the browser cache, cuts the network, and reloads — a
// file the precache does not hold cannot be fetched after that, and the test
// names it.
//
// The first test is the app starting at all. It failed on master at 160e4d2:
// React had been folded into the crash monitor's chunk, which the worker
// skips while monitoring is off, so the entry could not load (see the
// codeSplitting note in vite.config.ts). The second covers what the entry-
// chunk diet made lazy — three job-hub tabs and the camera decoder — which
// must open from the precache too, now that they are not in the entry.

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { hideWrongProjectBanner } from "./support/specHelpers";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/**
 * Wait until the service worker is installed — its install step IS the
 * precache, so "activated" means every listed file is on the phone — and in
 * control of this page.
 */
async function serviceWorkerReady(page: Page) {
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

/** No network, and nothing left in the browser's HTTP cache to fall back on. */
async function cutTheNetwork(page: Page, context: BrowserContext) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.detach();
  await context.setOffline(true);
}

/** Every request for one of the app's own files that failed. */
function failedAppFiles(page: Page): string[] {
  const failed: string[] = [];
  page.on("requestfailed", (req) => {
    const url = new URL(req.url());
    if (url.host.startsWith("localhost") && /\.(js|css)$/.test(url.pathname)) failed.push(url.pathname);
  });
  return failed;
}

test("the app starts with no signal from the service worker's copy alone", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await serviceWorkerReady(page);

  await cutTheNetwork(page, context);
  const failed = failedAppFiles(page);
  await page.reload();

  // The missing file, if there is one, is the useful half of a failure here,
  // so it is checked first; a blank page on its own says nothing about why.
  const started = await page
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  expect(failed, "files the app needed that the precache did not have").toEqual([]);
  expect(started, "the app never drew its first screen").toBe(true);
});

test("the job hub's lead tabs and the scanner's camera decoder load from the service worker's copy", async ({
  page,
  context,
}) => {
  // The fixture router keeps answering data calls after the network is cut —
  // Playwright answers them itself, nothing goes over a network. What this
  // test is about is where the CODE for these screens comes from, and that is
  // only ever the precache here. (A relaunch with no data at all would not
  // show a lead's tabs: the signed-in role is not one of the answers the
  // phone keeps offline — `myRealProfile` in lib/queryKeys.ts.)
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);

  const tabs = page.locator(".hub-tabs");
  await page.goto(`/projects/${BLACK22.projectId}`);
  await expect(tabs.getByText("Dispatch", { exact: true })).toBeVisible();
  await serviceWorkerReady(page);

  await cutTheNetwork(page, context);
  const failed = failedAppFiles(page);
  await page.reload();
  await expect(tabs.getByText("Dispatch", { exact: true })).toBeVisible();

  await tabs.getByText("Dispatch", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dispatch", exact: true })).toBeVisible();

  await tabs.getByText("Warehouse", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan packages & labels" })).toBeVisible();

  await tabs.getByText("Brain", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Estimates — by signature" })).toBeVisible();

  // The scan screen mounts the camera straight away; with this config's fake
  // camera the decoder can only start — and draw its <video> — if its chunk
  // loaded.
  await page.goto("/scan");
  await expect(page.locator(".scanner-viewport video")).toBeVisible();

  // Nothing ever showed the "didn't load on this signal" fallback, and no
  // file the app asked for was missing.
  await expect(page.getByText("didn't load", { exact: false })).toHaveCount(0);
  expect(failed, "files the app needed that the precache did not have").toEqual([]);
});
