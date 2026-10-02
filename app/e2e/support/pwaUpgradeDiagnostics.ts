import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

interface DiagnosticEvent { at: number; source: string; event: string; detail: unknown }
const MAX_EVENTS = 12_000;

/** Read-only evidence for the old-worker to new-worker upgrade boundary. */
export async function installPwaUpgradeDiagnostics(page: Page, context: BrowserContext, options?: { traceBrowser?: Browser }) {
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

  // Browser-target tracing observes worker and resource-loader events without
  // registering a fetch listener or changing requests. The final upgrade test
  // enables it before its first old-build navigation.
  const traceBrowser = options?.traceBrowser;
  const trace = traceBrowser ? await (async () => {
    const session = await traceBrowser.newBrowserCDPSession();
    try {
      const available = (await session.send("Tracing.getCategories")).categories;
      if (!available.includes("ServiceWorker")) throw new Error("Chromium tracing lacks mandatory ServiceWorker category");
      const wanted = ["ServiceWorker", "blink.resource", "disabled-by-default-network"];
      const categories = wanted.filter((category) => available.includes(category));
      await session.send("Tracing.start", { categories: categories.join(","), transferMode: "ReturnAsStream" });
      return { session, categories, unavailable: wanted.filter((category) => !available.includes(category)) };
    } catch (error) {
      await session.detach().catch(() => undefined);
      throw error;
    }
  })() : null;

  const finishTrace = async (testInfo: TestInfo) => {
    if (!trace) return;
    const artifact = testInfo.outputPath("interrupted-download-chromium-trace.json");
    const receipt = testInfo.outputPath("interrupted-download-chromium-trace-receipt.json");
    const result: Record<string, unknown> = {
      categories: trace.categories, unavailable: trace.unavailable, artifact, bytes: 0,
      sourceEvents: ["StartRequest", "DispatchFetchEvent", "CommitCompleted", "ResourceLoaderCancel"],
    };
    try {
      // Register before ending: Chrome may emit tracingComplete immediately.
      let completionTimer: ReturnType<typeof setTimeout> | undefined;
      const streamReady = new Promise<string>((resolve, reject) => {
        completionTimer = setTimeout(() => reject(new Error("Tracing.tracingComplete timed out")), 30_000);
        trace.session.once("Tracing.tracingComplete", (event) => {
          clearTimeout(completionTimer);
          event.stream ? resolve(event.stream) : reject(new Error("Tracing.tracingComplete returned no stream"));
        });
      });
      let handle: string;
      try {
        // Observe both promises together so an end-command failure cannot leave
        // a later timeout rejection unhandled or mask the original assertion.
        [, handle] = await Promise.all([trace.session.send("Tracing.end"), streamReady]);
      } finally {
        clearTimeout(completionTimer);
      }
      await mkdir(dirname(artifact), { recursive: true });
      const file = await open(artifact, "w");
      try {
        let eof = false;
        while (!eof) {
          const chunk = await trace.session.send("IO.read", { handle, size: 1024 * 1024 });
          const bytes = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data);
          if (!bytes.length && !chunk.eof) throw new Error("Tracing IO.read returned an empty nonterminal chunk");
          let offset = 0;
          while (offset < bytes.length) {
            const written = (await file.write(bytes, offset, bytes.length - offset)).bytesWritten;
            if (!written) throw new Error("Trace artifact write made no progress");
            offset += written;
          }
          result.bytes = (result.bytes as number) + bytes.length;
          eof = chunk.eof;
        }
      } finally {
        await file.close();
        await trace.session.send("IO.close", { handle }).catch(() => undefined);
      }
      await testInfo.attach("interrupted-download-chromium-trace.json", { path: artifact, contentType: "application/json" });
    } catch (error) {
      result.error = String(error);
    } finally {
      await trace.session.detach().catch(() => undefined);
      await mkdir(dirname(receipt), { recursive: true });
      await writeFile(receipt, JSON.stringify(result, null, 2)).catch(() => undefined);
      await testInfo.attach("interrupted-download-chromium-trace-receipt.json", { path: receipt, contentType: "application/json" }).catch(() => undefined);
    }
  };

  return {
    async attach(testInfo: TestInfo, name: string) {
      await finishTrace(testInfo);
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
      await writeFile(artifact, JSON.stringify({ browserVersion, platform: process.platform, node: process.version, workerIndex: testInfo.workerIndex, parallelIndex: testInfo.parallelIndex, workerPid: process.pid, events, browserTimeline }, null, 2));
      await testInfo.attach(name, { path: artifact, contentType: "application/json" });
      await cdp.detach().catch(() => undefined);
    },
  };
}
