// A phone carrying yesterday's service worker into today's deploy (run with
// `npx playwright test --config playwright.pwa.config.ts`).
//
// This is the test that would have caught 2026-09-25. #664 fixed the offline
// cold start and passed every check in the repo, because every check looked
// at ONE build: the dev server, a fresh browser profile on the new build, the
// bundle on disk. What broke only existed between two builds. A phone whose
// worker still held the previous build loaded that build's index.html and
// entry from the worker's copy, and the entry asked the NETWORK for one file
// the worker had never saved — a file the new deploy no longer had. Black
// screen, on every phone and laptop with the app installed, and because the
// app could not start it could not notice the new build and update itself
// either. The harness (e2e/support/pwaHarness.ts) serves the build phones
// are running today (origin/master) and this tree from one origin, so the
// first test walks exactly that path: install the old worker, deploy the new
// build, let the browser cache expire, reopen.
//
// The other two are the "new version" banner coming back after Refresh, which
// the owner hit about seven times that afternoon, after the rollback. Both
// are shapes where the new worker takes over but the page is never reloaded
// onto it, so the banner's ten-second fallback offers Refresh again, and
// Refresh has nothing left to post to. They were reproduced here first and
// fixed in PwaBanners.tsx; see the notes on each.

import { expect, test, type Page } from "@playwright/test";
import {
  cutTheNetwork,
  expireBrowserCache,
  failedAppFiles,
  harnessState,
  nudgeUpdateCheck,
  runningEntry,
  serveBuild,
  serviceWorkerReady,
  signInButton,
  updateBanner,
} from "./support/pwa";

/** Count page loads from now on, to prove a switch happened once and only once. */
function countLoads(page: Page): { loads: () => number } {
  let n = 0;
  page.on("load", () => {
    n += 1;
  });
  return { loads: () => n };
}

/** After the switch: the new build stays, nothing reloads again, no banner returns. */
async function expectSettledOn(page: Page, entry: string, loads: () => number) {
  const after = loads();
  await page.waitForTimeout(15_000);
  expect(loads(), "the page reloaded again after switching").toBe(after);
  await expect(updateBanner(page), "the update banner came back after the switch").toHaveCount(0);
  expect(await runningEntry(page)).toBe(entry);
  await expect(signInButton(page)).toBeVisible();
}

test("a phone on the previous build opens the app after a deploy, then switches to the new build, once", async ({
  page,
  context,
  request,
}) => {
  const { builds } = await harnessState(request);
  expect(builds.old.entry, "the two builds are different builds").not.toBe(builds.new.entry);

  // Yesterday: the phone opened Forge and its worker installed the build of
  // the day. Opened once more, so the page is a returning one (registered
  // with a worker already in control — the shape every later open has).
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  expect(await runningEntry(page)).toBe(builds.old.entry);

  // The app is closed. A deploy lands. More than ten minutes pass, so the
  // browser's own cache (max-age=600) is empty: whatever the old worker did
  // not save has to come from today's server.
  await page.goto("about:blank");
  await serveBuild(request, "new");
  await expireBrowserCache(page, context);

  // Today: the phone opens the app. The old worker answers with the old
  // shell, and the old shell has to be able to start.
  const failed = failedAppFiles(page);
  const { loads } = countLoads(page);
  await page.goto("/");
  const started = await signInButton(page)
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  expect(
    failed,
    "files the previous build's shell asked today's server for and did not get — the 2026-09-25 black screen",
  ).toEqual([]);
  expect(started, "the previous build's shell never drew its first screen").toBe(true);

  // Then it notices the new build, downloads it, and — on the sign-in screen,
  // where there is nothing to lose — switches over by itself.
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message: "the app never switched to the new build",
    })
    .toBe(builds.new.entry);
  await expect(signInButton(page)).toBeVisible();

  // Once: no second reload, no banner asking again.
  await expectSettledOn(page, builds.new.entry, loads);

  // And the new worker is the one in charge now: the next open with no
  // signal comes entirely from the new build's copy.
  await cutTheNetwork(page, context);
  const offlineFailed = failedAppFiles(page);
  await page.reload();
  await expect(signInButton(page)).toBeVisible();
  expect(offlineFailed, "files the new build needed offline that its worker did not have").toEqual([]);
  expect(await runningEntry(page)).toBe(builds.new.entry);
});

test("a phone whose very first session sees a deploy switches over, instead of offering Refresh for ever", async ({
  page,
  request,
}) => {
  // The shape: a browser that has never had the app — a laptop opening the
  // site, a phone after "clear site data" — registers its first worker with
  // no worker in control. vite-plugin-pwa remembers that, and when a LATER
  // worker takes over in the same session it does not reload the page
  // (workbox-window reports the takeover as not-an-update). The new worker
  // is in charge, the old shell is still on screen, and the banner's
  // fallback offers Refresh again — which now has nothing to post to.
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  expect(await runningEntry(page)).toBe(builds.old.entry);

  // A deploy lands while the app is open; the person comes back to it.
  await serveBuild(request, "new");
  const { loads } = countLoads(page);
  await nudgeUpdateCheck(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message:
        "the new worker took over but the page never reloaded onto it — from here Refresh does nothing and the banner keeps coming back",
    })
    .toBe(builds.new.entry);
  await expectSettledOn(page, builds.new.entry, loads);
});

test("a download that broke halfway does not leave Refresh doing nothing afterwards", async ({
  page,
  request,
}) => {
  // Four deploys landed within an hour on 2026-09-25. A check that lands
  // while a deploy is half there downloads a worker whose file list names a
  // chunk the server does not have yet, so that install fails. The NEXT
  // check succeeds — but workbox-window stopped watching after the first
  // update it judged external, so vite-plugin-pwa never learns of the second
  // worker and never attaches its reload. The app itself sees the second
  // worker waiting, asks it to take over, it does, and the page stays on the
  // old shell: Refresh, ten seconds, Refresh, ten seconds.
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();

  // Record what the registration sees, so the failed install is observed
  // rather than assumed.
  await page.evaluate(async () => {
    const states: string[] = [];
    (window as unknown as { __swStates: string[] }).__swStates = states;
    const reg = await navigator.serviceWorker.getRegistration();
    reg?.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      states.push("found");
      sw.addEventListener("statechange", () => states.push(sw.state));
    });
  });
  const states = () => page.evaluate(() => (window as unknown as { __swStates: string[] }).__swStates);

  // An update found within a minute of registering is one workbox-window
  // treats as its own; the field's updates come long after, and are not.
  await page.waitForTimeout(61_000);

  // The deploy is half there: the new build, minus one chunk its worker
  // precaches. The download fails and the worker is thrown away.
  await serveBuild(request, "new", [builds.new.entry]);
  await nudgeUpdateCheck(page);
  await expect.poll(states, { timeout: 60_000, message: "the half-deployed worker never failed to install" }).toContain(
    "redundant",
  );
  expect(await runningEntry(page)).toBe(builds.old.entry);

  // The deploy finishes. The next check downloads the whole thing, and the
  // app switches to it — on the sign-in screen, by itself.
  await serveBuild(request, "new");
  const { loads } = countLoads(page);
  await nudgeUpdateCheck(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message:
        "the second worker took over but the page never reloaded onto it — from here Refresh does nothing and the banner keeps coming back",
    })
    .toBe(builds.new.entry);
  await expectSettledOn(page, builds.new.entry, loads);
});
