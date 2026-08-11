// Producing a mark's spec-sheet imagery (full page, plus the legacy crop),
// and caching it at three levels.
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
import {
  drawingCropBox,
  inkMaskFromPixels,
  type InkMask,
} from "./drawingRegion";
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

/**
 * How much the page is shrunk before its layout is read.
 *
 * The mask is only used to find blank paper and printed rules, and a tenth of
 * 2600px still resolves a hairline because {@link inkMaskFromPixels} keeps the
 * darkest pixel of every block rather than sampling one. Full resolution would
 * mean six million bytes and a visible pause on a phone.
 */
const MASK_STEP = 10;

const maskCache = new Map<string, InkMask>();

/**
 * The page reduced to paper/rule/ink, computed once per sheet.
 *
 * Worth caching hard: a specs page carries four marks, and every card on it
 * asks the same question of the same pixels.
 */
function getInkMask(key: string, page: HTMLCanvasElement): InkMask | null {
  const cached = maskCache.get(key);
  if (cached) return cached;
  const ctx = page.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { data } = ctx.getImageData(0, 0, page.width, page.height);
  const mask = inkMaskFromPixels(data, page.width, page.height, MASK_STEP);
  maskCache.set(key, mask);
  evict(maskCache, MAX_CACHED_PAGES);
  return mask;
}

/**
 * Where to actually crop, given what the vision pass stored.
 *
 * Usually the stored box, padded, exactly as before — most of them do have the
 * window in them. The sheet's own ink is consulted only to check that, and to
 * rescue the ones that miss: mark #2's box lands on the dimension line BESIDE
 * its window, so the crew saw a black rectangle. See `drawingRegion`. Returns
 * null when there's nothing there worth showing.
 *
 * Falls back to the stored box if the mask can't be built at all (a browser
 * that won't hand back pixels), which is what this did before.
 */
function resolveCropBox(
  page: HTMLCanvasElement,
  pageKey: string,
  bbox: Bbox,
): Bbox | null {
  const mask = getInkMask(pageKey, page);
  if (!mask) return padBbox(bbox);
  return drawingCropBox(mask, bbox);
}

/** Slice the box out of the page and flip it to white-on-black. */
function cropDrawing(page: HTMLCanvasElement, box: Bbox): string {
  const rect = bboxToPixelRect(box, page.width, page.height);
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
 * Bumped whenever the crop's geometry or colouring changes, so crops cached
 * under the old behaviour are never served again. Phones hold these in
 * IndexedDB for weeks, and a crew who already has mark #2's black rectangle
 * saved would otherwise keep seeing it after the fix shipped.
 *
 * "repair3" is the first build in which the repair actually runs in a browser:
 * the check guarding it had been calibrated against a different PDF rasterizer
 * and never once fired, so every phone that has looked at Black Desert is
 * holding mark #2's empty rectangle in IndexedDB. Only two crops across both
 * live jobs actually change, but the marker is per-planset rather than
 * per-crop, so the whole set is re-cut. That costs one page render per sheet on
 * the next visit and is the only way a crew is guaranteed to stop seeing the
 * old picture without being told to clear anything.
 */
const SPEC_VARIANT = "repair3";

/**
 * The crop for one mark, as a PNG data URL, or null when the page has no
 * drawing there to show.
 *
 * Null is a real answer, not an error: some panels on these sheets are blank
 * because the supplier left the drawing out, and this app would rather show
 * nothing than a black rectangle that looks like it's broken. Throws only when
 * the drawing can't be produced at all (no planset offline, an unrenderable
 * page) — a cache failure never surfaces.
 */
export async function markDrawingDataUrl({
  planset,
  pageNumber,
  bbox,
  markCode,
}: CropRequest): Promise<string | null> {
  const key = cropCacheKey({
    plansetId: planset.id,
    markCode,
    bbox,
    scale: PAGE_RENDER_WIDTH,
    variant: SPEC_VARIANT,
  });

  const inMemory = cropCache.get(key);
  if (inMemory) return inMemory;

  const persisted = await readCrop(key);
  if (persisted) {
    cropCache.set(key, persisted);
    evict(cropCache, MAX_CACHED_CROPS);
    return persisted;
  }

  const page = await getPageCanvas(planset, pageNumber);
  const box = resolveCropBox(page, `${planset.id}:${pageNumber}`, bbox);
  if (!box) return null;

  const url = cropDrawing(page, box);
  cropCache.set(key, url);
  evict(cropCache, MAX_CACHED_CROPS);
  // Deliberately not awaited: the picture is ready, and persisting it is a
  // favour to the next page load, not part of showing it.
  void writeCrop(key, url, planset.id);
  return url;
}

/**
 * The WHOLE specs page a mark was read from, inverted to white-on-black, as a
 * PNG data URL. The spec card shows the full sheet and lets the crew navigate
 * it (owner call, 2026-08-10): the sheet in context beats a guessed rectangle,
 * and the neighboring marks on the page are exactly what a crew member uses to
 * confirm they're looking at the right one. Cached like the crops: memory,
 * then IndexedDB, then one page render shared with every crop off that page.
 */
export async function specsPageDataUrl({
  planset,
  pageNumber,
}: {
  planset: Planset;
  pageNumber: number;
}): Promise<string> {
  const key = cropCacheKey({
    plansetId: planset.id,
    markCode: `__page-${pageNumber}__`,
    bbox: [0, 0, 1, 1],
    scale: PAGE_RENDER_WIDTH,
    variant: SPEC_VARIANT,
  });

  const inMemory = cropCache.get(key);
  if (inMemory) return inMemory;

  const persisted = await readCrop(key);
  if (persisted) {
    cropCache.set(key, persisted);
    evict(cropCache, MAX_CACHED_CROPS);
    return persisted;
  }

  const page = await getPageCanvas(planset, pageNumber);
  const url = cropDrawing(page, [0, 0, 1, 1]);
  cropCache.set(key, url);
  evict(cropCache, MAX_CACHED_CROPS);
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
    variant: SPEC_VARIANT,
  });
  if (cropCache.has(key)) return true;
  return (await readCrop(key)) != null;
}

