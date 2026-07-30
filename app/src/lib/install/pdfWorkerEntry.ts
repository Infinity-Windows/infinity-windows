/**
 * The pdf.js worker, with our polyfills installed first.
 *
 * A worker is a separate JavaScript context: a polyfill applied on the main
 * thread does nothing inside it. pdf.js inflates Flate streams through
 * `DecompressionStream` and reads the result with `for await (… of stream)`,
 * which WebKit cannot do (see lib/streamAsyncIterator.ts), so on iPhones every
 * page of a planset came back with "Bad uncompressed block length in flate
 * stream" and missing content.
 *
 * Import order is the whole point — these run before pdf.js worker code does.
 * Kept as a wrapper rather than a patched copy of the library so upgrading
 * pdfjs-dist needs no re-patching.
 */
import "../streamAsyncIterator";
import "../mapPolyfill";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
