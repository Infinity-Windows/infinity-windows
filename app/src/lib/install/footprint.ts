// A building shape for jobs that have no traced outline.
//
// The shape is a plain rectangle around the marks. It used to try to trace a
// ring through the pin cloud on the theory that pins sit on walls and so already
// outline the building. They mostly do not — the positions come from wherever
// the extractor dropped each callout on the sheet — so the ring traced the noise
// and produced a lumpy shape that looked like a broken building rather than a
// simple one. A rectangle claims nothing it cannot back up, and the openings cut
// into it read far better along long straight walls than they did around a blob.
//
// Pure and deterministic — no DOM, no canvas, no network — so the same job
// always produces the same shape and the whole thing is unit-testable.

import {
  clampOutlinePoint,
  collapseCollinear,
  dedupeClosePoints,
  isValidOutlinePolygon,
  rdp,
  snapRectilinear,
  type BuildingOutline,
  type OutlinePoint,
} from "./outline";

/** Outward pad on the bounding box, as a fraction of page width. */
const BOX_PAD = 0.045;
/** Vertex budget when simplifying a real PDF trace. */
export const MAX_FOOTPRINT_VERTICES = 12;
/**
 * Snap edges within this many degrees of an axis to exactly axis-aligned.
 * Deliberately generous: buildings are overwhelmingly right-angled, and a
 * schematic with a few slightly-wrong square corners reads far better than one
 * with believable-but-odd diagonal walls.
 */
const RECTILINEAR_TOL_DEG = 24;

/** Anything with a normalized position on the plan — an opening's pin. */
export interface FootprintPin {
  x: number;
  y: number;
}

/**
 * Reduce a polygon to at most `maxVertices` right-angled corners.
 *
 * Simplification runs in display space (x * 1000, y * 1000 * aspect) so a
 * tolerance means the same thing horizontally and vertically on screen —
 * otherwise a tall page collapses its vertical detail first.
 */
export function coarsen(
  points: OutlinePoint[],
  maxVertices: number = MAX_FOOTPRINT_VERTICES,
  aspect: number = 1,
): OutlinePoint[] {
  if (points.length === 0) return [];
  const h = 1000 * (aspect || 1);
  let disp: [number, number][] = points.map((p) => [p.x * 1000, p.y * h]);

  let simplified = collapseCollinear(disp);
  let eps = 6;
  // Climb the tolerance until the vertex budget is met. Bounded: eps grows
  // geometrically, so this terminates well before the polygon degenerates.
  for (let guard = 0; guard < 40 && simplified.length > maxVertices; guard++) {
    simplified = rdp(disp, eps);
    eps *= 1.6;
  }

  let snapped = snapRectilinear(simplified, RECTILINEAR_TOL_DEG);
  snapped = collapseCollinear(snapped);
  snapped = dedupeClosePoints(snapped, 4);
  // Snapping can re-introduce a vertex over budget; one more pass settles it.
  if (snapped.length > maxVertices) {
    snapped = collapseCollinear(rdp(snapped, eps));
  }

  const result = snapped.map((p) =>
    clampOutlinePoint({ x: p[0] / 1000, y: p[1] / h }),
  );
  return isValidOutlinePolygon(result) ? result : points;
}

/** Axis-aligned box around the pins, padded outward so pins sit on the wall. */
export function boundingFootprint(
  pins: FootprintPin[],
  aspect: number,
): BuildingOutline | null {
  const usable = pins.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (usable.length === 0) return null;
  const xs = usable.map((p) => p.x);
  const ys = usable.map((p) => p.y);
  // Pad in display space so the visual margin is even on both axes.
  const padY = aspect > 0 ? BOX_PAD / aspect : BOX_PAD;
  const minX = Math.min(...xs) - BOX_PAD;
  const maxX = Math.max(...xs) + BOX_PAD;
  const minY = Math.min(...ys) - padY;
  const maxY = Math.max(...ys) + padY;
  const points = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ].map(clampOutlinePoint);
  return isValidOutlinePolygon(points) ? { points, pageAspect: aspect } : null;
}

/**
 * A traced polygon spanning more than this fraction of the page in BOTH axes is
 * the sheet border, not a building. Black Desert's PDF traces to 0.91 × 0.90 —
 * the drawing frame and title block. Pecan's real footprint is 0.68 × 0.83.
 */
const SHEET_BORDER_SPAN = 0.86;
/** Nor should a building cover most of its own sheet. */
const MAX_TRACE_PAGE_AREA = 0.65;

/**
 * Whether a traced polygon is plausibly a building rather than the page it was
 * drawn on. Without this the ladder happily saves a job's drawing frame as its
 * building shape, which is worse than the pins it would otherwise use — and,
 * being saved, permanent.
 */
export function isPlausibleBuildingTrace(
  points: OutlinePoint[],
  aspect: number,
): boolean {
  if (!isValidOutlinePolygon(points)) return false;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (spanX >= SHEET_BORDER_SPAN && spanY >= SHEET_BORDER_SPAN) return false;
  // The page is 1 wide by `aspect` tall in these units, so its area IS aspect.
  const safeAspect = aspect > 0 ? aspect : 0.7;
  return polygonArea(points, safeAspect) / safeAspect <= MAX_TRACE_PAGE_AREA;
}

/** Where the drawn shape came from. Surfaced in the sheet header. */
export type FootprintSource = "saved" | "traced" | "pins";

export interface ResolvedFootprint {
  outline: BuildingOutline;
  source: FootprintSource;
}

/**
 * Pick the shape for a page: a hand-drawn outline if someone made one, otherwise
 * a plain box around the marks.
 *
 * A PDF trace used to sit between those two. It looked clever and was wrong
 * often enough — sheet borders, title blocks, noisy vectors — that the map spent
 * more time apologising for the shape than helping anyone install a window. The
 * openings are what matter; a rectangle is honest about what we know.
 */
export function resolveFootprint(args: {
  saved?: BuildingOutline | null;
  traced?: BuildingOutline | null;
  pins: FootprintPin[];
  aspect: number;
}): ResolvedFootprint | null {
  const { saved, pins } = args;
  const aspect = args.aspect > 0 ? args.aspect : 0.7;

  if (saved && isValidOutlinePolygon(saved.points)) {
    // A person drew or corrected this. Never second-guess it.
    return { outline: saved, source: "saved" };
  }

  // `traced` is accepted in the args so callers do not have to change, but it
  // is no longer used. Keeping the parameter avoids a silent drift between the
  // call site and this function the next time someone wires a CAD path back in.
  void args.traced;

  const box = boundingFootprint(
    pins.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    aspect,
  );
  return box ? { outline: box, source: "pins" } : null;
}

/** Absolute polygon area in display units (page width = 1). */
export function polygonArea(points: OutlinePoint[], aspect: number): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * (b.y * aspect) - b.x * (a.y * aspect);
  }
  return Math.abs(sum / 2);
}
