// Pure geometry + pixel math for showing a mark's ELEVATION DRAWING.
//
// The specs planset draws an "Outside View" elevation for every mark above its
// spec table. Claude VISION returns a normalized bounding box for that drawing
// while it transcribes the sheet; the app crops the rendered PDF page to that
// box and re-colors it so the black-on-white shop drawing reads as white
// line-work on a black card.
//
// Everything here is PURE — no DOM, no network, no pdf.js. The component that
// owns the canvas calls these; the rules below are the ones that were validated
// against the real Smith / PV Townhomes sheet, so they're unit-tested here
// rather than buried in a React effect.

/** Normalized `[x0,y0,x1,y1]`, 0..1, origin TOP-LEFT of the rendered page. */
export type Bbox = [number, number, number, number];

/**
 * A box covering nearly the whole page is the model shrugging ("the drawing is
 * … the sheet"), and a speck is a stray tick mark it mistook for an elevation.
 * Neither crops to anything a crew can use, so both are rejected.
 */
const MAX_BBOX_AREA = 0.9;
const MIN_BBOX_AREA = 0.002;

/**
 * Coerce an untrusted bbox (LLM output or a jsonb column) into a {@link Bbox},
 * or null when it isn't usable. A bad box must never break the mark — the spec
 * card just shows text only — so this never throws.
 *
 * Valid means: exactly four finite numbers, each within 0..1, positive width
 * and height (x1 > x0, y1 > y0), and an area that's neither the whole page nor
 * a speck.
 */
export function validateBbox(raw: unknown): Bbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;

  const nums = raw.map((v) => (typeof v === "number" ? v : Number(v)));
  if (!nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null;

  const [x0, y0, x1, y1] = nums as Bbox;
  if (x1 <= x0 || y1 <= y0) return null;

  const area = (x1 - x0) * (y1 - y0);
  if (area > MAX_BBOX_AREA || area < MIN_BBOX_AREA) return null;

  return [x0, y0, x1, y1];
}

/**
 * Grow a bbox by `pad` (a fraction of the page) on every side, clamped to the
 * page. The model's boxes hug the glass and clip the dimension lines, leader
 * text, and the "Outside View" caption underneath — the very things an
 * installer checks — so a small uniform margin is always added.
 *
 * PLACEHOLDER VALUE WHILE THE MEASUREMENT RUNS — do not merge on this commit.
 * 3.2% was tuned by eye on the Smith Residence sheet and left Black Desert's
 * mark #16 stopping just short of its own printed overall width. 4.5% recovers
 * #16, but the number has to be shown safe on Smith before it can ship; this
 * commit exists so the work is visible, and it will either gain that evidence
 * or be reverted. PURE.
 */
export function padBbox(bbox: Bbox, pad = 0.045): Bbox {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return [
    clamp(bbox[0] - pad),
    clamp(bbox[1] - pad),
    clamp(bbox[2] + pad),
    clamp(bbox[3] + pad),
  ];
}

/** The provenance fields a staleness check needs off a spec row. */
export interface DrawingProvenance {
  /** Normalized box locating the drawing, or null/absent when there isn't one. */
  image_bbox?: unknown;
  /** Specs planset the box was measured against; null when unknown/legacy. */
  planset_id?: string | null;
}

/**
 * True when a spec's drawing coordinates can no longer be trusted, because they
 * were measured against a DIFFERENT specs planset than the one the project has
 * now.
 *
 * This is the one failure mode worth being strict about. A missing drawing is
 * obvious and harmless — the card shows text only. A drawing cropped from a
 * replaced planset is neither: page 3 of the new upload is a real page, the box
 * still lands on a real elevation, and the installer sees a confident picture of
 * the WRONG unit with no way to tell.
 *
 * A null `planset_id` is treated as UNKNOWN, not stale, so we keep showing it.
 * Every row written before the provenance column existed has a null here —
 * including the live Smith / PV Townhomes drawings that crews are using today —
 * and hiding those would delete working pictures from a job mid-install to guard
 * against a re-upload that may never happen. The same reasoning applies when we
 * don't know the project's current specs planset: no comparison is possible, so
 * we don't pretend to have made one. PURE.
 */
export function isDrawingStale(
  spec: DrawingProvenance,
  currentSpecsPlansetId: string | null | undefined,
): boolean {
  if (validateBbox(spec.image_bbox) == null) return false;
  const source = spec.planset_id;
  if (!source) return false;
  if (!currentSpecsPlansetId) return false;
  return source !== currentSpecsPlansetId;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Project a normalized bbox onto a rendered page of `pageWidth` × `pageHeight`
 * pixels. Coordinates are rounded to whole pixels (canvas wants integers) and
 * the result is always at least 1×1 and always inside the page, so a degenerate
 * box can't produce a zero-sized canvas. PURE.
 */
export function bboxToPixelRect(
  bbox: Bbox,
  pageWidth: number,
  pageHeight: number,
): PixelRect {
  const w = Math.max(1, Math.floor(pageWidth));
  const h = Math.max(1, Math.floor(pageHeight));

  const x = Math.min(w - 1, Math.max(0, Math.round(bbox[0] * w)));
  const y = Math.min(h - 1, Math.max(0, Math.round(bbox[1] * h)));
  const width = Math.max(1, Math.min(Math.round((bbox[2] - bbox[0]) * w), w - x));
  const height = Math.max(1, Math.min(Math.round((bbox[3] - bbox[1]) * h), h - y));

  return { x, y, width, height };
}

/**
 * Turn a cropped black-on-white shop drawing into white line-work on black, in
 * place, over RGBA pixel data.
 *
 * Grayscale → invert → `v < floor ? 0 : min(255, v * gain)`. The floor and gain
 * come from measuring the histogram of the real sheet after inverting:
 *   • the paper background lands at 0–15 — already black, leave it;
 *   • the supplier's "Strata" WATERMARK arc sits at 14 for three quarters of its
 *     pixels, but its edge runs up to about 27 — the floor crushes it to pure
 *     black, otherwise it sweeps across the drawing as a thick grey band;
 *   • genuine but faint line-work (thin leaders, anti-aliased edges, hatching)
 *     has a median of 46 and runs to about 90 — the gain lifts it to a readable
 *     138 and above.
 * A plain threshold would erase that third band along with the watermark, which
 * is why this is a floor plus a gain rather than a cutoff.
 *
 * The floor was 25, which left the watermark's edge alive: measured over two
 * pages of the Black Desert sheet, 13–15% of its pixels survived and the arc was
 * plainly visible behind a third of the drawings. 28 clears its edge — survivors
 * fall to 2–4% and the arc disappears — and costs 1.6 percentage points more of
 * the faintest anti-aliasing, which is invisible: mark #2's crop, the thinnest
 * line-work on the job, is pixel-for-pixel as legible at 28 as at 25. Going
 * further to 32 buys almost no more watermark and throws away six points more
 * line-work, so this stops at 28.
 *
 * Alpha is left untouched. PURE in the sense that matters: deterministic, and
 * the only thing it touches is the array it was handed.
 */
export function invertLineArt(
  data: Uint8ClampedArray,
  floor = 28,
  gain = 3,
): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    // Rec. 601 luma — the standard weighting, and what the eye reads as "how
    // dark is this ink".
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const inverted = 255 - luma;
    const v =
      inverted < floor ? 0 : Math.min(255, Math.round(inverted * gain));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}
