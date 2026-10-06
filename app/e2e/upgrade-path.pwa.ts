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

import { expect, test, type CDPSession, type Page, type Worker } from "@playwright/test";
import { capturePwaReloadEvidence } from "./support/pwaReloadEvidence";
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

/**
 * Count the page's own document navigations from now on, including one that
 * another navigation cancels (it never fires `load`, so countLoads misses
 * it). The switch to a new build must be ONE navigation. On 2026-09-28 it
 * was two: the page reloaded itself when the new worker took control, the
 * worker navigated it as well, the second cancelled the first, and three of
 * the new entry's imports were aborted along the way. The new build never
 * started, and the app stayed blank until it was reopened. That race is
 * lost only sometimes, but both navigations happen every time, so counting
 * them fails every time.
 */
function countNavigations(page: Page): { navigations: () => string[] } {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) seen.push(req.url());
  });
  return { navigations: () => [...seen] };
}

type CdpCallFrame = { url: string; functionName: string; lineNumber: number; columnNumber: number };
type CdpStack = { callFrames: CdpCallFrame[]; parent?: CdpStack };
const PROVENANCE_MAX_EVENTS = 500;
const PROVENANCE_MAX_REQUESTS = 250;
const PROVENANCE_MAX_FRAMES_TRACKED = 64;
const PROVENANCE_STACK_FRAMES = 4;
const PROVENANCE_STACK_DEPTH = 2;

/**
 * Read-only network/lifecycle provenance for the switch to the new build.
 *
 * Retained CI 37388156633 (2026-10-05): six of the new document's module
 * requests were cancelled about 600 ms BEFORE the empty-boot recovery reload,
 * and nothing kept said who cancelled them. This keeps what that trace lacked
 * — request/loader/frame ids, initiators, response cache and service-worker
 * provenance, failures, finishes and frame lifecycle — for the harness origin
 * ONLY, as origin+path (never query, hash, headers, cookies or bodies), in a
 * bounded ring. Routing, cache, worker, delays and assertions stay unchanged;
 * enabling CDP domains adds observer-startup awaits. Service-worker target requests are not
 * visible on this page session.
 */
async function observeProvenance(cdp: CDPSession, admittedOrigin: string | null) {
  const events: Record<string, unknown>[] = [];
  const requests = new Map<string, { path: string; loaderId: string; frameId: string | null; resourceType: string | null }>();
  const frames = new Set<string>();
  const enableErrors: string[] = [];
  let droppedEvents = 0;
  let evictedRequests = 0;
  const admitted = (raw: string | undefined) => {
    try { return !!raw && admittedOrigin !== null && new URL(raw).origin === admittedOrigin; } catch { return false; }
  };
  const pathOf = (raw: string | undefined) => {
    if (!raw) return "(inline)";
    try { const url = new URL(raw); return url.origin === admittedOrigin ? url.pathname : "(other origin)"; } catch { return "(unparsed)"; }
  };
  const push = (event: Record<string, unknown>) => {
    events.push({ ...event, observedAtEpochMs: Date.now() });
    if (events.length > PROVENANCE_MAX_EVENTS) { events.shift(); droppedEvents += 1; }
  };
  const stackOf = (stack: CdpStack | undefined, depth = 0): unknown =>
    stack && depth < PROVENANCE_STACK_DEPTH
      ? {
          callFrames: stack.callFrames.slice(0, PROVENANCE_STACK_FRAMES).map((f) => ({
            path: pathOf(f.url), functionName: (f.functionName || "").slice(0, 80), line: f.lineNumber, column: f.columnNumber,
          })),
          parent: stackOf(stack.parent, depth + 1),
        }
      : null;
  const track = (frameId: string | undefined) => {
    if (frameId && frames.size < PROVENANCE_MAX_FRAMES_TRACKED) frames.add(frameId);
  };

  const onRequest = (e: {
    requestId: string; loaderId: string; frameId?: string; timestamp: number; wallTime: number; type?: string;
    request: { url: string }; redirectResponse?: unknown;
    initiator: { type: string; url?: string; lineNumber?: number; stack?: CdpStack };
  }) => {
    // A redirect reuses requestId; forget a local binding when it leaves the origin.
    if (!admitted(e.request.url)) { requests.delete(e.requestId); return; }
    if (!requests.has(e.requestId) && requests.size >= PROVENANCE_MAX_REQUESTS) {
      const oldest = requests.keys().next().value;
      if (oldest !== undefined) requests.delete(oldest);
      evictedRequests += 1;
    }
    const path = pathOf(e.request.url);
    requests.set(e.requestId, { path, loaderId: e.loaderId, frameId: e.frameId ?? null, resourceType: e.type ?? null });
    track(e.frameId);
    push({
      kind: "requestWillBeSent", requestId: e.requestId, loaderId: e.loaderId, frameId: e.frameId ?? null,
      cdpMonotonicSec: e.timestamp, browserWallTimeSec: e.wallTime, path, resourceType: e.type ?? null,
      redirect: e.redirectResponse !== undefined,
      initiator: { type: e.initiator.type, path: e.initiator.url ? pathOf(e.initiator.url) : null,
        line: e.initiator.lineNumber ?? null, stack: stackOf(e.initiator.stack) },
    });
  };
  const onResponse = (e: {
    requestId: string; loaderId: string; frameId?: string; timestamp: number;
    response: { status: number; fromServiceWorker?: boolean; fromDiskCache?: boolean; fromPrefetchCache?: boolean; protocol?: string };
  }) => {
    const r = requests.get(e.requestId);
    if (!r) return;
    push({
      kind: "responseReceived", requestId: e.requestId, loaderId: e.loaderId, frameId: e.frameId ?? null,
      cdpMonotonicSec: e.timestamp, path: r.path, status: e.response.status,
      fromServiceWorker: e.response.fromServiceWorker ?? null, fromDiskCache: e.response.fromDiskCache ?? null,
      fromPrefetchCache: e.response.fromPrefetchCache ?? null, protocol: e.response.protocol ?? null,
    });
  };
  const onFailed = (e: { requestId: string; timestamp: number; errorText: string; canceled?: boolean; blockedReason?: string }) => {
    const r = requests.get(e.requestId);
    if (!r) return;
    push({
      kind: "loadingFailed", requestId: e.requestId, loaderId: r.loaderId, frameId: r.frameId, cdpMonotonicSec: e.timestamp,
      path: r.path, resourceType: r.resourceType, errorText: e.errorText, canceled: Boolean(e.canceled), blockedReason: e.blockedReason ?? null,
    });
  };
  const onFinished = (e: { requestId: string; timestamp: number; encodedDataLength: number }) => {
    const r = requests.get(e.requestId);
    if (!r) return;
    push({
      kind: "loadingFinished", requestId: e.requestId, loaderId: r.loaderId, frameId: r.frameId, cdpMonotonicSec: e.timestamp,
      path: r.path, encodedDataLength: e.encodedDataLength,
    });
  };
  const onNavigated = (e: { frame: { id: string; parentId?: string; loaderId: string; url: string } }) => {
    if (!admitted(e.frame.url)) { frames.delete(e.frame.id); return; }
    track(e.frame.id);
    push({
      kind: "frameNavigated", frameId: e.frame.id, parentFrameId: e.frame.parentId ?? null, loaderId: e.frame.loaderId,
      cdpMonotonicSec: null, path: pathOf(e.frame.url),
    });
  };
  const onLifecycle = (e: { frameId: string; loaderId: string; name: string; timestamp: number }) => {
    if (!frames.has(e.frameId)) return;
    push({ kind: "lifecycleEvent", frameId: e.frameId, loaderId: e.loaderId, name: e.name, cdpMonotonicSec: e.timestamp });
  };

  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.responseReceived", onResponse);
  cdp.on("Network.loadingFailed", onFailed);
  cdp.on("Network.loadingFinished", onFinished);
  cdp.on("Page.frameNavigated", onNavigated);
  cdp.on("Page.lifecycleEvent", onLifecycle);
  // Domain enables only; a failure here is recorded, never thrown into the test.
  try { await cdp.send("Page.enable"); } catch (error) { enableErrors.push(`Page.enable: ${String(error).slice(0, 200)}`); }
  try {
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  } catch (error) {
    enableErrors.push(`Page.setLifecycleEventsEnabled: ${String(error).slice(0, 200)}`);
  }

  return {
    snapshot: () => ({
      scope: {
        admittedOrigin,
        recorded: "admitted harness origin only, as origin+path; other origins omitted or shown as '(other origin)'; no query, hash, headers, cookies or bodies",
        session: "this page's CDP session; service-worker target requests are not visible here",
        bounds: { maxEvents: PROVENANCE_MAX_EVENTS, maxRequests: PROVENANCE_MAX_REQUESTS, stackFrames: PROVENANCE_STACK_FRAMES, stackDepth: PROVENANCE_STACK_DEPTH },
      },
      clockScope: {
        cdpMonotonicSec: "Chromium monotonic event time in seconds; comparable only between events of this browser; not an epoch",
        browserWallTimeSec: "requestWillBeSent wallTime: browser epoch seconds at request start only",
        observedAtEpochMs: "Node Date.now() when the event reached the test process; includes delivery delay; not the browser event time",
        note: "A gap between a request's browser start time and a failure's observedAtEpochMs is delivery and ordering across clocks, not a clock offset. Compare like with like.",
      },
      droppedEvents, evictedRequests, trackedRequests: requests.size, enableErrors: [...enableErrors],
      events: events.slice(),
    }),
    dispose: () => {
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.responseReceived", onResponse);
      cdp.off("Network.loadingFailed", onFailed);
      cdp.off("Network.loadingFinished", onFinished);
      cdp.off("Page.frameNavigated", onNavigated);
      cdp.off("Page.lifecycleEvent", onLifecycle);
      requests.clear();
      frames.clear();
      events.length = 0;
    },
  };
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
  const bootErrors: string[] = [];
  await page.addInitScript(() => {
    (window as Window & { __emptyBootRecoveryAtNavigation?: string | null }).__emptyBootRecoveryAtNavigation =
      sessionStorage.getItem("wops-empty-boot-diagnostic");
    // Persist the first document's timing across a watchdog reload. A later
    // screenshot alone cannot tell whether imports failed during activation
    // or were cancelled by the recovery navigation.
    const timelineKey = "wops-e2e-upgrade-timeline";
    const note = (event: string, detail?: string) => {
      const prior = JSON.parse(sessionStorage.getItem(timelineKey) || "[]") as unknown[];
      prior.push({ at: Date.now(), event, detail });
      sessionStorage.setItem(timelineKey, JSON.stringify(prior.slice(-80)));
    };
    note("document-start", document.URL);
    window.addEventListener("load", () => {
      note("load", JSON.stringify({
        bootStarted: document.documentElement.dataset.forgeBootStarted ?? null,
        controllerState: navigator.serviceWorker?.controller?.state ?? null,
        resources: performance.getEntriesByType("resource")
          .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
          .slice(-12)
          .map((entry) => ({ path: new URL(entry.name).pathname, duration: entry.duration })),
      }));
    });
    window.addEventListener("error", (event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
        note("resource-error", target.getAttribute("src") || target.getAttribute("href") || "unknown");
      } else if (event instanceof ErrorEvent) {
        note("window-error", event.message);
      }
    }, true);
    window.addEventListener("unhandledrejection", (event) => note("unhandled-rejection", String(event.reason)));
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      const controller = navigator.serviceWorker.controller;
      note("controllerchange", controller?.state || "no-controller");
      controller?.addEventListener("statechange", () => note("controller-state", controller.state));
    });
  });
  page.on("pageerror", (error) => bootErrors.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") bootErrors.push(`console: ${message.text()}`);
  });
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
  bootErrors.length = 0;

  // Then it notices the new build, downloads it, and — on the sign-in screen,
  // where there is nothing to lose — switches over by itself.
  const navigationTimes: number[] = [];
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navigationTimes.push(Date.now());
  });
  const failedNetwork: { at: number; url: string; error: string; canceled: boolean }[] = [];
  const requestUrls = new Map<string, string>();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event: { requestId: string; request: { url: string } }) => {
    requestUrls.set(event.requestId, event.request.url);
  });
  cdp.on("Network.loadingFailed", (event: { requestId: string; errorText: string; canceled?: boolean }) => {
    const url = requestUrls.get(event.requestId);
    if (url && /\.(js|css)(\?|$)/.test(url)) {
      failedNetwork.push({ at: Date.now(), url: new URL(url).pathname, error: event.errorText, canceled: Boolean(event.canceled) });
    }
  });
  // Preserve the original navigation-counter boundary before any new awaited diagnostics.
  const { navigations } = countNavigations(page);
  // Additive diagnostics on the same session; failedNetwork above is unchanged.
  const admittedOrigin = (() => {
    try { const url = new URL(page.url()); return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) ? url.origin : null; } catch { return null; }
  })();
  const provenance = await observeProvenance(cdp, admittedOrigin);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message: "the app never switched to the new build",
    })
    .toBe(builds.new.entry);
  try {
    await expect(signInButton(page)).toBeVisible();
  } catch (error) {
    // A script tag only proves HTML parsed. If the new shell is blank, keep
    // the browser evidence that distinguishes a failed import from a stalled
    // mount or a later runtime error.
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      rootText: document.getElementById("root")?.textContent?.slice(0, 500) ?? null,
      rootChildren: document.getElementById("root")?.childElementCount ?? null,
      entry: document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      resources: performance.getEntriesByType("resource")
        .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
        .slice(-12)
        .map((entry) => ({ name: entry.name, duration: entry.duration })),
    })).catch((readError) => ({ readError: String(readError) }));
    await test.info().attach("new-build-boot.json", {
      body: JSON.stringify({ state, bootErrors, failedAppFiles: failed, failedNetwork, provenance: provenance.snapshot() }, null, 2),
      contentType: "application/json",
    });
    throw error;
  }

  // Once: no second reload, no banner asking again.
  await expectSettledOn(page, builds.new.entry, loads);
  if (navigations().length !== 1) {
    const emptyBootRecovery = await page.evaluate(() =>
      (window as Window & { __emptyBootRecoveryAtNavigation?: string | null }).__emptyBootRecoveryAtNavigation ?? null,
    );
    const browserTimeline = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("wops-e2e-upgrade-timeline") || "[]"),
    );
    await test.info().attach("upgrade-reload-evidence.json", {
      body: JSON.stringify({ navigations: navigations().map((url, i) => ({ url, at: navigationTimes[i] })), emptyBootRecovery, browserTimeline, failedNetwork, bootErrors, provenance: provenance.snapshot() }, null, 2),
      contentType: "application/json",
    });
  }
  expect(navigations(), "the switch was more than one navigation: two racing reloads can leave the new build blank").toHaveLength(1);
  // Only reached when the strict gate passed. Synchronous listener removal;
  // the session itself closes with the page if an assertion above fails.
  provenance.dispose();

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
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message:
        "the new worker took over but the page never reloaded onto it — from here Refresh does nothing and the banner keeps coming back",
    })
    .toBe(builds.new.entry);
  await expectSettledOn(page, builds.new.entry, loads);
  expect(navigations(), "the switch was more than one navigation: two racing reloads can leave the new build blank").toHaveLength(1);
});

test("an in-flight self reload is not cancelled when the new worker's shell lookup takes five seconds", async ({
  page,
  context,
  request,
}) => {
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);

  // Instrument the newly installed worker before its navigation route runs.
  // A slow response used to hide the first reload from the observer until
  // after the grace period, when the worker started a second navigation.
  const instrumented = new Promise<Worker>((resolve, reject) => {
    context.on("serviceworker", (worker) => {
      void worker.evaluate(() => {
        const probe = self as unknown as { __slowShellLookups: number; registration: ServiceWorkerRegistration };
        probe.__slowShellLookups = 0;
        const original = CacheStorage.prototype.match;
        CacheStorage.prototype.match = async function (request, options) {
          const url = request instanceof Request ? request.url : String(request);
          if (new URL(url, self.location.href).pathname === "/index.html" && probe.registration.active?.state === "activated") {
            probe.__slowShellLookups += 1;
            await new Promise((done) => setTimeout(done, 5_000));
          }
          return original.call(this, request, options);
        };
      }).then(() => resolve(worker), reject);
    });
  });

  await serveBuild(request, "new");
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  const worker = await instrumented;
  await expect.poll(() => runningEntry(page), { timeout: 60_000 }).toBe(builds.new.entry);
  await expect(signInButton(page)).toBeVisible();
  expect(await worker.evaluate(() => (self as unknown as { __slowShellLookups: number }).__slowShellLookups)).toBeGreaterThan(0);
  expect(navigations(), "the worker cancelled an in-flight self reload").toHaveLength(1);
});

test("a second tab on the same URL can reload without suppressing the asking tab", async ({
  page,
  context,
  request,
  browserName,
}, info) => {
  const finishAsking = await capturePwaReloadEvidence(page, context, browserName === "chromium", "two-tab-asking");
  let finishOther: Awaited<ReturnType<typeof capturePwaReloadEvidence>> | undefined;
  try {
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  const other = await context.newPage();
  finishOther = await capturePwaReloadEvidence(other, context, browserName === "chromium", "two-tab-other");
  await other.goto("/");
  await expect(signInButton(other)).toBeVisible();
  await serviceWorkerReady(other);
  expect(other.url()).toBe(page.url());

  await page.exposeFunction("reloadOtherTab", async () => { await other.reload(); });
  await page.evaluate(() => {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      void (window as unknown as { reloadOtherTab: () => Promise<void> }).reloadOtherTab();
    }, { once: true });
  });
  await serveBuild(request, "new");
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  await expect.poll(() => runningEntry(page), { timeout: 60_000 }).toBe(builds.new.entry);
  await expect.poll(() => runningEntry(other), { timeout: 60_000 }).toBe(builds.new.entry);
  await expect(signInButton(page)).toBeVisible();
  expect(navigations(), "the asking tab must switch exactly once").toHaveLength(1);
  } finally {
    await finishAsking(info);
    await finishOther?.(info);
  }
});

test("a download that broke halfway does not leave Refresh doing nothing afterwards", async ({
  page,
  context,
  browserName,
  request,
}) => {
  const attachEvidence = await capturePwaReloadEvidence(page, context, browserName === "chromium");
  try {
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
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message:
        "the second worker took over but the page never reloaded onto it — from here Refresh does nothing and the banner keeps coming back",
    })
    .toBe(builds.new.entry);
  await expectSettledOn(page, builds.new.entry, loads);
  expect(navigations(), "the switch was more than one navigation: two racing reloads can leave the new build blank").toHaveLength(1);
  } finally {
    await attachEvidence(test.info());
  }
});
