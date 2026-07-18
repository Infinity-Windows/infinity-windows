// Best-effort building outline extraction from a floor-plan PDF page.
//
// The page is rasterized, thresholded to ink/no-ink, downsampled onto a
// coarse grid, and the largest connected ink region (away from the sheet
// border and title block) is taken to be the building. Its outer boundary
// is traced into a polygon and simplified so the map can draw a clean
// "cartoon" outline instead of the raw drawing.

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

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

const TARGET_WIDTH = 1000;
/** Pixels per occupancy-grid cell (also dilates thin wall lines together). */
const CELL = 5;
/** Ignore ink this close to the page edge (sheet border, title block edge). */
const EDGE_MARGIN = 0.045;
const DARK_LUMA = 160;
const MIN_DARK_PER_CELL = 3;
/** Reject "outlines" smaller than this fraction of the page area (noise). */
const MIN_BBOX_FRACTION = 0.08;

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

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const data = ctx.getImageData(0, 0, width, height).data;

  const cols = Math.floor(width / CELL);
  const rows = Math.floor(height / CELL);
  if (cols < 4 || rows < 4) return { points: [], pageAspect };

  const marginX = Math.round(width * EDGE_MARGIN);
  const marginY = Math.round(height * EDGE_MARGIN);

  // Per-cell dark pixel counts (single pass over the bitmap).
  const counts = new Uint16Array(rows * cols);
  const yMax = Math.min(rows * CELL, height - marginY);
  const xMax = Math.min(cols * CELL, width - marginX);
  for (let y = marginY; y < yMax; y++) {
    const rowBase = Math.floor(y / CELL) * cols;
    for (let x = marginX; x < xMax; x++) {
      const i = (y * width + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < DARK_LUMA) counts[rowBase + Math.floor(x / CELL)]++;
    }
  }
  const occ = new Uint8Array(rows * cols);
  for (let i = 0; i < occ.length; i++) {
    if (counts[i] >= MIN_DARK_PER_CELL) occ[i] = 1;
  }

  const comp = largestComponent(occ, rows, cols);
  if (!comp) return { points: [], pageAspect };

  const loop = traceOuterBoundary(comp, rows, cols);
  if (loop.length < 4) return { points: [], pageAspect };

  let simplified = collapseCollinear(loop);
  let eps = 1.6;
  simplified = rdp(simplified, eps);
  while (simplified.length > 200) {
    eps *= 1.5;
    simplified = rdp(simplified, eps);
  }

  const points = simplified.map(([c, r]) => ({
    x: (c * CELL) / width,
    y: (r * CELL) / height,
  }));

  // Sanity: the traced region must cover a meaningful share of the page.
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const bboxArea =
    (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  if (bboxArea < MIN_BBOX_FRACTION) return { points: [], pageAspect };

  return { points, pageAspect };
}

/** Mask (1/0) of the largest 8-connected occupied component, or null. */
function largestComponent(
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
function traceOuterBoundary(
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

/** Drop intermediate points on straight runs of unit steps. */
function collapseCollinear(pts: [number, number][]): [number, number][] {
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
function rdp(pts: [number, number][], eps: number): [number, number][] {
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

const FALLBACK_RECT: OutlinePoint[] = [
  { x: 0.12, y: 0.15 },
  { x: 0.88, y: 0.15 },
  { x: 0.88, y: 0.85 },
  { x: 0.12, y: 0.85 },
];

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
