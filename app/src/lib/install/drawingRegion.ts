// Working out WHERE on a specs sheet a mark's elevation drawing actually is.
//
// The box stored on a spec row comes from the Claude vision pass, and it is not
// reliable. On the Black Desert sheet a third of the boxes are a sliver of a
// panel — 8–13% of the page wide where a good one is 42–45% — and at least one
// is offset off the drawing entirely: mark #2's box lands on the dimension line
// BESIDE its window, so the crew saw a black rectangle with `511 (59 ½")` in it
// and no window at all.
//
// The sheet itself is far more trustworthy than the model. These are CAD sheets:
// each mark gets a panel, panels are tiled a few to a page, and the panels are
// separated by wide bands of blank paper. So we let the vision box do the one
// job it is good at — saying roughly WHERE on the page to look — and take the
// actual crop from the page's own ink:
//
//   1. blank out long straight runs (the sheet border, the table rules, the
//      panel dividers) so they can't glue separate panels into one blob;
//   2. cut the page along the full-width/full-height rules into cells, so a
//      crop can never reach across a printed boundary into a neighbour;
//   3. inside that cell, split the ink into blocks separated by blank gutters,
//      and keep the block(s) the vision box points at.
//
// The result is the drawing plus its dimension lines and callouts, trimmed to
// the ink — which is what the good boxes were already doing by luck, and what
// the bad ones missed.
//
// This is deliberately NOT a hard-coded 2×2 grid. Nothing here assumes how many
// panels a page has, or that a page has panels at all: a sheet with one big
// drawing yields one block and the crop is that drawing. The one assumption is
// that separate drawings on a sheet are separated by blank paper, which is what
// makes a drawing sheet readable to a human in the first place.
//
// Everything here is PURE — no DOM, no pdf.js. The canvas work lives in
// `drawingCrops`.

import type { Bbox } from "./markDrawing";

/**
 * A 1-bit "is there ink here" picture of a rendered page, row-major, one byte
 * per sample. Sampled down from the page canvas — this is layout analysis, and
 * a tenth of the resolution is plenty for finding blank paper.
 */
export interface InkMask {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Luma below this counts as ink. The sheets carry a pale printed watermark and
 * pale grey table rules that both land in the 200–235 band; taking only what is
 * darker than 200 keeps genuine line-work (which is near-black) and ignores
 * both. Matches the "paper background" band that `invertLineArt` crushes.
 */
const INK_LEVEL = 200;

/** A straight ink run at least this long (fraction of the page) is structure. */
const RUN_FRAC = 0.3;
/** A row/column at least this inky right across the page is a printed rule. */
const RULE_FRAC = 0.3;
/** Blank band (fraction of the page) that separates one drawing from the next. */
const GUTTER = 0.022;
/** Ink blocks thinner than this are hairlines — a stray rule, not a drawing. */
const MIN_BLOCK = 0.006;
/** …as is a block holding a negligible share of the region's ink. */
const MIN_BLOCK_INK = 0.05;
/** Breathing room around the finished crop. */
const REGION_PAD = 0.01;

/**
 * Ink density under which a crop is not worth showing. A correct crop of a
 * window elevation is line-work on paper — sparse, but nowhere near empty.
 * Mark #2's broken crop measured 0.003; the same panel resolved properly
 * measures 0.010, and a typical good one 0.02–0.04.
 */
export const MIN_INK_COVERAGE = 0.005;

/**
 * Build an {@link InkMask} from a page canvas's RGBA pixels, shrinking by
 * `step` in each direction.
 *
 * Each output sample takes the DARKEST source pixel in its block, not the
 * middle one. That matters more than it sounds: the lines that define a panel —
 * the sheet border, the rule under each spec table — are one pixel wide, and
 * plain subsampling drops them at random, which turns two panels into one blob
 * and hands a crew the wrong window. Taking the darkest pixel keeps every
 * hairline at any shrink factor. PURE.
 */
export function inkMaskFromPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  step = 1,
): InkMask {
  const s = Math.max(1, Math.floor(step));
  const w = Math.max(1, Math.floor(width / s));
  const h = Math.max(1, Math.floor(height / s));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let darkest = 255;
      for (let dy = 0; dy < s; dy++) {
        const sy = y * s + dy;
        if (sy >= height) break;
        const row = sy * width;
        for (let dx = 0; dx < s; dx++) {
          const sx = x * s + dx;
          if (sx >= width) break;
          const i = (row + sx) * 4;
          const luma =
            0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          if (luma < darkest) darkest = luma;
        }
      }
      data[y * w + x] = darkest < INK_LEVEL ? 1 : 0;
    }
  }
  return { data, width: w, height: h };
}

/** Fraction of `box` that is ink. PURE. */
export function inkCoverage(mask: InkMask, box: Bbox): number {
  const { width: w, height: h } = mask;
  const x0 = clampIndex(Math.floor(box[0] * w), w);
  const y0 = clampIndex(Math.floor(box[1] * h), h);
  const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil(box[2] * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil(box[3] * h)));
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) ink += mask.data[row + x];
  }
  return ink / ((x1 - x0) * (y1 - y0));
}

function clampIndex(v: number, n: number): number {
  return Math.min(n - 1, Math.max(0, v));
}

/**
 * A copy of `mask` with long straight runs removed.
 *
 * The sheet border, the spec-table rules and the divider between two panels are
 * all single long strokes, and any one of them will bridge the blank gutter
 * between two marks and make the whole sheet look like one drawing. Removing
 * them costs nothing: a window elevation is a rectangle, so knocking out its
 * long vertical sides leaves the short top and bottom, and the block's extent
 * is unchanged. PURE.
 */
export function stripLongRuns(mask: InkMask): InkMask {
  const { width: w, height: h, data } = mask;
  const out = Uint8Array.from(data);
  const maxH = Math.round(RUN_FRAC * w);
  const maxV = Math.round(RUN_FRAC * h);

  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const ink = x < w && data[y * w + x] === 1;
      if (ink && start < 0) start = x;
      if (!ink && start >= 0) {
        if (x - start >= maxH) out.fill(0, y * w + start, y * w + x);
        start = -1;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const ink = y < h && data[y * w + x] === 1;
      if (ink && start < 0) start = y;
      if (!ink && start >= 0) {
        if (y - start >= maxV) for (let k = start; k < y; k++) out[k * w + x] = 0;
        start = -1;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Normalized positions of the printed rules that run right across the page —
 * the sheet border, and the full-width lines under each row of spec tables.
 * These are the only lines allowed to bound a crop. PURE.
 */
export function pageRules(mask: InkMask): { rows: number[]; cols: number[] } {
  const { width: w, height: h, data } = mask;
  const rowInk = new Float64Array(h);
  const colInk = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
        rowInk[y] += 1;
        colInk[x] += 1;
      }
    }
  }
  return {
    rows: ruleCenters(rowInk, w, h),
    cols: ruleCenters(colInk, h, w),
  };
}

function ruleCenters(ink: Float64Array, span: number, n: number): number[] {
  const out: number[] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const isRule = i < n && ink[i] / span >= RULE_FRAC;
    if (isRule && start < 0) start = i;
    if (!isRule && start >= 0) {
      out.push((start + i) / 2 / n);
      start = -1;
    }
  }
  return out;
}

/** The region between the page rules that straddle `bbox`'s centre. PURE. */
export function cellFor(bbox: Bbox, rules: { rows: number[]; cols: number[] }): Bbox {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const below = (vals: number[], v: number) =>
    vals.reduce((acc, r) => (r <= v && r > acc ? r : acc), 0);
  const above = (vals: number[], v: number) =>
    vals.reduce((acc, r) => (r > v && r < acc ? r : acc), 1);
  return [
    below(rules.cols, cx),
    below(rules.rows, cy),
    above(rules.cols, cx),
    above(rules.rows, cy),
  ];
}

interface Block {
  start: number;
  end: number;
  ink: number;
}

/** Split a 1-D ink profile into blocks separated by blank runs >= `gutter`. */
function splitBlocks(profile: Float64Array, gutter: number): Block[] {
  const out: Block[] = [];
  let start = -1;
  let blank = 0;
  let ink = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > 0) {
      if (start < 0) start = i;
      blank = 0;
      ink += profile[i];
    } else if (start >= 0) {
      blank += 1;
      if (blank >= gutter) {
        out.push({ start, end: i - blank + 1, ink });
        start = -1;
        blank = 0;
        ink = 0;
      }
    }
  }
  if (start >= 0) out.push({ start, end: profile.length - blank, ink });
  return out;
}

/**
 * Which blocks the vision box is pointing at.
 *
 * A box that genuinely covers a block keeps it — that's the case where the
 * model got it right and we must not shrink its crop. A box that clips a block
 * without covering it keeps only the block it clips most. A box that lands on
 * blank paper (mark #2) keeps the nearest block, because being beside the
 * drawing is the failure we are here to fix.
 */
function pickBlocks(blocks: Block[], lo: number, hi: number): [number, number] | null {
  const total = blocks.reduce((sum, b) => sum + b.ink, 0);
  const real = blocks.filter(
    (b) => b.end - b.start >= 1 && (total === 0 || b.ink / total >= MIN_BLOCK_INK),
  );
  const usable = real.length > 0 ? real : blocks;
  if (usable.length === 0) return null;

  const covered = usable.filter((b) => {
    const overlap = Math.min(b.end, hi) - Math.max(b.start, lo);
    return overlap > 0 && overlap >= 0.5 * (b.end - b.start);
  });
  let best: Block | null = null;
  let bestOverlap = 0;
  for (const b of usable) {
    const overlap = Math.min(b.end, hi) - Math.max(b.start, lo);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = b;
    }
  }

  const keep = best && !covered.includes(best) ? [...covered, best] : covered;
  if (keep.length > 0) {
    return [Math.min(...keep.map((b) => b.start)), Math.max(...keep.map((b) => b.end))];
  }
  const centre = (lo + hi) / 2;
  const nearest = usable.reduce((a, b) =>
    distanceTo(b, centre) < distanceTo(a, centre) ? b : a,
  );
  return [nearest.start, nearest.end];
}

function distanceTo(b: Block, at: number): number {
  if (at < b.start) return b.start - at;
  if (at > b.end) return at - b.end;
  return 0;
}

function profileX(mask: InkMask, x0: number, x1: number, y0: number, y1: number): Float64Array {
  const p = new Float64Array(x1 - x0);
  for (let y = y0; y < y1; y++) {
    const row = y * mask.width;
    for (let x = x0; x < x1; x++) p[x - x0] += mask.data[row + x];
  }
  return p;
}

function profileY(mask: InkMask, x0: number, x1: number, y0: number, y1: number): Float64Array {
  const p = new Float64Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    const row = y * mask.width;
    let sum = 0;
    for (let x = x0; x < x1; x++) sum += mask.data[row + x];
    p[y - y0] = sum;
  }
  return p;
}

/**
 * Turn a stored vision box into the region actually worth cropping, or null
 * when the page has nothing there to show.
 *
 * `structure` is {@link stripLongRuns} of `mask`; it's a parameter so a page
 * with a dozen marks on it strips once instead of a dozen times. PURE.
 */
export function resolveDrawingRegion(
  mask: InkMask,
  bbox: Bbox,
  structure: InkMask = stripLongRuns(mask),
): Bbox | null {
  const { width: w, height: h } = mask;
  const cell = cellFor(bbox, pageRules(mask));
  // Step inside the bounding rules themselves.
  const inset = Math.max(2, Math.round(0.004 * w));
  const cx0 = clampIndex(Math.round(cell[0] * w) + inset, w);
  const cy0 = clampIndex(Math.round(cell[1] * h) + inset, h);
  const cx1 = Math.max(cx0 + 1, Math.min(w, Math.round(cell[2] * w) - inset));
  const cy1 = Math.max(cy0 + 1, Math.min(h, Math.round(cell[3] * h) - inset));
  if (cx1 - cx0 < 8 || cy1 - cy0 < 8) return null;

  const gx = Math.max(3, Math.round(GUTTER * w));
  const gy = Math.max(3, Math.round(GUTTER * h));
  const minW = Math.max(2, Math.round(MIN_BLOCK * w));
  const minH = Math.max(2, Math.round(MIN_BLOCK * h));

  // Bands first, then columns. On these sheets a row of panels shares one strip
  // of drawings and one strip of spec tables, and the tables run edge to edge —
  // so looking for a vertical gap before dropping the table band finds nothing
  // and the crop swallows the whole row, neighbours included.
  const rows = splitBlocks(profileY(structure, cx0, cx1, cy0, cy1), gy).filter(
    (b) => b.end - b.start >= minH,
  );
  const yr = pickBlocks(rows, Math.round(bbox[1] * h) - cy0, Math.round(bbox[3] * h) - cy0);
  if (!yr) return null;

  const cols = splitBlocks(
    profileX(structure, cx0, cx1, cy0 + yr[0], cy0 + yr[1]),
    gx,
  ).filter((b) => b.end - b.start >= minW);
  const xr = pickBlocks(cols, Math.round(bbox[0] * w) - cx0, Math.round(bbox[2] * w) - cx0);
  if (!xr) return null;

  // One more pass down, now that we know which column we're keeping: the
  // neighbour's drawing may be taller than ours and would stretch the crop.
  const rows2 = splitBlocks(
    profileY(structure, cx0 + xr[0], cx0 + xr[1], cy0 + yr[0], cy0 + yr[1]),
    gy,
  ).filter((b) => b.end - b.start >= minH);
  const yr2 = pickBlocks(rows2, 0, yr[1] - yr[0]);

  const top = cy0 + yr[0] + (yr2 ? yr2[0] : 0);
  const bottom = cy0 + yr[0] + (yr2 ? yr2[1] : yr[1] - yr[0]);
  const region: Bbox = [
    Math.max(0, (cx0 + xr[0]) / w - REGION_PAD),
    Math.max(0, top / h - REGION_PAD),
    Math.min(1, (cx0 + xr[1]) / w + REGION_PAD),
    Math.min(1, bottom / h + REGION_PAD),
  ];
  if (region[2] <= region[0] || region[3] <= region[1]) return null;
  return region;
}

/**
 * The box to actually crop for a mark, or null to show no drawing at all.
 *
 * Returning null is a real answer, not a failure. Some panels on these sheets
 * are genuinely blank — the supplier left mark #25's drawing out — and this
 * codebase would rather show nothing than a black rectangle that looks like a
 * broken app. PURE.
 */
export function drawingCropBox(mask: InkMask, bbox: Bbox): Bbox | null {
  const region = resolveDrawingRegion(mask, bbox);
  if (!region) return null;
  if (inkCoverage(mask, region) < MIN_INK_COVERAGE) return null;
  return region;
}
