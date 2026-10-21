import { readFileSync } from "node:fs";
import { assertBrowserAndCategories, readPinnedManifest, observationOnly } from "../../../experiment-gates.mjs";
import { createWorkerConsoleRecorder } from "../../../worker-console-records.mjs";
import { open, writeFile } from "node:fs/promises";
import type { CDPSession, Page, TestInfo } from "@playwright/test";

/** Observation only: no worker mutation, cache operation, or request interception. */
export async function preparePwaEngineTrace(page: Page, pageSession: CDPSession, info: TestInfo, scope="Passive capture of selected installed-app test") {
  const browser = page.context().browser();
  if (!browser) throw new Error("Engine trace requires a Chromium browser connection");
  const session = await browser.newBrowserCDPSession();
  const version = await session.send("Browser.getVersion");
  const inventory = await session.send("Tracing.getCategories");
  const pins = JSON.parse(readFileSync(new URL("../../../RUNTIME-PINS.json", import.meta.url), "utf8"));
  await info.attach("runtime-browser-identity", { body: Buffer.from(JSON.stringify({ version, expected: pins.browser, availableCategories: inventory.categories })), contentType: "application/json" });
  const selected = assertBrowserAndCategories(version, inventory.categories, pins);
  const mode = process.env.IW_PWA_RESPONSE_MODE;
  if (!mode || !["baseline", "blob", "stream"].includes(mode)) throw new Error("Missing reviewed response arm");
  const pair = readPinnedManifest(new URL(`../../../../PWA-F9-WORKER-PARITY-REHEARSAL-1/DERIVED-${mode}-MANIFEST.json`, import.meta.url), pins.variants[mode]);
  const recorder = createWorkerConsoleRecorder({ mode, fileHashes: pair.new.sha256 });
  const receiveConsole = (message: import("@playwright/test").ConsoleMessage) => recorder.receive(message);
  page.context().on("console", receiveConsole); // Before old-worker registration; adds NO attachment or pause.
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
        scope, responseExperimentMode: mode, baselineIsInstrumentedControl: true };
      const errors: string[] = [];
      await observationOnly(async () => {
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
          receipt.complete = end.dataLossOccurred === false; // Missing loss flag is not a valid capture.
          await info.attach("browser-engine-trace", { path, contentType: "application/json" });
        } catch (error) { receipt.error = String(error); receipt.complete = false; }
        finally { if (timer) clearTimeout(timer); }
      } else receipt.complete = false;
      page.context().off("console", receiveConsole);
      const consolePath = info.outputPath("worker-console-records.json");
      await writeFile(consolePath, JSON.stringify(recorder.finish(), null, 2));
      await info.attach("worker-console-records", { path: consolePath, contentType: "application/json" });
      }, async error => { receipt.complete = false; errors.push(String(error)); });
      // Always try detach; finish never throws through the unchanged spec's finally.
      await observationOnly(async () => { await session.detach(); }, async error => { receipt.complete = false; errors.push('detach: '+String(error)); });
      receipt.observationErrors = errors;
      await observationOnly(async () => {
        const receiptPath = info.outputPath("browser-engine-receipt.json");
        await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
        await info.attach("browser-engine-receipt", { path: receiptPath, contentType: "application/json" });
      }, async error => { receipt.complete = false; errors.push('receipt: '+String(error)); });
      if (!receipt.complete || errors.length) {
        await observationOnly(async () => {
          const invalidPath = info.outputPath("ARM-INVALID.json");
          await writeFile(invalidPath, JSON.stringify({ valid: false, reason: "Incomplete or failed observation; original test outcome preserved", receipt, errors }, null, 2));
          await info.attach("ARM-INVALID", { path: invalidPath, contentType: "application/json" });
        }, async () => {}); // Missing evidence is independently invalidated after teardown.
      }
    },
  };
}
