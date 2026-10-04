import { open, writeFile } from "node:fs/promises";
import type { CDPSession, Page, TestInfo } from "@playwright/test";

/** Observation only: no worker mutation, cache operation, or request interception. */
export async function preparePwaEngineTrace(page: Page, pageSession: CDPSession, info: TestInfo) {
  const browser = page.context().browser();
  if (!browser) throw new Error("Engine trace requires a Chromium browser connection");
  const session = await browser.newBrowserCDPSession();
  const version = await session.send("Browser.getVersion");
  const inventory = await session.send("Tracing.getCategories");
  const selected = inventory.categories.filter(category =>
    /service.?worker|cache.?storage|loading|resource|netlog/i.test(category) ||
    ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing", "toplevel"].includes(category));
  const lifecycle: unknown[] = [];
  pageSession.on("ServiceWorker.workerVersionUpdated", event => lifecycle.push({ event: "versions", at: Date.now(), ...event }));
  pageSession.on("ServiceWorker.workerRegistrationUpdated", event => lifecycle.push({ event: "registrations", at: Date.now(), ...event }));
  pageSession.on("ServiceWorker.workerErrorReported", event => lifecycle.push({ event: "error", at: Date.now(), ...event }));
  await pageSession.send("ServiceWorker.enable");
  let started = false;
  return {
    async start() {
      if (!selected.length) throw new Error("No requested engine trace categories are available");
      await session.send("Tracing.start", { traceConfig: { includedCategories: selected,
        recordMode: "recordUntilFull", traceBufferSizeInKb: 200 * 1024, enableSampling: false },
        transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none" });
      started = true;
    },
    async finish() {
      const receipt: Record<string, unknown> = { version, inventory, selected, started, lifecycle,
        scope: "unchanged control; tracing starts immediately before failed-install stage" };
      if (started) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const completed = new Promise<{ dataLossOccurred: boolean; stream?: string; traceFormat?: string; streamCompression?: string }>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Tracing completion was not received within 20 seconds")), 20_000);
            session.once("Tracing.tracingComplete", resolve);
          });
          await session.send("Tracing.end");
          const end = await completed;
          if (timer) clearTimeout(timer);
          receipt.completion = end;
          if (!end.stream) throw new Error("Tracing completion did not provide a stream");
          const path = info.outputPath("browser-engine-trace.json");
          const file = await open(path, "w");
          let bytes = 0;
          try {
            for (;;) {
              const chunk = await session.send("IO.read", { handle: end.stream, size: 1024 * 1024 });
              const body = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
              await file.writeFile(body); bytes += body.length;
              if (chunk.eof) break;
            }
          } finally { await file.close(); await session.send("IO.close", { handle: end.stream }); }
          receipt.bytes = bytes;
          receipt.complete = !end.dataLossOccurred;
          await info.attach("browser-engine-trace", { path, contentType: "application/json" });
        } catch (error) { receipt.error = String(error); receipt.complete = false; }
        finally { if (timer) clearTimeout(timer); }
      } else receipt.complete = false;
      const receiptPath = info.outputPath("browser-engine-receipt.json");
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
      await info.attach("browser-engine-receipt", { path: receiptPath, contentType: "application/json" });
      await session.detach();
    },
  };
}
