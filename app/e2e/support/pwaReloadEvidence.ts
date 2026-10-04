import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Passive test evidence; never consumes application receipts or changes takeover. */
export async function capturePwaReloadEvidence(page: Page, context: BrowserContext, chromium: boolean) {
  const key = "wops-e2e-half-download-reload-evidence";
  await page.addInitScript((storageKey) => {
    const note = (event: string, detail: unknown = null) => {
      try {
        const root = document.getElementById("root");
        const receipts: Record<string, string | null> = {};
        for (const name of ["wops-update-reload-diagnostic", "wops-empty-boot-diagnostic", "wops-preload-reloaded-at"])
          receipts[name] = sessionStorage.getItem(name);
        const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
        if (entry) receipts["entryRetry"] = sessionStorage.getItem("wops-empty-boot-retry:" + entry);
        const prior = JSON.parse(sessionStorage.getItem(storageKey) || "[]") as unknown[];
        prior.push({ event, detail, at: Date.now(), timeOrigin: performance.timeOrigin, now: performance.now(),
          url: document.URL, bootStarted: document.documentElement?.dataset.forgeBootStarted ?? null,
          rootChildren: root?.childElementCount ?? null, rootTextLength: root?.textContent?.trim().length ?? null, receipts });
        sessionStorage.setItem(storageKey, JSON.stringify(prior.slice(-160)));
      } catch { /* Evidence must never interfere with application recovery. */ }
    };
    note("document-start");
    for (const event of ["load", "pagehide", "beforeunload", "vite:preloadError"])
      window.addEventListener(event, () => note(event));
    window.addEventListener("error", (event) => {
      const target = event.target;
      note("error", target instanceof HTMLScriptElement ? target.src : target instanceof HTMLLinkElement ? target.href : event.message);
    }, true);
    const observe = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => note("worker-state", { script: worker.scriptURL, state: worker.state }));
    };
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      const worker = navigator.serviceWorker.controller;
      note("controllerchange", { script: worker?.scriptURL ?? null, state: worker?.state ?? null });
      observe(worker);
    });
    void navigator.serviceWorker?.getRegistration().then((registration) => {
      registration?.addEventListener("updatefound", () => {
        note("updatefound", { script: registration.installing?.scriptURL ?? null });
        observe(registration.installing);
      });
    }).catch(() => {});
  }, key);
  const events: unknown[] = [];
  const record = (event: string, data: unknown) => {
    events.push({ event, at: Date.now(), data });
    if (events.length > 1500) events.shift();
  };
  const cdp = chromium ? await context.newCDPSession(page) : null;
  if (cdp) {
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    cdp.on("Network.requestWillBeSent", (e) => record("request", {
      requestId: e.requestId, loaderId: e.loaderId, frameId: e.frameId, timestamp: e.timestamp,
      wallTime: e.wallTime, url: e.request.url, type: e.type, initiator: e.initiator,
    }));
    cdp.on("Network.responseReceived", (e) => record("response", {
      requestId: e.requestId, loaderId: e.loaderId, timestamp: e.timestamp, type: e.type,
      url: e.response.url, status: e.response.status, fromServiceWorker: e.response.fromServiceWorker,
      fromDiskCache: e.response.fromDiskCache, fromPrefetchCache: e.response.fromPrefetchCache,
    }));
    cdp.on("Network.loadingFinished", (e) => record("finished", e));
    cdp.on("Network.loadingFailed", (e) => record("failed", e));
    cdp.on("Page.frameRequestedNavigation", (e) => record("requested-navigation", e));
    cdp.on("Page.frameNavigated", (e) => record("frame-navigation", e));
  }
  return async (info: TestInfo) => {
    const documents = await page.evaluate((storageKey) => JSON.parse(sessionStorage.getItem(storageKey) || "[]"), key)
      .catch((error: unknown) => ({ readError: String(error) }));
    const artifact = info.outputPath("half-download-reload-evidence.json");
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(artifact, JSON.stringify({ documents, browserEvents: events }, null, 2));
    await info.attach("half-download-reload-evidence.json", { path: artifact, contentType: "application/json" });
    await cdp?.detach();
  };
}
