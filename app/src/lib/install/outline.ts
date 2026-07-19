// Best-effort building outline extraction from a floor-plan PDF page.
//
// Two extraction strategies feed one shared, rectilinear-aware pipeline:
//
//   1. VECTOR (preferred for CAD PDFs): read the page's actual vector stroke
//      paths via `page.getOperatorList()`, apply the current transformation
//      matrix, and rasterize the wall strokes onto a coarse occupancy grid.
//      This sidesteps dimension text / hatching / raster noise entirely.
//   2. RASTER (fallback): rasterize the page, Otsu-threshold to ink/no-ink and
//      downsample onto the same occupancy grid.
//
// Either way we then run the SAME grid pipeline: crop the sheet border, close
// wall gaps (doorways/windows), keep the largest mass, fill its interior, open
// away thin dimension/leader lines, trace the outer boundary and simplify it,
// then snap edges to right angles so the result reads like a clean "cartoon"
// building footprint instead of the raw drawing.
//
// The geometry helpers are exported as PURE functions (operating on synthetic
// grids / segment lists) so they can be unit-tested without a DOM/canvas.

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface OutlinePoint {
  /** 0..1 across the page width. */
  x: number;
  /** 0..1 down the page height. */
  y: number;
}

export interface BuildingOutline {
  /** Outer boundary polygon (normalized page coords). Empty = trace failed. */
  points: OutlinePoint[];
  /** Page height / width, for sizing the sheet. */
  pageAspect: number;
}

/** A straight wall segment in normalized (0..1) page space. */
export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const TARGET_WIDTH = 1000;
/** Pixels per occupancy-grid cell (also dilates thin wall lines together). */
const CELL = 5;
/** Ignore ink this close to the page edge (sheet border, title block edge). */
const EDGE_MARGIN = 0.045;
/** Reject "outlines" smaller than this fraction of the page area (noise). */
const MIN_BBOX_FRACTION = 0.08;
const MIN_DARK_PER_CELL = 3;

// Grid-pipeline tuning (in grid cells). Derived from CELL so the physical
// scale stays roughly constant even if CELL changes.
/** Close radius: bridges wall breaks at doors/windows into one loop. */
const CLOSE_RADIUS = 3;
/** Open radius: sheds thin dimension strings / leader lines after fill. */
const OPEN_RADIUS = 2;
/** Angle (degrees) within which an edge is snapped to horizontal/vertical. */
const RECTILINEAR_TOL_DEG = 10;

export async function extractBuildingOutline(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<BuildingOutline | null> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = TARGET_WIDTH / base.width;
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const pageAspect = height / width;

  const cols = Math.floor(width / CELL);
  const rows = Math.floor(height / CELL);
  if (cols < 4 || rows < 4) return { points: [], pageAspect };

  // Strategy 1: vector geometry. Preferred, but only trust it when it yields a
  // believable footprint; otherwise fall back to the raster path below.
  try {
    const segments = await extractWallSegments(page);
    if (segments.length >= 8) {
      const occ = segmentsToOccupancy(segments, rows, cols);
      const points = footprintFromOccupancy(occ, rows, cols);
      if (points && bboxFraction(points) >= MIN_BBOX_FRACTION) {
        return { points, pageAspect };
      }
    }
  } catch {
    // Vector parsing is best-effort; fall through to raster.
  }

  // Strategy 2: improved raster CV.
  const occ = await rasterOccupancy(page, viewport, width, height, rows, cols);
  if (!occ) return { points: [], pageAspect };
  const points = footprintFromOccupancy(occ, rows, cols);
  if (!points || bboxFraction(points) < MIN_BBOX_FRACTION) {
    return { points: [], pageAspect };
  }
  return { points, pageAspect };
}

/* ------------------------------------------------------------------ *
 * Vector strategy
 * ------------------------------------------------------------------ */

// DrawOPS path encoding used by pdf.js operator lists (flat number arrays).
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUAD_TO = 3;
const DRAW_CLOSE = 4;

type Matrix = [number, number, number, number, number, number];

/** Compose two PDF matrices: result applies `b` first, then `a`. */
function composeMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Read the vector stroke/fill paths of a page and return them as straight wall
 * segments in normalized (0..1, y-down) page space. Curves are flattened to
 * their endpoints (walls are straight); the current transformation matrix is
 * tracked through save/restore/transform so nested content lands in page space.
 */
async function extractWallSegments(
  page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>,
): Promise<WallSegment[]> {
  const opList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as unknown as Matrix;
  const w = viewport.width;
  const h = viewport.height;

  const stack: Matrix[] = [];
  let ctm: Matrix = base;
  const segments: WallSegment[] = [];

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? base;
        break;
      case OPS.transform: {
        const a = argsArray[i] as unknown as number[];
        ctm = composeMatrix(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
        break;
      }
      case OPS.constructPath: {
        const args = argsArray[i] as unknown as [number, number[][], unknown];
        const data = args?.[1]?.[0] as unknown as ArrayLike<number> | undefined;
        if (data) collectPathSegments(data, ctm, w, h, segments);
        break;
      }
      default:
        break;
    }
  }
  return segments;
}

/** Decode a flat DrawOPS path into normalized straight segments. */
function collectPathSegments(
  data: ArrayLike<number>,
  ctm: Matrix,
  w: number,
  h: number,
  out: WallSegment[],
): void {
  let sx = 0;
  let sy = 0; // subpath start
  let px = 0;
  let py = 0; // current point
  let has = false;
  const push = (x1: number, y1: number, x2: number, y2: number) => {
    out.push({ x1: x1 / w, y1: y1 / h, x2: x2 / w, y2: y2 / h });
  };
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    switch (op) {
      case DRAW_MOVE_TO: {
        const [x, y] = applyMatrix(ctm, data[i++], data[i++]);
        px = x;
        py = y;
        sx = x;
        sy = y;
        has = true;
        break;
      }
      case DRAW_LINE_TO: {
        const [x, y] = applyMatrix(ctm, data[i++], data[i++]);
        if (has) push(px, py, x, y);
        px = x;
        py = y;
        break;
      }
      case DRAW_CURVE_TO: {
        // Flatten a cubic to its endpoint (walls are straight lines).
        i += 4;
        const [x, y] = applyMatrix(ctm, data[i++], data[i++]);
        if (has) push(px, py, x, y);
        px = x;
        py = y;
        break;
      }
      case DRAW_QUAD_TO: {
        i += 2;
        const [x, y] = applyMatrix(ctm, data[i++], data[i++]);
        if (has) push(px, py, x, y);
        px = x;
        py = y;
        break;
      }
      case DRAW_CLOSE: {
        if (has) push(px, py, sx, sy);
        px = sx;
        py = sy;
        break;
      }
      default:
        return; // unknown op; stop decoding this path defensively
    }
  }
}

/**
 * Rasterize normalized wall segments onto a `rows × cols` occupancy grid.
 * Segments outside the drawing area (deep in the edge margin) are dropped so
 * the sheet border does not seed the footprint.
 */
export function segmentsToOccupancy(
  segments: WallSegment[],
  rows: number,
  cols: number,
): Uint8Array {
  const occ = new Uint8Array(rows * cols);
  const set = (c: number, r: number) => {
    if (r >= 0 && c >= 0 && r < rows && c < cols) occ[r * cols + c] = 1;
  };
  for (const s of segments) {
    let c0 = Math.round(s.x1 * (cols - 1));
    let r0 = Math.round(s.y1 * (rows - 1));
    const c1 = Math.round(s.x2 * (cols - 1));
    const r1 = Math.round(s.y2 * (rows - 1));
    // Bresenham.
    const dc = Math.abs(c1 - c0);
    const dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1;
    const sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      set(c0, r0);
      if (c0 === c1 && r0 === r1) break;
      const e2 = 2 * err;
      if (e2 > -dr) {
        err -= dr;
        c0 += sc;
      }
      if (e2 < dc) {
        err += dc;
        r0 += sr;
      }
    }
  }
  return occ;
}

/* ------------------------------------------------------------------ *
 * Raster strategy
 * ------------------------------------------------------------------ */

async function rasterOccupancy(
  page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>,
  viewport: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]>,
  width: number,
  height: number,
  rows: number,
  cols: number,
): Promise<Uint8Array | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const data = ctx.getImageData(0, 0, width, height).data;

  const marginX = Math.round(width * EDGE_MARGIN);
  const marginY = Math.round(height * EDGE_MARGIN);
  const yMax = Math.min(rows * CELL, height - marginY);
  const xMax = Math.min(cols * CELL, width - marginX);

  // Luma histogram over the drawing area for an Otsu threshold.
  const hist = new Uint32Array(256);
  const luma = new Uint8Array(width * height);
  for (let y = marginY; y < yMax; y++) {
    for (let x = marginX; x < xMax; x++) {
      const i = (y * width + x) * 4;
      const l =
        (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      luma[y * width + x] = l;
      hist[l]++;
    }
  }
  const threshold = otsuThreshold(hist);

  const counts = new Uint16Array(rows * cols);
  for (let y = marginY; y < yMax; y++) {
    const rowBase = Math.floor(y / CELL) * cols;
    for (let x = marginX; x < xMax; x++) {
      if (luma[y * width + x] < threshold) counts[rowBase + Math.floor(x / CELL)]++;
    }
  }
  const occ = new Uint8Array(rows * cols);
  for (let i = 0; i < occ.length; i++) {
    if (counts[i] >= MIN_DARK_PER_CELL) occ[i] = 1;
  }
  return occ;
}

/**
 * Otsu's method: pick the luma threshold that maximizes between-class variance.
 * Returns a value in 1..254; falls back to 160 for a degenerate histogram.
 */
export function otsuThreshold(hist: ArrayLike<number>): number {
  let total = 0;
  let sum = 0;
  for (let t = 0; t < 256; t++) {
    total += hist[t];
    sum += t * hist[t];
  }
  if (total === 0) return 160;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 160;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return Math.min(254, Math.max(1, bestT));
}

/* ------------------------------------------------------------------ *
 * Shared grid pipeline: occupancy grid -> clean rectilinear polygon
 * ------------------------------------------------------------------ */

/**
 * Turn a raw occupancy grid into a clean, right-angled footprint polygon in
 * normalized (0..1) page coordinates, or null if nothing plausible remains.
 * Pure and deterministic — the DOM/canvas never enters here.
 */
export function footprintFromOccupancy(
  occRaw: Uint8Array,
  rows: number,
  cols: number,
): OutlinePoint[] | null {
  const grid = buildFootprintPolygon(occRaw, rows, cols);
  if (!grid) return null;
  return grid.map(([c, r]) => ({ x: c / cols, y: r / rows }));
}

/**
 * Core footprint extraction on a grid, returning corner-grid vertices
 * [col, row]. Exported for testing with synthetic masks.
 */
export function buildFootprintPolygon(
  occRaw: Uint8Array,
  rows: number,
  cols: number,
): [number, number][] | null {
  // 1. Drop the sheet border / title-block edge strips.
  let mask = cropEdges(occRaw, rows, cols, EDGE_MARGIN);
  // 2. Bridge wall breaks (doorways, window gaps) into one closed region.
  mask = morphClose(mask, rows, cols, CLOSE_RADIUS);
  // 3. Keep the largest connected mass (drops the title block & stray notes).
  let comp = largestComponent(mask, rows, cols);
  if (!comp) return null;
  // 4. Solidify the footprint so it is one filled region.
  comp = fillHoles(comp, rows, cols);
  // 5. Shed thin appendages: dimension strings, leader lines, north arrows.
  comp = morphOpen(comp, rows, cols, OPEN_RADIUS);
  // 6. Opening can fragment/erode; re-take the main mass and re-fill.
  const comp2 = largestComponent(comp, rows, cols);
  if (!comp2) return null;
  comp = fillHoles(comp2, rows, cols);

  const loop = traceOuterBoundary(comp, rows, cols);
  if (loop.length < 4) return null;

  let simplified = collapseCollinear(loop);
  let eps = 1.6;
  simplified = rdp(simplified, eps);
  while (simplified.length > 200) {
    eps *= 1.5;
    simplified = rdp(simplified, eps);
  }

  // 7. Snap near-axis edges to true horizontal/vertical and tidy the polygon.
  let snapped = snapRectilinear(simplified, RECTILINEAR_TOL_DEG);
  snapped = collapseCollinear(snapped);
  snapped = dedupeClosePoints(snapped);
  if (snapped.length < 3) return null;
  return snapped;
}

/** bbox area (fraction of page) of a normalized polygon. */
function bboxFraction(points: OutlinePoint[]): number {
  if (points.length === 0) return 0;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return (
    (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
  );
}

/** Zero out cells within `marginFrac` of any edge (sheet border/title edge). */
export function cropEdges(
  occ: Uint8Array,
  rows: number,
  cols: number,
  marginFrac: number,
): Uint8Array {
  const out = occ.slice();
  const mr = Math.round(rows * marginFrac);
  const mc = Math.round(cols * marginFrac);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r < mr || r >= rows - mr || c < mc || c >= cols - mc) {
        out[r * cols + c] = 0;
      }
    }
  }
  return out;
}

/** Grid-square dilation by Chebyshev radius `r` (separable H then V). */
export function dilate(
  mask: Uint8Array,
  rows: number,
  cols: number,
  r: number,
): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(rows * cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let on = 0;
      for (let dx = -r; dx <= r && !on; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < cols && mask[y * cols + nx]) on = 1;
      }
      tmp[y * cols + x] = on;
    }
  }
  const out = new Uint8Array(rows * cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < rows && tmp[ny * cols + x]) on = 1;
      }
      out[y * cols + x] = on;
    }
  }
  return out;
}

/** Grid-square erosion by Chebyshev radius `r` (out-of-bounds counts as off). */
export function erode(
  mask: Uint8Array,
  rows: number,
  cols: number,
  r: number,
): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(rows * cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let on = 1;
      for (let dx = -r; dx <= r && on; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= cols || !mask[y * cols + nx]) on = 0;
      }
      tmp[y * cols + x] = on;
    }
  }
  const out = new Uint8Array(rows * cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let on = 1;
      for (let dy = -r; dy <= r && on; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rows || !tmp[ny * cols + x]) on = 0;
      }
      out[y * cols + x] = on;
    }
  }
  return out;
}

/** Morphological close (dilate then erode): bridges small gaps. */
export function morphClose(
  mask: Uint8Array,
  rows: number,
  cols: number,
  r: number,
): Uint8Array {
  return erode(dilate(mask, rows, cols, r), rows, cols, r);
}

/** Morphological open (erode then dilate): removes thin protrusions/specks. */
export function morphOpen(
  mask: Uint8Array,
  rows: number,
  cols: number,
  r: number,
): Uint8Array {
  return dilate(erode(mask, rows, cols, r), rows, cols, r);
}

/**
 * Fill interior holes: flood the background inward from the grid border; any
 * background cell not reachable from the border is enclosed and gets set.
 */
export function fillHoles(
  mask: Uint8Array,
  rows: number,
  cols: number,
): Uint8Array {
  const outside = new Uint8Array(rows * cols);
  const queue = new Int32Array(rows * cols);
  let head = 0;
  let tail = 0;
  const enq = (r: number, c: number) => {
    const idx = r * cols + c;
    if (mask[idx] || outside[idx]) return;
    outside[idx] = 1;
    queue[tail++] = idx;
  };
  for (let c = 0; c < cols; c++) {
    enq(0, c);
    enq(rows - 1, c);
  }
  for (let r = 0; r < rows; r++) {
    enq(r, 0);
    enq(r, cols - 1);
  }
  while (head < tail) {
    const idx = queue[head++];
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    if (r > 0) enq(r - 1, c);
    if (r < rows - 1) enq(r + 1, c);
    if (c > 0) enq(r, c - 1);
    if (c < cols - 1) enq(r, c + 1);
  }
  const out = new Uint8Array(rows * cols);
  for (let i = 0; i < out.length; i++) {
    out[i] = mask[i] || !outside[i] ? 1 : 0;
  }
  return out;
}

/** Mask (1/0) of the largest 8-connected occupied component, or null. */
export function largestComponent(
  occ: Uint8Array,
  rows: number,
  cols: number,
): Uint8Array | null {
  const labels = new Int32Array(rows * cols).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(rows * cols);

  for (let start = 0; start < occ.length; start++) {
    if (!occ[start] || labels[start] !== -1) continue;
    const label = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let size = 0;
    while (head < tail) {
      const idx = queue[head++];
      size++;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const nidx = nr * cols + nc;
          if (occ[nidx] && labels[nidx] === -1) {
            labels[nidx] = label;
            queue[tail++] = nidx;
          }
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length === 0) return null;

  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  if (sizes[best] < 30) return null; // too small to be a building

  const mask = new Uint8Array(rows * cols);
  for (let i = 0; i < mask.length; i++) if (labels[i] === best) mask[i] = 1;
  return mask;
}

/**
 * Trace the outer boundary of a cell mask. Directed unit edges are emitted
 * wherever a set cell borders an unset cell (clockwise around ink), chained
 * into closed loops; the loop with the largest area is the outer boundary.
 * Returns corner-grid vertices as [col, row].
 */
export function traceOuterBoundary(
  mask: Uint8Array,
  rows: number,
  cols: number,
): [number, number][] {
  const stride = cols + 1;
  const inComp = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < rows && c < cols && mask[r * cols + c] === 1;

  const out = new Map<number, number[]>();
  const addEdge = (a: number, b: number) => {
    const arr = out.get(a);
    if (arr) arr.push(b);
    else out.set(a, [b]);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      const tl = r * stride + c;
      const tr = r * stride + c + 1;
      const bl = (r + 1) * stride + c;
      const br = (r + 1) * stride + c + 1;
      if (!inComp(r - 1, c)) addEdge(tl, tr);
      if (!inComp(r, c + 1)) addEdge(tr, br);
      if (!inComp(r + 1, c)) addEdge(br, bl);
      if (!inComp(r, c - 1)) addEdge(bl, tl);
    }
  }

  let bestLoop: number[] = [];
  let bestArea = 0;
  while (out.size > 0) {
    const start = out.keys().next().value as number;
    const loop: number[] = [start];
    let cur = start;
    for (;;) {
      const nexts = out.get(cur);
      if (!nexts || nexts.length === 0) {
        out.delete(cur);
        break;
      }
      const nxt = nexts.pop()!;
      if (nexts.length === 0) out.delete(cur);
      if (nxt === start) break;
      loop.push(nxt);
      cur = nxt;
    }
    if (loop.length < 4) continue;
    const pts: [number, number][] = loop.map((v) => [v % stride, Math.floor(v / stride)]);
    const area = Math.abs(shoelace(pts));
    if (area > bestArea) {
      bestArea = area;
      bestLoop = loop;
    }
  }

  return bestLoop.map((v) => [v % stride, Math.floor(v / stride)]);
}

function shoelace(pts: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Drop intermediate points on straight runs. */
export function collapseCollinear(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const result: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const cur = pts[i];
    const next = pts[(i + 1) % pts.length];
    const d1x = cur[0] - prev[0];
    const d1y = cur[1] - prev[1];
    const d2x = next[0] - cur[0];
    const d2y = next[1] - cur[1];
    if (d1x * d2y - d1y * d2x !== 0) result.push(cur);
  }
  return result.length >= 3 ? result : pts;
}

/** Ramer–Douglas–Peucker simplification (open path over the loop order). */
export function rdp(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const [x1, y1] = pts[lo];
    const [x2, y2] = pts[hi];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > eps) {
      keep[maxIdx] = 1;
      stack.push([lo, maxIdx], [maxIdx, hi]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * Snap a nearly-rectilinear polygon so each edge that is within `tolDeg` of an
 * axis becomes exactly horizontal or vertical. Buildings are overwhelmingly
 * right-angled, so this removes the staircased/diagonal grid noise. Edges that
 * are genuinely diagonal (beyond tolerance) are left untouched.
 */
export function snapRectilinear(
  pts: [number, number][],
  tolDeg: number,
): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const tol = (tolDeg * Math.PI) / 180;
  const out: [number, number][] = pts.map((p) => [p[0], p[1]]);
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const dx = cur[0] - prev[0];
    const dy = cur[1] - prev[1];
    if (dx === 0 && dy === 0) continue;
    const ang = Math.atan2(Math.abs(dy), Math.abs(dx)); // 0=horiz, pi/2=vert
    if (ang <= tol) {
      // near-horizontal: keep x, lock y to previous vertex
      out[i] = [cur[0], prev[1]];
    } else if (ang >= Math.PI / 2 - tol) {
      // near-vertical: keep y, lock x to previous vertex
      out[i] = [prev[0], cur[1]];
    }
  }
  return out;
}

/** Remove consecutive points closer than `minDist` (grid units). */
export function dedupeClosePoints(
  pts: [number, number][],
  minDist = 0.5,
): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i];
    const prev = out[out.length - 1];
    if (prev && Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) < minDist) {
      continue;
    }
    out.push(cur);
  }
  // Also collapse the wrap-around duplicate.
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < minDist) out.pop();
  }
  return out;
}

const FALLBACK_RECT: OutlinePoint[] = [
  { x: 0.12, y: 0.15 },
  { x: 0.88, y: 0.15 },
  { x: 0.88, y: 0.85 },
  { x: 0.12, y: 0.85 },
];

/** Clamp a point into page space. */
export function clampOutlinePoint(p: OutlinePoint): OutlinePoint {
  return {
    x: Math.min(0.995, Math.max(0.005, p.x)),
    y: Math.min(0.995, Math.max(0.005, p.y)),
  };
}

/** True when the polygon has enough distinct vertices to draw a shape. */
export function isValidOutlinePolygon(points: OutlinePoint[]): boolean {
  if (points.length < 3) return false;
  const uniq = new Set(points.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`));
  return uniq.size >= 3;
}

/** Prefer a saved manual outline over a CAD auto-trace for the same page. */
export function preferOutline(
  manual: BuildingOutline | null | undefined,
  extracted: BuildingOutline | null | undefined,
): BuildingOutline | null {
  if (manual && isValidOutlinePolygon(manual.points)) return manual;
  if (extracted && extracted.points.length > 0) return extracted;
  return extracted ?? null;
}

/** SVG path `d` for a closed polygon in a 1000 × (1000*aspect) viewBox. */
export function outlinePathD(
  points: OutlinePoint[],
  aspect: number,
): string | null {
  if (!isValidOutlinePolygon(points)) return null;
  const h = 1000 * aspect;
  return (
    points
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${(p.x * 1000).toFixed(1)} ${(p.y * h).toFixed(1)}`,
      )
      .join(" ") + " Z"
  );
}

/**
 * Evenly distribute `count` markers around the outline perimeter, nudged
 * slightly outward so dots sit just outside the walls. Falls back to a
 * schematic rectangle when no outline is available.
 */
export function perimeterPositions(
  outline: BuildingOutline | null,
  count: number,
): OutlinePoint[] {
  if (count === 0) return [];
  const aspect = outline?.pageAspect ?? 0.7;
  const poly =
    outline && outline.points.length >= 3 ? outline.points : FALLBACK_RECT;

  // Work in display space (square units) so spacing looks even on screen.
  const pts = poly.map((p) => ({ u: p.x, v: p.y * aspect }));
  let cu = 0;
  let cv = 0;
  for (const p of pts) {
    cu += p.u;
    cv += p.v;
  }
  cu /= pts.length;
  cv /= pts.length;

  const segs: { au: number; av: number; du: number; dv: number; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const len = Math.hypot(du, dv);
    if (len < 1e-6) continue;
    segs.push({ au: a.u, av: a.v, du, dv, len });
    total += len;
  }
  if (segs.length === 0 || total < 1e-6) {
    return Array.from({ length: count }, (_, i) => ({
      x: 0.1 + (0.8 * i) / Math.max(1, count - 1),
      y: 0.1,
    }));
  }

  const OFFSET = 0.05;
  const result: OutlinePoint[] = [];
  const step = total / count;
  let target = step / 2;
  let walked = 0;
  let si = 0;
  for (let i = 0; i < count; i++) {
    while (si < segs.length - 1 && walked + segs[si].len < target) {
      walked += segs[si].len;
      si++;
    }
    const seg = segs[si];
    const t = Math.min(1, Math.max(0, (target - walked) / seg.len));
    const pu = seg.au + seg.du * t;
    const pv = seg.av + seg.dv * t;
    // Outward normal: perpendicular to the segment, pointing away from centroid.
    let nu = seg.dv / seg.len;
    let nv = -seg.du / seg.len;
    if (nu * (pu - cu) + nv * (pv - cv) < 0) {
      nu = -nu;
      nv = -nv;
    }
    result.push({
      x: Math.min(0.97, Math.max(0.03, pu + nu * OFFSET)),
      y: Math.min(0.97, Math.max(0.03, (pv + nv * OFFSET) / aspect)),
    });
    target += step;
  }
  return result;
}
