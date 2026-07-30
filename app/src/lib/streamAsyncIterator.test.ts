import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStreamAsyncIteratorPolyfill } from "./streamAsyncIterator";

const proto = ReadableStream.prototype as unknown as Record<
  string | symbol,
  unknown
>;

function stream(...chunks: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("ReadableStream async-iteration polyfill", () => {
  let original: unknown;
  let originalValues: unknown;

  beforeEach(() => {
    original = proto[Symbol.asyncIterator];
    originalValues = proto.values;
  });

  afterEach(() => {
    if (original === undefined) delete proto[Symbol.asyncIterator];
    else proto[Symbol.asyncIterator] = original;
    if (originalValues === undefined) delete proto.values;
    else proto.values = originalValues;
  });

  /**
   * The bug this file exists for: WebKit ships no
   * `ReadableStream.prototype[Symbol.asyncIterator]`, so pdf.js's
   * `for await (… of stream)` threw before its first iteration and every screen
   * that reads a planset died. Deleting it here IS the WebKit condition.
   */
  it("restores for-await over a stream when the engine lacks it", async () => {
    delete proto[Symbol.asyncIterator];
    delete proto.values;
    expect(proto[Symbol.asyncIterator]).toBeUndefined();

    await expect(
      (async () => {
        const seen: unknown[] = [];
        for await (const chunk of stream("a")) seen.push(chunk);
        return seen;
      })(),
    ).rejects.toThrow(TypeError);

    installStreamAsyncIteratorPolyfill();

    const seen: unknown[] = [];
    for await (const chunk of stream("a", "b", "c")) seen.push(chunk);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("yields nothing for an empty stream and still completes", async () => {
    delete proto[Symbol.asyncIterator];
    installStreamAsyncIteratorPolyfill();
    const seen: unknown[] = [];
    for await (const chunk of stream()) seen.push(chunk);
    expect(seen).toEqual([]);
  });

  it("propagates a stream error to the loop", async () => {
    delete proto[Symbol.asyncIterator];
    installStreamAsyncIteratorPolyfill();
    const failing = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    await expect(
      (async () => {
        for await (const _ of failing) void _;
      })(),
    ).rejects.toThrow("stream broke");
  });

  it("cancels the stream when the loop breaks early", async () => {
    delete proto[Symbol.asyncIterator];
    installStreamAsyncIteratorPolyfill();
    let cancelled = false;
    const s = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const chunk of s) {
      expect(chunk).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("leaves a native implementation alone", () => {
    const native = () => "native";
    proto[Symbol.asyncIterator] = native;
    installStreamAsyncIteratorPolyfill();
    expect(proto[Symbol.asyncIterator]).toBe(native);
  });
});

/**
 * A polyfill on the main thread does nothing inside a worker, which is its own
 * JavaScript context. pdf.js runs Flate decompression in the worker over the
 * same kind of stream loop, so the worker entry must install the shim before it
 * loads the library — and the ORDER is what makes it work. Asserting the wiring
 * here means deleting either import, or reordering them, fails the suite rather
 * than quietly shipping a half-fixed iPhone.
 */
describe("pdf.js worker entry", () => {
  const source = readFileSync(
    join(import.meta.dirname, "install", "pdfWorkerEntry.ts"),
    "utf8",
  );

  it("installs the stream polyfill before loading the pdf.js worker", () => {
    const polyfill = source.indexOf("streamAsyncIterator");
    const worker = source.indexOf("pdf.worker");
    expect(polyfill).toBeGreaterThan(-1);
    expect(worker).toBeGreaterThan(-1);
    expect(polyfill).toBeLessThan(worker);
  });

  it("is what pdf.ts points the worker at, so the polyfilled copy is used", () => {
    const pdf = readFileSync(join(import.meta.dirname, "install", "pdf.ts"), "utf8");
    expect(pdf).toContain("./pdfWorkerEntry?worker&url");
    // The bare library worker would skip the polyfill entirely.
    expect(pdf).not.toContain("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  });

  it("installs the stream polyfill before pdf.js on the main thread too", () => {
    const pdf = readFileSync(join(import.meta.dirname, "install", "pdf.ts"), "utf8");
    expect(pdf.indexOf("../streamAsyncIterator")).toBeLessThan(
      pdf.indexOf("pdfjs-dist/legacy/build/pdf.mjs"),
    );
  });
});
