// Re-registering a stored trace onto the current plan image.
//
// A trace is coordinates in the PIXELS of whatever image it was drawn over.
// Ben's Black Desert trace was made on his own export of the plan; the app
// renders the same sheet from the planset PDF at a different resolution and
// margin, so the stored trace lands visibly offset — right shapes, wrong
// place. The correction is fully determined by data we already have: the
// trace's dots and the app's extracted pins name the SAME marks, and each
// matched pair says "this old-image point is this new-image point". A
// least-squares similarity transform (scale + rotation + translation) over
// those pairs moves the whole trace — polygons, dots, calibration line —
// onto the current image. Pure functions, unit-tested.

export interface Pt {
  x: number;
  y: number;
}

export interface Similarity {
  /** x' = a*x - b*y + tx ; y' = b*x + a*y + ty */
  a: number;
  b: number;
  tx: number;
  ty: number;
}

export interface TraceLike {
  cal?: { ax: number; ay: number; bx: number; by: number } & Record<string, unknown>;
  polys?: Pt[][];
  dots?: Record<string, Pt>;
}

/**
 * Least-squares similarity from `from` points onto `to` points (2D Umeyama
 * without reflection). Needs 2+ pairs with real spread; returns null when the
 * problem is degenerate (too few pairs, or all points coincident).
 */
export function fitSimilarity(pairs: { from: Pt; to: Pt }[]): Similarity | null {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  let fcx = 0, fcy = 0, tcx = 0, tcy = 0;
  for (const p of pairs) {
    fcx += p.from.x; fcy += p.from.y;
    tcx += p.to.x; tcy += p.to.y;
  }
  fcx /= n; fcy /= n; tcx /= n; tcy /= n;

  let sxx = 0, dot = 0, cross = 0;
  for (const p of pairs) {
    const fx = p.from.x - fcx, fy = p.from.y - fcy;
    const tx = p.to.x - tcx, ty = p.to.y - tcy;
    sxx += fx * fx + fy * fy;
    dot += fx * tx + fy * ty;
    cross += fx * ty - fy * tx;
  }
  if (sxx < 1e-9) return null;

  const a = dot / sxx;
  const b = cross / sxx;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // A collapse to ~zero scale means the pairs disagree completely; a
  // transform that flattens the trace to a point helps no one.
  if (Math.hypot(a, b) < 1e-3) return null;

  return { a, b, tx: tcx - (a * fcx - b * fcy), ty: tcy - (b * fcx + a * fcy) };
}

export function applySimilarity(t: Similarity, p: Pt): Pt {
  return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty };
}

/** Root-mean-square distance between matched pairs, for fit-quality checks. */
export function rmsResidual(pairs: { from: Pt; to: Pt }[], t: Similarity): number {
  if (!pairs.length) return 0;
  let sum = 0;
  for (const p of pairs) {
    const q = applySimilarity(t, p.from);
    sum += (q.x - p.to.x) ** 2 + (q.y - p.to.y) ** 2;
  }
  return Math.sqrt(sum / pairs.length);
}

/**
 * Register a stored trace onto the current image using matched dot→target
 * pairs (targets in current-image pixels, keyed however the caller matched
 * them). Returns a transformed COPY, or null when no trustworthy fit exists:
 * fewer than 3 matches, or a fit whose residual says the pairs don't actually
 * describe one rigid move (guards against a mis-keyed dot dragging the whole
 * trace sideways).
 */
export function registerTrace(
  trace: TraceLike,
  targets: Record<string, Pt>,
  imageWidth: number,
): TraceLike | null {
  const dots = trace.dots ?? {};
  const pairs: { from: Pt; to: Pt }[] = [];
  for (const id of Object.keys(dots)) {
    const to = targets[id];
    if (to) pairs.push({ from: dots[id], to });
  }
  if (pairs.length < 3) return null;

  const t = fitSimilarity(pairs);
  if (!t) return null;
  // Extraction pins mark callout numbers, not the exact dot spots, so some
  // scatter is expected — but beyond ~4% of the image width the "fit" is
  // fiction and hand-alignment beats a confident wrong answer.
  if (rmsResidual(pairs, t) > imageWidth * 0.04) return null;

  const out: TraceLike = {
    polys: (trace.polys ?? []).map((poly) => poly.map((p) => {
      const q = applySimilarity(t, p);
      return { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
    })),
    dots: {},
  };
  for (const id of Object.keys(dots)) {
    const q = applySimilarity(t, dots[id]);
    out.dots![id] = { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
  }
  if (trace.cal) {
    const a = applySimilarity(t, { x: trace.cal.ax, y: trace.cal.ay });
    const b = applySimilarity(t, { x: trace.cal.bx, y: trace.cal.by });
    // The measured value rides along untouched: similarity scales the pixel
    // length and the real-world number still describes the same two points.
    out.cal = { ...trace.cal, ax: a.x, ay: a.y, bx: b.x, by: b.y };
  }
  return out;
}
