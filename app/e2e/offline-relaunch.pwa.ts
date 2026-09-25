// The installed app, reopened with no signal, from the service worker's copy
// alone (run with `npx playwright test --config playwright.pwa.config.ts`).
//
// A phone that has opened Forge once has a service worker holding every chunk
// the build lists in its precache. With no signal, that copy is all it has:
// the browser's own cache is short-lived (Pages sends max-age=600) and a
// phone evicts it whenever it likes. So this lets the worker install, THROWS
// AWAY the browser cache, cuts the network, and reloads — a file the precache
// does not hold cannot be fetched after that, and the test names it.
//
// It failed on master at 160e4d2: React had been folded into the crash
// monitor's chunk, which the worker skips while monitoring is off, so the
// entry could not load (see the codeSplitting note in vite.config.ts). The
// upgrade-path spec beside this one covers the OTHER half of that story —
// what the fix did to phones still on the previous build.

import { expect, test } from "@playwright/test";
import { cutTheNetwork, failedAppFiles, serviceWorkerReady, signInButton } from "./support/pwa";

test("the app starts with no signal from the service worker's copy alone", async ({ page, context }) => {
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);

  await cutTheNetwork(page, context);
  const failed = failedAppFiles(page);
  await page.reload();

  // The missing file, if there is one, is the useful half of a failure here,
  // so it is checked first; a blank page on its own says nothing about why.
  const started = await signInButton(page)
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  expect(failed, "files the app needed that the precache did not have").toEqual([]);
  expect(started, "the app never drew its first screen").toBe(true);
});
