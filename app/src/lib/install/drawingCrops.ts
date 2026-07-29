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
import { calloutRingCircle } from "./elevationViews";
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

// --- Elevation reference crops -------------------------------------------
//
// The other picture a mark can have: the exterior elevation drawing off the
// BUILDING planset, with the mark's number ringed, so a crew member can see
// which hole in which wall they are about to fill. It shares every cache here —
// the same document, the same rendered page canvas, the same IndexedDB store —
// so a job that has both kinds of drawing still downloads each planset once.

/**
 * Ring color. Kept exactly as it was when these crops were shown on white
 * paper: checked against the inverted drawing on all five Black Desert walls
 * and it still reads at a glance, because it is now surrounded by pure black
 * rather than by white paper and is the only colour left in the picture.
 * Brightening it was available and turned out not to be needed.
 */
const RING_COLOR = "#e11d48";
/** Tells the elevation crops apart from the spec crop of the same box. */
const ELEVATION_VARIANT = "elev-inv1";

export interface ElevationCropRequest {
  /** The BUILDING planset the elevation sheets live on. */
  planset: Planset;
  pageNumber: number;
  /** The drawing region to show, as stored on the elevation-view row. */
  bbox: Bbox;
  markCode: string;
  pin: { x: number; y: number };
  label: { w: number | null; h: number | null };
}

function elevationKey(req: ElevationCropRequest): string {
  return cropCacheKey({
    plansetId: req.planset.id,
    markCode: req.markCode,
    bbox: req.bbox,
    scale: PAGE_RENDER_WIDTH,
    variant: ELEVATION_VARIANT,
  });
}

/**
 * How the building plans are re-coloured: the same grayscale → invert →
 * floor/gain pipeline as the spec drawings ({@link invertLineArt}), so there is
 * one colour transform in the app, but with constants measured for THIS source.
 *
 * The GAIN is the decision that matters. A supplier spec sheet is sparse
 * line-work with little else on it, so 3 is free there. An architectural
 * elevation is mostly broad tone: stone hatching, shingle, glazing fills. At
 * gain 3 those mid-greys are lifted with everything else, and measured over
 * marks #1, #9 and #11 the crop ends up ~50% brighter overall (mean luma 25–27
 * against 17–18) with 2.5× as many blown-out pixels (4.0–4.1% at 250+ against
 * 1.6–1.7%). It is still readable — not a smear — but the tone blocks come up
 * to compete with the line-work, so the drawn openings stop being the brightest
 * thing on the card. 1.6 keeps the hatching as background texture and leaves
 * the openings and callout numbers plainly brightest.
 *
 * The FLOOR barely matters for legibility, contrary to what you might expect:
 * checked at 1:1 on the finest thing on these sheets — the leader text and
 * dimension ticks — the line-work survives identically at 12, 18 and 28. What
 * the floor removes is the faint background tone below it (raising it from 0 to
 * 18 takes the pure-black share of the crop from 76.1% to 81.1%). 18 is chosen
 * as the point where the paper's own scan mottle is gone without discarding the
 * genuine faint tone in the 18–28 band, which is 2.4% of the crop and which
 * these sheets have no watermark reason to throw away.
 *
 * Tuned here rather than in `markDrawing`: its 28/3 was validated against the
 * supplier sheets and their watermark, and is not ours to move.
 */
const ELEVATION_FLOOR = 18;
const ELEVATION_GAIN = 1.6;

/**
 * Crop the drawing region, flip it to white-on-black, and ring the mark.
 *
 * ORDER MATTERS, and is the whole reason the ring is stroked here rather than
 * folded into the crop step: `invertLineArt` runs over the RAW plan pixels
 * first, and the ring goes on top of the finished black image afterwards.
 *
 * Ring an already-inverted image and the ring survives as drawn. Invert an
 * image that is already ringed and the ring is destroyed — and note HOW, because
 * it is not the obvious way: `invertLineArt` reduces every pixel to luma before
 * it inverts, so it has no notion of hue and cannot produce a complement. The
 * ring's #e11d48 has a luma of 92, which inverts to 163, which the gain drives
 * past 255 — so it comes out PURE WHITE, not cyan, and is indistinguishable
 * from the surrounding line-work. Verified by rendering it: 0% of the ring's
 * pixels stay red and the stroke's mean colour is (255,255,255). A silent,
 * invisible marker is worse than a wrong-coloured one, which is why nothing
 * coloured may be drawn on this canvas before the transform runs.
 */
function cropElevation(
  page: HTMLCanvasElement,
  req: ElevationCropRequest,
): string {
  const rect = bboxToPixelRect(req.bbox, page.width, page.height);
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
  invertLineArt(pixels.data, ELEVATION_FLOOR, ELEVATION_GAIN);
  ctx.putImageData(pixels, 0, 0);

  const ring = calloutRingCircle({
    pin: req.pin,
    label: req.label,
    bbox: req.bbox,
    pageWidth: page.width,
    pageHeight: page.height,
  });
  ctx.strokeStyle = RING_COLOR;
  ctx.lineWidth = ring.lineWidth;
  ctx.beginPath();
  ctx.arc(ring.cx, ring.cy, ring.r, 0, Math.PI * 2);
  ctx.stroke();

  return out.toDataURL("image/png");
}

/** One mark's elevation reference as a PNG data URL. Same caching as above. */
export async function elevationCropDataUrl(
  req: ElevationCropRequest,
): Promise<string> {
  const key = elevationKey(req);

  const inMemory = cropCache.get(key);
  if (inMemory) return inMemory;

  const persisted = await readCrop(key);
  if (persisted) {
    cropCache.set(key, persisted);
    evict(cropCache, MAX_CACHED_CROPS);
    return persisted;
  }

  const url = cropElevation(
    await getPageCanvas(req.planset, req.pageNumber),
    req,
  );
  cropCache.set(key, url);
  evict(cropCache, MAX_CACHED_CROPS);
  void writeCrop(key, url, req.planset.id);
  return url;
}

/** True when this elevation crop needs neither the network nor the renderer. */
export async function hasCachedElevationCrop(
  req: ElevationCropRequest,
): Promise<boolean> {
  const key = elevationKey(req);
  if (cropCache.has(key)) return true;
  return (await readCrop(key)) != null;
}
