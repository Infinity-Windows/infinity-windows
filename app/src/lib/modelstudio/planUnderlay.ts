// The plan sheet, faintly, behind the 2D walls (owner: "I should be able to
// draw walls on the trace feature too, so that i can see the plans faintly
// behind this view... a better version of trace walls").
//
// The Studio model is SEEDED from the trace (fromProject.ts's
// planFromRings, which turns a traced footprint straight into corners), so
// the trace's stored footprint polygon — sheet PIXELS — and the Studio
// floor's own exterior wall loop — plan CENTIMETRES — describe the SAME
// building. An affine transform fit through their corresponding corners is
// what tells the floorplanner canvas where the plan image belongs; unlike
// the seed-time formula (a fixed scale from the trace's calibration line)
// this is refit from whatever the CURRENT floor looks like, so it keeps
// working after the vendor recentres on save or a wall gets dragged
// (fromProject.ts's frameTransform note: "absolute plan coordinates only
// match right after a fresh seed").
//
// Same shape as fitview/traceRegistration.ts's least-squares point fit —
// pairs in, transform out, refuse rather than guess when the pairs don't
// actually describe one fit — a full 2D affine here (not just a
// similarity) because a dragged wall can stretch one axis without the
// other, which a uniform scale can't absorb.

export interface Pt {
  x: number;
  y: number;
}

export interface Affine {
  /** x' = a*x + b*y + tx ; y' = c*x + d*y + ty */
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares affine from `from` points onto `to` points: two independent
 * linear regressions (x' on x,y and y' on x,y) sharing one centered 2×2
 * covariance of the `from` side. Needs 3+ pairs with real 2D spread —
 * collinear (or coincident) `from` points can't pin down a plane, and this
 * returns null rather than a plane the data never described.
 */
export function fitAffine(pairs: { from: Pt; to: Pt }[]): Affine | null {
  const n = pairs.length;
  if (n < 3) return null;

  let mx = 0, my = 0, mu = 0, mv = 0;
  for (const { from: p, to: q } of pairs) {
    mx += p.x; my += p.y; mu += q.x; mv += q.y;
  }
  mx /= n; my /= n; mu /= n; mv /= n;

  let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
  for (const { from: p, to: q } of pairs) {
    const fx = p.x - mx, fy = p.y - my;
    const fu = q.x - mu, fv = q.y - mv;
    sxx += fx * fx;
    sxy += fx * fy;
    syy += fy * fy;
    sxu += fx * fu;
    syu += fy * fu;
    sxv += fx * fv;
    syv += fy * fv;
  }

  const det = sxx * syy - sxy * sxy;
  // Scale-relative guard: points piled on (near) one line leave `det` near
  // zero relative to their own spread, whatever units they're in.
  if (!(det > 1e-6 * (sxx + syy + 1))) return null;

  const a = (sxu * syy - syu * sxy) / det;
  const b = (sxx * syu - sxy * sxu) / det;
  const c = (sxv * syy - syv * sxy) / det;
  const d = (sxx * syv - sxy * sxv) / det;
  if (![a, b, c, d].every(Number.isFinite)) return null;

  return { a, b, c, d, tx: mu - a * mx - b * my, ty: mv - c * mx - d * my };
}

export function applyAffine(t: Affine, p: Pt): Pt {
  return { x: t.a * p.x + t.b * p.y + t.tx, y: t.c * p.x + t.d * p.y + t.ty };
}

/**
 * Rotate a closed ring to start at its lowest-x (then lowest-y) vertex, and
 * force a positive shoelace sign — the same starting corner and winding
 * direction no matter which of two spaces (sheet pixels, plan centimetres)
 * describes the ring, or which way it happened to be traced/built. Without
 * this, a trace poly and the model's own `outerPolygons` walk (which starts
 * from its OWN lowest-x corner, independent of insertion order) line up on
 * the same building but not on the same ARRAY INDEX — pairing them by index
 * without canonicalizing first pairs the wrong corners together.
 */
export function canonicalRing(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  let startIdx = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], best = pts[startIdx];
    if (p.x < best.x - 1e-9 || (Math.abs(p.x - best.x) < 1e-9 && p.y < best.y)) {
      startIdx = i;
    }
  }
  const rotated = [...pts.slice(startIdx), ...pts.slice(0, startIdx)];
  let area = 0;
  for (let i = 0; i < rotated.length; i++) {
    const a = rotated[i];
    const b = rotated[(i + 1) % rotated.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area < 0 ? [rotated[0], ...rotated.slice(1).reverse()] : rotated;
}

function sortedCanonicalMasses(polys: Pt[][]): Pt[][] {
  return polys
    .filter((ring) => ring.length >= 3)
    .map(canonicalRing)
    .sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y);
}

/** Shoelace area, unsigned — used only to rank rings by size, so the sign
 * (which canonicalRing already normalizes away) doesn't matter here. */
function ringArea(ring: Pt[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * The transform from a trace's stored footprint (sheet pixels, one or more
 * closed masses) onto a Studio floor's CURRENT footprint (plan cm, same
 * shape read via `outerPolygons`) — corner-for-corner correspondence after
 * canonicalizing each ring, least-squares fit through every pair at once.
 * Masses are matched by sorted position, not input order, since neither
 * side's array order is guaranteed to agree with the other's. Null when the
 * two footprints don't actually match up (a mass whose corner count changed
 * since the seed — a wall added or merged has no trustworthy per-corner
 * correspondence left) — the caller's job is to skip the underlay quietly,
 * never to guess.
 *
 * A traced story can carry interior partitions as their own closed rings —
 * the tracer lets a surveyor draw whatever they see — that `outerPolygons`
 * NEVER produces for the model side ("interior partition walls never leak
 * into the silhouette", toFitview.ts): Mad Moose's Ground story, for
 * instance, traces the exterior rectangle PLUS a 5-point partition, while
 * the Studio floor it seeded is a bare rectangle, one mass. When the trace
 * has MORE masses than the model, keep only the largest-by-area trace rings
 * — an exterior shell always dwarfs an interior wall's sliver — down to the
 * model's count, rather than refusing the whole underlay outright. The
 * reverse (model has more masses than the trace) has no such reading — the
 * model can't have grown a building the trace never saw — so that still
 * refuses below.
 */
export function storyUnderlayTransform(
  tracePolys: Pt[][],
  modelFootprintPolys: Pt[][],
): Affine | null {
  let traceMasses = sortedCanonicalMasses(tracePolys);
  const modelMasses = sortedCanonicalMasses(modelFootprintPolys);
  if (traceMasses.length === 0 || modelMasses.length === 0) return null;

  if (traceMasses.length > modelMasses.length) {
    traceMasses = traceMasses
      .slice()
      .sort((a, b) => ringArea(b) - ringArea(a))
      .slice(0, modelMasses.length)
      .sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y);
  }
  if (traceMasses.length !== modelMasses.length) return null;

  const pairs: { from: Pt; to: Pt }[] = [];
  for (let m = 0; m < traceMasses.length; m++) {
    const tr = traceMasses[m];
    const mo = modelMasses[m];
    if (tr.length !== mo.length) return null;
    for (let i = 0; i < tr.length; i++) pairs.push({ from: tr[i], to: mo[i] });
  }
  return fitAffine(pairs);
}

interface RawTraceStory {
  polys?: Pt[][];
}

interface RawTrace {
  stories?: RawTraceStory[];
  polys?: Pt[][];
}

/**
 * The trace's stored footprint for one Studio floor (0-based), sheet
 * pixels — `trace` is `AuthoredModel.building.trace`, opaque to the fitview
 * adapter by design, so this is the one place that reaches into its shape.
 * A trace made before the storied rewrite has no `stories` array at all and
 * reads as ground-floor-only (its top-level `polys` mirror), same as every
 * other reader of this field; never a story it never actually drew.
 */
export function tracePolysForStory(trace: unknown, floorIndex: number): Pt[][] | null {
  if (!trace || typeof trace !== "object") return null;
  const t = trace as RawTrace;
  const story = t.stories?.[floorIndex];
  if (story && Array.isArray(story.polys) && story.polys.length > 0) return story.polys;
  if (floorIndex === 0 && Array.isArray(t.polys) && t.polys.length > 0) return t.polys;
  return null;
}
