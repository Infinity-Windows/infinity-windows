// Working out WHERE on a specs sheet a mark's elevation drawing actually is.
//
// The box stored on a spec row comes from the Claude vision pass, and it is not
// reliable. On the Black Desert sheet a third of the boxes are a sliver of a
// panel — 8–13% of the page wide where a good one is 42–45% — and some are
// offset off the drawing entirely: mark #2's box lands on the dimension line
// BESIDE its window, so the crew saw a black rectangle with `511 (59 ½")` in it
// and no window at all.
//
// Most of those boxes are nonetheless fine. Measured against the dimensions the
// supplier prints on the sheet, 32 of Black Desert's 36 crops already had the
// whole window in them: a box only a tenth of the page wide is not necessarily
// wrong, because these elevations are drawn small — a 107" wide unit occupies
// about three inches of paper. So the job here is NARROW. Find the crops that
// are actually broken, and repair only those:
//
//   1. score the stored box's own crop for line-work ({@link inkDensity}). If
//      there is a drawing in it, use it and stop — no cleverness required;
//   2. otherwise the box has missed. Find the printed rules that run right
//      across the sheet and cut the page into cells along them, so a repair can
//      never reach across a printed boundary;
//   3. inside that cell, grow out from the nearest ink until the paper goes
//      blank, then trim to the ink and add a small margin;
//   4. refuse the result if it reached over another mark's box — two windows in
//      one picture is worse than no picture.
//
// The restraint in step 1 is the important part, and it was learned by getting
// it wrong: an earlier version of this file derived EVERY crop from the geometry
// below. It fixed mark #2 and broke eleven other marks on the same job, four of
// them by showing the crew the neighbouring window. Growing a region out to
// blank paper is a good way to find a drawing when you have nothing better; it
// is a bad way to second-guess a box that already works.
//
// Nothing here assumes a 2x2 grid, or how many panels a page has, or that a page
// has panels at all. The assumptions are only that separate drawings on a sheet
// are separated by blank paper and that printed rules are longer than anything
// drawn inside a panel — which is what makes a drawing sheet readable to a human
// in the first place. Those hold for this supplier's sheets and the Smith job's;
// see `drawingRegion.test.ts` for the shape of sheet they describe.
//
// Everything here is PURE — no DOM, no pdf.js. The canvas work lives in
// `drawingCrops`.

import { padBbox, type Bbox } from "./markDrawing";

/** Paper. */
const PAPER = 0;
/** A pale printed line — a table rule, a panel divider, the sheet border. */
const RULE = 1;
/** Real line-work. */
const INK = 2;

/**
 * A rendered page reduced to three levels: paper, pale printed rule, and ink.
 * Row-major, one byte per sample, shrunk down from the page canvas — this is
 * layout analysis and a tenth of the resolution is plenty for finding blank
 * paper.
 *
 * Two levels rather than one because the sheets need both. The drawing is
 * near-black, so ink is "darker than {@link INK_LEVEL}", which conveniently also
 * excludes the pale watermark these sheets carry. But the lines that separate
 * one mark's panel from the next are printed in a light grey that lands in the
 * same band as that watermark, and without them a crop runs straight through
 * the spec table into the neighbouring window. Ink decides what to SHOW; rules
 * decide where a crop must STOP.
 */
export interface InkMask {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Luma below this is line-work — near-black on these sheets. */
const INK_LEVEL = 200;
/** Luma below this is at least a printed line; above it is paper or watermark. */
const RULE_LEVEL = 215;

/** A straight ink run at least this long (fraction of the page) is structure. */
const RUN_FRAC = 0.3;
/**
 * An unbroken printed line this long (fraction of the page) crosses the whole
 * sheet: it is the border, or the divider between two panels.
 *
 * Measured as one CONTINUOUS run rather than as a share of the row, which is
 * what makes it safe. A wide slider's head rail and a table rule can put the
 * same amount of ink in a line of the page, but only the sheet's own furniture
 * runs from one side to the other without a break.
 */
const FULL_RUN = 0.6;
/**
 * …and this long crosses a single panel, which is as much as a spec table
 * spans when the panel beside it is empty.
 */
const PANEL_RUN = 0.3;
/**
 * …and this much of one row of panels is that row's divider. Nearly all of it,
 * because a divider is drawn rule to rule while a window's mullion stops short
 * of the caption above it and the dimensions below.
 */
const BAND_RUN = 0.92;
/** Anything nearer than this to the paper's edge is the sheet's own border. */
const EDGE_MARGIN = 0.15;
/** How far apart the rungs of a spec table can be and still count as one table. */
const LADDER_SPAN = 0.12;
/** How many rungs make a ladder. */
const LADDER_MIN = 3;
/** Blank band (fraction of the page) that separates one drawing from the next. */
const GUTTER = 0.022;
/** Breathing room around the finished crop. */
const REGION_PAD = 0.01;

/**
 * Line-work per unit area under which a crop is not worth showing.
 *
 * NOT a share of the crop's pixels, which is what this used to be, because that
 * number moves with {@link inkMaskFromPixels}'s `step`. Each sample takes the
 * darkest pixel of its block, so a hairline fills a whole sample however coarse
 * the mask is: the same crop of the same page reads 0.005 ink at a tenth-scale
 * mask and 0.018 at a fiftieth. A fixed share therefore means one thing at one
 * resolution and something else at another — and at the resolution the app
 * actually renders, mark #2's black rectangle measured 0.018 against a 0.008
 * cutoff, so the check that was supposed to catch it passed it.
 *
 * Multiplying by the mask width takes the resolution back out: a stroke of
 * length L across a mask W samples wide covers about L·W samples, so
 * coverage·W is L per unit area — a property of the drawing, not of the
 * sampling. Measured on the Black Desert sheet, at every step from 2 to 10:
 * mark #2's broken crop scores 4.6–6.8, and the WEAKEST correct crop on the job
 * scores 12.2–18.9. Nine sits in that gap with a third of headroom either side
 * whatever the step.
 */
export const MIN_INK_DENSITY = 9;

/** {@link inkCoverage} with the mask's resolution divided out. PURE. */
export function inkDensity(mask: InkMask, box: Bbox): number {
  return inkCoverage(mask, box) * mask.width;
}

/**
 * Build an {@link InkMask} from a page canvas's RGBA pixels, shrinking by
 * `step` in each direction.
 *
 * Each output sample takes the DARKEST source pixel in its block, not the
 * middle one. That matters more than it sounds: the lines that define a panel
 * are one pixel wide, and plain subsampling drops them at random, which turns
 * two panels into one blob and hands a crew the wrong window. Taking the
 * darkest pixel keeps every hairline at any shrink factor. PURE.
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
      data[y * w + x] =
        darkest < INK_LEVEL ? INK : darkest < RULE_LEVEL ? RULE : PAPER;
    }
  }
  return { data, width: w, height: h };
}

function clampIndex(v: number, n: number): number {
  return Math.min(n - 1, Math.max(0, v));
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
    for (let x = x0; x < x1; x++) if (mask.data[row + x] === INK) ink += 1;
  }
  return ink / ((x1 - x0) * (y1 - y0));
}

/**
 * The ink layer of `mask` with long straight runs removed.
 *
 * A single long stroke — the sheet border, a table rule, the divider between
 * two panels — will bridge the blank gutter between two marks and make the
 * whole sheet look like one drawing. Removing them costs nothing: a window
 * elevation is a rectangle, so knocking out its long sides leaves the short
 * ones, and the block's extent is unchanged. PURE.
 */
export function stripLongRuns(mask: InkMask): InkMask {
  const { width: w, height: h, data } = mask;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) out[i] = data[i] === INK ? 1 : 0;
  const maxH = Math.round(RUN_FRAC * w);
  const maxV = Math.round(RUN_FRAC * h);

  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const ink = x < w && data[y * w + x] === INK;
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
      const ink = y < h && data[y * w + x] === INK;
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
 * the sheet border, and the lines above and below each row of spec tables.
 * These are the only lines allowed to bound a crop. PURE.
 */
export function pageRules(mask: InkMask): { rows: number[]; cols: number[] } {
  const { width: w, height: h, data } = mask;
  const at = (x: number, y: number) => data[y * w + x];

  const rowRun = new Float64Array(h);
  const rowPale = new Float64Array(h);
  const rowInk = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      run = v === PAPER ? 0 : run + 1;
      if (run > rowRun[y]) rowRun[y] = run;
      if (v === RULE) rowPale[y] += 1;
      else if (v === INK) rowInk[y] += 1;
    }
    rowRun[y] /= w;
  }

  const colRun = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      run = at(x, y) === PAPER ? 0 : run + 1;
      if (run > colRun[x]) colRun[x] = run;
    }
    colRun[x] /= h;
  }

  const full = (run: Float64Array, n: number) =>
    centres(n, (i) => run[i] >= FULL_RUN);
  const solidRows = full(rowRun, h);
  const tableRows = ladders(
    centres(h, (i) => rowRun[i] >= PANEL_RUN && rowPale[i] > rowInk[i]),
    solidRows,
  );
  return {
    rows: [...solidRows, ...tableRows].sort((a, b) => a - b),
    // Columns take the full-length test alone, and want no help from the pale
    // test: the divider between two panels runs the height of the sheet, while
    // the longest line inside a panel is a window's own mullion at about a
    // quarter of that. Nothing else on these pages sits in between, so this one
    // test finds every divider and no glazing bars.
    cols: full(colRun, w),
  };
}

/**
 * Vertical lines running the full height of the rows `y0`..`y1` — the sheet's
 * edges, and the divider between two panels sitting side by side there. PURE.
 *
 * A window's mullion can be nearly as long, but never quite: the panel has a
 * caption above the drawing and dimensions below it, so a line that reaches
 * from the top of the row to the bottom is the sheet's, not the window's.
 */
export function columnRules(mask: InkMask, y0: number, y1: number): number[] {
  const { width: w, data } = mask;
  const span = Math.max(1, y1 - y0);
  const need = Math.round(BAND_RUN * span);
  const isRule = (x: number) => {
    let run = 0;
    for (let y = y0; y < y1; y++) {
      run = data[y * w + x] === PAPER ? 0 : run + 1;
      if (run >= need) return true;
    }
    return false;
  };
  return centres(w, isRule);
}

function centres(n: number, isRule: (i: number) => boolean): number[] {
  const out: number[] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const rule = i < n && isRule(i);
    if (rule && start < 0) start = i;
    if (!rule && start >= 0) {
      out.push((start + i) / 2 / n);
      start = -1;
    }
  }
  return out;
}

/**
 * Keep only the pale lines that belong to a spec table.
 *
 * A table is a ladder: four or five rules stacked a few millimetres apart. A
 * window's head rail, sill or track detail is a lone pale line, and it is
 * every bit as long and as pale as a table rule — page 5's "Great Room" head
 * rail runs 37% of the sheet — so length and shade cannot tell them apart, but
 * company can. Requiring three within a short span keeps the tables and drops
 * the drawings, which is what stops a crop from decapitating its own window.
 */
function ladders(candidates: number[], solid: number[]): number[] {
  const pale = candidates.filter(
    (c) => !solid.some((s) => Math.abs(s - c) < LADDER_SPAN / 4),
  );
  return pale.filter((c) => {
    const near = pale.filter((o) => Math.abs(o - c) <= LADDER_SPAN);
    return near.length >= LADDER_MIN;
  });
}

/**
 * The region between the page rules that straddle `bbox`'s centre.
 *
 * The centre, not the box's edges. The stored boxes routinely overhang their
 * panel — a healthy one usually takes in the spec table below the drawing, and
 * a broken one can start on the wrong side of a rule altogether — so bounding
 * by the edges finds no boundary at all and lets a crop run the width of the
 * sheet. The centre is the one thing about these boxes that has been right
 * every time. PURE.
 */
export function cellFor(
  bbox: Bbox,
  rules: { rows: number[]; cols: number[] },
): Bbox {
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

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function anyInk(m: InkMask, r: Rect): boolean {
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * m.width;
    for (let x = r.x0; x < r.x1; x++) if (m.data[row + x]) return true;
  }
  return false;
}

/**
 * The ink pixel nearest the point (`px`,`py`), searched inside `cell`.
 *
 * Only needed for the boxes that miss: mark #2's box sits on the dimension line
 * beside its window with no ink in it at all, and without this there is nothing
 * to grow from.
 */
function nearestInk(
  m: InkMask,
  cell: Rect,
  px: number,
  py: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = cell.y0; y < cell.y1; y++) {
    const row = y * m.width;
    const dy = y - py;
    const dy2 = dy * dy;
    if (dy2 >= bestD) continue;
    for (let x = cell.x0; x < cell.x1; x++) {
      if (!m.data[row + x]) continue;
      const dx = x - px;
      const d = dx * dx + dy2;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * Grow `seed` outwards, one side at a time, for as long as there is ink within
 * a gutter of that side — and stop at a clean band of blank paper.
 *
 * This is the whole idea. A window elevation, its dimension lines and its
 * callouts are all within a few millimetres of each other, while the next mark
 * along is separated by a wide band of nothing. Growing until the paper goes
 * blank therefore collects exactly one mark's drawing, whether the box we
 * started from was a sliver of it (marks #12, #17), beside it (mark #2), or
 * already around all of it (marks #5, #16) — and because growth can only ever
 * cross ink, it can never step over the gutter into the neighbour's window.
 */
function growToBlank(
  m: InkMask,
  seed: Rect,
  cell: Rect,
  gx: number,
  gy: number,
): Rect {
  const r = { ...seed };
  let moved = true;
  while (moved) {
    moved = false;
    if (r.x0 > cell.x0) {
      const edge = Math.max(cell.x0, r.x0 - gx);
      if (anyInk(m, { x0: edge, y0: r.y0, x1: r.x0, y1: r.y1 })) {
        r.x0 = edge;
        moved = true;
      }
    }
    if (r.x1 < cell.x1) {
      const edge = Math.min(cell.x1, r.x1 + gx);
      if (anyInk(m, { x0: r.x1, y0: r.y0, x1: edge, y1: r.y1 })) {
        r.x1 = edge;
        moved = true;
      }
    }
    if (r.y0 > cell.y0) {
      const edge = Math.max(cell.y0, r.y0 - gy);
      if (anyInk(m, { x0: r.x0, y0: edge, x1: r.x1, y1: r.y0 })) {
        r.y0 = edge;
        moved = true;
      }
    }
    if (r.y1 < cell.y1) {
      const edge = Math.min(cell.y1, r.y1 + gy);
      if (anyInk(m, { x0: r.x0, y0: r.y1, x1: r.x1, y1: edge })) {
        r.y1 = edge;
        moved = true;
      }
    }
  }
  return r;
}

/** Shrink `r` to the bounding box of the ink inside it. */
function trimToInk(m: InkMask, r: Rect): Rect | null {
  let x0 = r.x1;
  let x1 = r.x0;
  let y0 = r.y1;
  let y1 = r.y0;
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * m.width;
    for (let x = r.x0; x < r.x1; x++) {
      if (!m.data[row + x]) continue;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
    }
  }
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
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
  const rules = pageRules(mask);
  const bounds = cellFor(bbox, rules);
  // Step inside the bounding rules themselves.
  const inset = Math.max(2, Math.round(0.004 * w));
  const cy0 = clampIndex(Math.round(bounds[1] * h) + inset, h);
  const cy1 = Math.max(cy0 + 1, Math.min(h, Math.round(bounds[3] * h) - inset));
  // If no divider runs the length of the page, look again within this row of
  // panels alone. Where a page holds one wide unit above two narrow ones, the
  // divider is only drawn across the row that needs it, and a page-length
  // search walks straight past it — which is how mark #34's crop came to have
  // both "Casita Suite" and "Hallway" in it.
  const interior = rules.cols.filter((c) => c > EDGE_MARGIN && c < 1 - EDGE_MARGIN);
  const cols = interior.length > 0 ? rules.cols : columnRules(mask, cy0, cy1);
  const cx = (bbox[0] + bbox[2]) / 2;
  const left = cols.reduce((acc, r) => (r <= cx && r > acc ? r : acc), 0);
  const right = cols.reduce((acc, r) => (r > cx && r < acc ? r : acc), 1);
  const cx0 = clampIndex(Math.round(left * w) + inset, w);
  const cx1 = Math.max(cx0 + 1, Math.min(w, Math.round(right * w) - inset));
  if (cx1 - cx0 < 8 || cy1 - cy0 < 8) return null;

  const gx = Math.max(3, Math.round(GUTTER * w));
  const gy = Math.max(3, Math.round(GUTTER * h));
  const cell: Rect = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };

  // Start from the vision box, clipped into its cell.
  let seed: Rect = {
    x0: clampIndex(Math.round(bbox[0] * w), w),
    y0: clampIndex(Math.round(bbox[1] * h), h),
    x1: clampIndex(Math.round(bbox[2] * w), w),
    y1: clampIndex(Math.round(bbox[3] * h), h),
  };
  seed = {
    x0: Math.max(cell.x0, Math.min(cell.x1 - 1, seed.x0)),
    y0: Math.max(cell.y0, Math.min(cell.y1 - 1, seed.y0)),
    x1: Math.min(cell.x1, Math.max(cell.x0 + 1, seed.x1)),
    y1: Math.min(cell.y1, Math.max(cell.y0 + 1, seed.y1)),
  };

  const trimmed = trimToInk(structure, seed);
  if (trimmed) {
    seed = trimmed;
  } else {
    // The box missed the drawing entirely. Start from whatever is closest.
    const near = nearestInk(
      structure,
      cell,
      (seed.x0 + seed.x1) / 2,
      (seed.y0 + seed.y1) / 2,
    );
    if (!near) return null;
    seed = { x0: near.x, y0: near.y, x1: near.x + 1, y1: near.y + 1 };
  }

  const grown = trimToInk(structure, growToBlank(structure, seed, cell, gx, gy));
  if (!grown) return null;

  const region: Bbox = [
    Math.max(0, grown.x0 / w - REGION_PAD),
    Math.max(0, grown.y0 / h - REGION_PAD),
    Math.min(1, grown.x1 / w + REGION_PAD),
    Math.min(1, grown.y1 / h + REGION_PAD),
  ];
  if (region[2] <= region[0] || region[3] <= region[1]) return null;
  return region;
}

/**
 * The box to actually crop for a mark, or null to show no drawing at all.
 *
 * Repairs the crops that are broken and LEAVES THE REST ALONE. That restraint is
 * the whole design, and it was learned the hard way: deriving every crop from
 * the panel geometry, which is what this did first, fixed mark #2 and broke
 * eleven other marks on the same job. Measured against the dimensions the
 * supplier prints on the sheet, 32 of the 36 crops on Black Desert were already
 * right; four of the replacements swallowed the neighbouring window as well, two
 * showed nothing at all, and five sliced the drawing they were meant to show.
 * A crop that already has the window in it does not need our help, and the ways
 * of getting it wrong are more numerous than the ways of getting it right.
 *
 * So: keep the stored box when it holds line-work, and only when it doesn't —
 * when the crew would be looking at a near-black rectangle — go and find the
 * drawing on the sheet.
 *
 * Returning null is a real answer, not a failure. Some panels on these sheets
 * are genuinely blank — the supplier left mark #25's drawing out — and this
 * codebase would rather show nothing than a black rectangle that looks like a
 * broken app. PURE.
 */
export function drawingCropBox(mask: InkMask, bbox: Bbox): Bbox | null {
  const stored = padBbox(bbox);
  if (inkDensity(mask, stored) >= MIN_INK_DENSITY) return stored;

  const region = resolveDrawingRegion(mask, bbox);
  if (!region) return null;
  if (inkDensity(mask, region) < MIN_INK_DENSITY) return null;
  if (splitByGutter(stripLongRuns(mask), region)) return null;
  return region;
}

/**
 * True when `region` has a band of blank paper down the middle wide enough to
 * be the gutter between two panels — so it holds two marks' drawings, not one.
 *
 * The last line of defence on a repair. One window's elevation, its dimension
 * lines and its callouts are all within a few millimetres of each other; the
 * next mark along is across a gutter. If a repair has grown across one anyway,
 * a crew looking at the picture cannot tell which of the two windows is theirs,
 * and a card with no picture on it is the lesser harm. PURE.
 */
export function splitByGutter(structure: InkMask, region: Bbox): boolean {
  const { width: w, height: h, data } = structure;
  const x0 = clampIndex(Math.round(region[0] * w), w);
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round(region[2] * w)));
  const y0 = clampIndex(Math.round(region[1] * h), h);
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round(region[3] * h)));
  const need = Math.max(3, Math.round(GUTTER * w));
  // Ignore the region's own blank margin at each end; only a gap with drawing
  // on BOTH sides of it separates two drawings.
  let seen = false;
  let blank = 0;
  for (let x = x0; x < x1; x++) {
    let ink = false;
    for (let y = y0; y < y1; y++) {
      if (data[y * w + x]) {
        ink = true;
        break;
      }
    }
    if (ink) {
      if (seen && blank >= need) return true;
      seen = true;
      blank = 0;
    } else if (seen) {
      blank += 1;
    }
  }
  return false;
}
