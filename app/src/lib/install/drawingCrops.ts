// Producing one mark's elevation-drawing crop, and caching it at three levels.
//
// Nothing about a mark's drawing is stored as an image: the spec row only
// remembers which page of the specs planset it's on and where on that page it
// sits. Turning that into a picture means downloading the planset (~2.2MB on the
// Smith job), rendering the page at print resolution, slicing the padded box out
// and inverting it to white-on-black.
//
// That's expensive exactly once. The caches, cheapest first:
//   1. in-memory crops — instant, but gone on reload;
//   2. IndexedDB crops (`cropCache`) — survive reloads and going offline, so a
//      phone never re-downloads a whole planset to redraw one small picture;
//   3. in-memory page canvases + PDF documents — so a sheet with a dozen marks
//      renders the page ONCE and every card slices the same canvas.
//
// Lives outside the component so the background prefetch can warm exactly the
// same crops the cards will ask for. The pure geometry and pixel math stay in
// `markDrawing`.

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { downloadPlanset } from "./api";
import { cropCacheKey, readCrop, writeCrop } from "./cropCache";
import { bboxToPixelRect, invertLineArt, padBbox, type Bbox } from "./markDrawing";
import type { Planset } from "./types";

/**
 * Width the specs page is rasterized to. Big enough that one mark's slice
 * (roughly a tenth of the sheet) still reads when a crew member zooms it
 * full-screen, small enough that a single cached page canvas stays sane.
 */
export const PAGE_RENDER_WIDTH = 2600;

/** Only ever hold a couple of pages/documents — these canvases are megabytes. */
const MAX_CACHED_DOCS = 2;
const MAX_CACHED_PAGES = 2;
/** Crops are small PNG data URLs; keep plenty so scrolling back is free. */
const MAX_CACHED_CROPS = 150;

const docCache = new Map<string, Promise<PDFDocumentProxy>>();
const pageCache = new Map<string, Promise<HTMLCanvasElement>>();
const cropCache = new Map<string, string>();

/** Drop oldest-inserted entries until the cache is back under `max`. */
function evict(cache: Map<string, unknown>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

async function getDoc(planset: Planset): Promise<PDFDocumentProxy> {
  const cached = docCache.get(planset.id);
  if (cached) return cached;

  const pending = (async () => {
    // Dynamic, like the planset viewer: pdf.js is a large dependency and must
    // stay out of the app shell.
    const { loadPdf } = await import("./pdf");
    return loadPdf(await downloadPlanset(planset));
  })();
  docCache.set(planset.id, pending);
  pending.catch(() => docCache.delete(planset.id));
  evict(docCache, MAX_CACHED_DOCS);
  return pending;
}

/** Render (once) the specs page every mark on that page will be sliced from. */
async function getPageCanvas(
  planset: Planset,
  pageNumber: number,
): Promise<HTMLCanvasElement> {
  const key = `${planset.id}:${pageNumber}:${PAGE_RENDER_WIDTH}`;
  const cached = pageCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const { renderPageCanvas } = await import("./pdf");
    return renderPageCanvas(await getDoc(planset), pageNumber, PAGE_RENDER_WIDTH);
  })();
  pageCache.set(key, pending);
  pending.catch(() => pageCache.delete(key));
  evict(pageCache, MAX_CACHED_PAGES);
  return pending;
}

/** Slice the padded box out of the page and flip it to white-on-black. */
function cropDrawing(page: HTMLCanvasElement, bbox: Bbox): string {
  const rect = bboxToPixelRect(padBbox(bbox), page.width, page.height);
  const out = document.createElement("canvas");
  out.width = rect.width;
  out.height = rect.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");

  ctx.drawImage(
    page,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );
  const pixels = ctx.getImageData(0, 0, rect.width, rect.height);
  invertLineArt(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  return out.toDataURL("image/png");
}

export interface CropRequest {
  planset: Planset;
  /** 1-based page of the specs planset the drawing is on. */
  pageNumber: number;
  bbox: Bbox;
  markCode: string;
}

/**
 * The crop for one mark, as a PNG data URL. Checks memory, then IndexedDB, then
 * does the work. Throws only when the drawing genuinely can't be produced (no
 * planset offline, an unrenderable page, a browser that won't hand back pixels)
 * — a cache failure never surfaces.
 */
export async function markDrawingDataUrl({
  planset,
  pageNumber,
  bbox,
  markCode,
}: CropRequest): Promise<string> {
  const key = cropCacheKey({
    plansetId: planset.id,
    markCode,
    bbox,
    scale: PAGE_RENDER_WIDTH,
  });

  const inMemory = cropCache.get(key);
  if (inMemory) return inMemory;

  const persisted = await readCrop(key);
  if (persisted) {
    cropCache.set(key, persisted);
    evict(cropCache, MAX_CACHED_CROPS);
    return persisted;
  }

  const url = cropDrawing(await getPageCanvas(planset, pageNumber), bbox);
  cropCache.set(key, url);
  evict(cropCache, MAX_CACHED_CROPS);
  // Deliberately not awaited: the picture is ready, and persisting it is a
  // favour to the next page load, not part of showing it.
  void writeCrop(key, url, planset.id);
  return url;
}

/**
 * True when this crop is already available without touching the network or the
 * renderer. Used by the prefetcher to skip work it doesn't need to do.
 */
export async function hasCachedCrop(req: CropRequest): Promise<boolean> {
  const key = cropCacheKey({
    plansetId: req.planset.id,
    markCode: req.markCode,
    bbox: req.bbox,
    scale: PAGE_RENDER_WIDTH,
  });
  if (cropCache.has(key)) return true;
  return (await readCrop(key)) != null;
}
