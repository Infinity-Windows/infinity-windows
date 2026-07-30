/**
 * Async iteration over a ReadableStream — `for await (const chunk of stream)`.
 *
 * Every engine but WebKit implements this. Safari/iOS does not, at any version
 * shipped to date, so `stream[Symbol.asyncIterator]` is `undefined` there and
 * the loop throws `TypeError: undefined is not a function` before its first
 * iteration. Minified, the loop reads `for await (let e of t)`, which is why
 * Safari quoted "near '...e of t...'" on the crew's phones.
 *
 * pdf.js 6 relies on it in two places, one per JavaScript context:
 *   - main thread: `PDFPageProxy.getTextContent()` collects `streamTextContent()`
 *   - worker: inflating a Flate stream through `DecompressionStream`
 * So this has to be installed in BOTH contexts — see install/pdfWorkerEntry.ts
 * for the worker side. On the main thread the throw broke every screen that
 * reads text off a planset; in the worker it degraded to "Bad uncompressed
 * block length in flate stream" warnings and missing page content.
 *
 * Kept free of any DOM reference so the same module loads inside a worker.
 */

type AsyncIterableStream = {
  values?: unknown;
  [Symbol.asyncIterator]?: unknown;
};

export function installStreamAsyncIteratorPolyfill(): void {
  const Ctor = (globalThis as { ReadableStream?: typeof ReadableStream }).ReadableStream;
  if (typeof Ctor !== "function") return;

  const proto = Ctor.prototype as unknown as AsyncIterableStream;
  if (typeof proto[Symbol.asyncIterator] === "function") return;

  // Mirrors the streams spec's ReadableStream.prototype.values: one reader for
  // the whole loop, released when it ends, and `break`/`throw` cancels the
  // stream unless the caller opted out with `preventCancel`.
  function values(
    this: ReadableStream<unknown>,
    { preventCancel = false }: { preventCancel?: boolean } = {},
  ) {
    const reader = this.getReader();
    return {
      async next(): Promise<IteratorResult<unknown>> {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result.done
            ? { done: true, value: undefined }
            : { done: false, value: result.value };
        } catch (err) {
          reader.releaseLock();
          throw err;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<unknown>> {
        if (preventCancel) {
          reader.releaseLock();
          return { done: true, value };
        }
        const cancelled = reader.cancel(value);
        reader.releaseLock();
        await cancelled;
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  const descriptor = { value: values, writable: true, configurable: true };
  if (typeof proto.values !== "function") {
    Object.defineProperty(proto, "values", descriptor);
  }
  Object.defineProperty(proto, Symbol.asyncIterator, descriptor);
}

installStreamAsyncIteratorPolyfill();
