import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type BrowserContext, type Page, type TestInfo } from "@playwright/test";

interface DiagnosticEvent { at: number; source: string; event: string; detail: unknown }
const MAX_EVENTS = 12_000;

/** Read-only evidence for the old-worker to new-worker upgrade boundary. */
export async function installPwaUpgradeDiagnostics(page: Page, context: BrowserContext) {
  const events: DiagnosticEvent[] = [];
  const note = (source: string, event: string, detail: unknown) => {
    events.push({ at: Date.now(), source, event, detail });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  };

  // This runs in each document before the app entry. Session storage survives
  // the watchdog's reload even if the first new document never boots.
  await page.addInitScript(() => {
    const key = "wops-e2e-upgrade-timeline";
    const note = (event: string, detail?: unknown) => {
      try {
        const prior = JSON.parse(sessionStorage.getItem(key) || "[]") as unknown[];
        prior.push({ at: Date.now(), event, detail });
        sessionStorage.setItem(key, JSON.stringify(prior.slice(-160)));
      } catch { /* Diagnostics must not affect startup. */ }
    };
    const controller = () => navigator.serviceWorker?.controller?.scriptURL ?? null;
    const boot = () => document.documentElement?.dataset.forgeBootStarted ?? null;
    const watchdog = () => {
      try { return sessionStorage.getItem("wops-empty-boot-diagnostic"); }
      catch { return null; }
    };
    note("document-start", { url: location.href, controller: controller(), boot: boot(), watchdog: watchdog() });
    const watchBoot = () => {
      if (!document.documentElement) return;
      new MutationObserver(() => note("boot-marker", { boot: boot(), watchdog: watchdog() }))
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-forge-boot-started"] });
    };
    if (document.documentElement) watchBoot();
    else document.addEventListener("DOMContentLoaded", watchBoot, { once: true });
    document.addEventListener("DOMContentLoaded", () => note("dom-content-loaded", { boot: boot(), watchdog: watchdog() }));
    window.addEventListener("load", () => note("load", {
      boot: boot(), watchdog: watchdog(), controller: controller(),
      resources: performance.getEntriesByType("resource")
        .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name)).slice(-20)
        .map((entry) => ({ path: new URL(entry.name).pathname, duration: entry.duration })),
    }));
    window.addEventListener("pagehide", () => note("pagehide", { boot: boot(), watchdog: watchdog() }));
    window.addEventListener("error", (event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
        note("resource-error", target.getAttribute("src") || target.getAttribute("href"));
      } else if (event instanceof ErrorEvent) note("window-error", event.message);
    }, true);
    window.addEventListener("unhandledrejection", (event) => note("unhandled-rejection", String(event.reason)));
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      const sw = navigator.serviceWorker.controller;
      note("controllerchange", { scriptURL: sw?.scriptURL ?? null, state: sw?.state ?? null });
      sw?.addEventListener("statechange", () => note("controller-state", sw.state));
    });
    navigator.serviceWorker?.ready.then((registration) => {
      const watch = (sw: ServiceWorker | null, kind: string) => {
        if (!sw) return;
        note("worker-state", { kind, scriptURL: sw.scriptURL, state: sw.state });
        sw.addEventListener("statechange", () => note("worker-state", { kind, scriptURL: sw.scriptURL, state: sw.state }));
      };
      watch(registration.active, "active");
      registration.addEventListener("updatefound", () => watch(registration.installing, "installing"));
    }).catch(() => undefined);
  });

  page.on("pageerror", (error) => note("playwright", "pageerror", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") note("playwright", "console-error", message.text()); });
  context.on("serviceworker", (worker) => {
    note("playwright", "serviceworker", worker.url());
    worker.on("close", () => note("playwright", "serviceworker-close", worker.url()));
  });

  const cdp = await context.newCDPSession(page);
  const browserVersion = await cdp.send("Browser.getVersion");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("ServiceWorker.enable");
  cdp.on("ServiceWorker.workerVersionUpdated", (event) => note("cdp", "workerVersionUpdated", event));
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => note("cdp", "workerRegistrationUpdated", event));
  cdp.on("Network.requestWillBeSent", (event) => note("cdp", "requestWillBeSent", {
    requestId: event.requestId, loaderId: event.loaderId, frameId: event.frameId,
    timestamp: event.timestamp, wallTime: event.wallTime, type: event.type,
    documentURL: event.documentURL, url: event.request.url,
    initiator: event.initiator,
    redirectResponse: event.redirectResponse && {
      status: event.redirectResponse.status, fromServiceWorker: event.redirectResponse.fromServiceWorker,
      fromDiskCache: event.redirectResponse.fromDiskCache,
    },
  }));
  cdp.on("Network.responseReceived", (event) => note("cdp", "responseReceived", {
    requestId: event.requestId, loaderId: event.loaderId, frameId: event.frameId,
    timestamp: event.timestamp, type: event.type, url: event.response.url,
    status: event.response.status, fromServiceWorker: event.response.fromServiceWorker,
    fromDiskCache: event.response.fromDiskCache, fromPrefetchCache: event.response.fromPrefetchCache,
  }));
  cdp.on("Network.requestServedFromCache", (event) => note("cdp", "requestServedFromCache", { requestId: event.requestId }));
  cdp.on("Network.loadingFinished", (event) => note("cdp", "loadingFinished", {
    requestId: event.requestId, timestamp: event.timestamp, encodedDataLength: event.encodedDataLength,
  }));
  cdp.on("Network.loadingFailed", (event) => note("cdp", "loadingFailed", {
    requestId: event.requestId, timestamp: event.timestamp, errorText: event.errorText,
    canceled: event.canceled, blockedReason: event.blockedReason, type: event.type,
  }));
  cdp.on("Page.frameNavigated", (event) => note("cdp", "frameNavigated", {
    frameId: event.frame.id, parentId: event.frame.parentId, loaderId: event.frame.loaderId,
    url: event.frame.url, unreachableUrl: event.frame.unreachableUrl,
  }));

  return {
    async attach(testInfo: TestInfo, name: string) {
      const browserTimeline = await page.evaluate(() => ({
        timeline: JSON.parse(sessionStorage.getItem("wops-e2e-upgrade-timeline") || "[]"),
        watchdog: sessionStorage.getItem("wops-empty-boot-diagnostic"),
        boot: document.documentElement?.dataset.forgeBootStarted ?? null,
      })).catch((error) => ({ readError: String(error) }));
      // A body-only attachment is discarded by the list reporter on passing
      // tests. Persist a path first so diagnostic non-reproductions retain
      // their evidence too; they never clear the original release failure.
      const artifact = testInfo.outputPath(name);
      await mkdir(dirname(artifact), { recursive: true });
      await writeFile(artifact, JSON.stringify({ browserVersion, platform: process.platform, node: process.version, events, browserTimeline }, null, 2));
      await testInfo.attach(name, { path: artifact, contentType: "application/json" });
      await cdp.detach().catch(() => undefined);
    },
  };
}
