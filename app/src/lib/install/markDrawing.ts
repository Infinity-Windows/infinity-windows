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
 * 4.5%, and it is bounded on BOTH sides by measurement rather than by taste.
 * The measure is the one PR #133 validated: a crop is correct when it contains
 * its own mark's printed overall dimension and no other mark's, read off the
 * sheet's text layer, which owes nothing to this code or to the vision pass
 * that produced the boxes.
 *
 * The floor. 3.2% was tuned by eye on Smith Residence and left two crops
 * stopping a whisker short of a dimension their own window needs: Black Desert
 * #16 lost its overall width, Smith #19 its overall height. Both come back at
 * 4.5%, taking Black Desert from 35/36 to 36/36 and Smith from 20/24 to 21/24
 * with nothing regressing on either job. Smith holds level from 4.0% to 6.0%,
 * so this is the middle of a plateau and not a value that happens to work.
 *
 * The ceiling, which is the less obvious half. `drawingCropBox` only repairs a
 * crop when the stored box comes out near-blank, and Black Desert #2 — the
 * black rectangle PR #133 shipped to fix — is only repaired because its box
 * scores under `MIN_INK_DENSITY`. Padding drags the neighbouring
 * dimension line into that box: at 4.5% it still scores 4.3–5.6 across every
 * mask step, but by 5.0% it reaches 9.6–10.2 and the repair stops firing, which
 * would silently give mark #2 its black rectangle back. Anything above about
 * 4.8% undoes the previous fix, so do not raise this without re-measuring #2.
 * PURE.
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
 * True when a spec's drawing coordinates can no longer be trusted, because the
 * specs planset they were measured against is GONE from the project.
 *
 * This is the one failure mode worth being strict about. A missing drawing is
 * obvious and harmless — the card shows text only. A drawing cropped from a
 * planset that is no longer there is neither: page 3 of whatever file we fall
 * back to is a real page, the box still lands on a real elevation, and the
 * installer sees a confident picture of the WRONG unit with no way to tell.
 *
 * "Current" is a SET, not one file. A project can hold several specs plansets
 * at once — the supplier's original cut sheet plus an ADDENDUM for units added
 * later — and every one of them is current. Mad Moose, 2026-09-01: a one-page
 * addendum for three added units was uploaded on top of the four-page supplier
 * sheet, treated as a replacement, and marks 4–10 lost the page with their
 * markups on every spec card and on the Maps Interactive wall. An addendum
 * ADDS; only a file the project no longer has makes a drawing stale.
 *
 * A null `planset_id` is treated as UNKNOWN, not stale, so we keep showing it.
 * Every row written before the provenance column existed has a null here —
 * including the live Smith / PV Townhomes drawings that crews are using today —
 * and hiding those would delete working pictures from a job mid-install to guard
 * against a re-upload that may never happen. The same reasoning applies when we
 * don't know which specs plansets the project has: no comparison is possible, so
 * we don't pretend to have made one. PURE.
 */
export function isDrawingStale(
  spec: DrawingProvenance,
  currentSpecsPlansetIds: readonly string[] | null | undefined,
): boolean {
  if (validateBbox(spec.image_bbox) == null) return false;
  const source = spec.planset_id;
  if (!source) return false;
  if (!currentSpecsPlansetIds || currentSpecsPlansetIds.length === 0) return false;
  return !currentSpecsPlansetIds.includes(source);
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
