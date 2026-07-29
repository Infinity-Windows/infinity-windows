// A building shape for jobs that have no traced outline.
//
// Every job is fully pinned long before anyone traces a footprint, and the pins
// sit ON the walls — so the pin cloud is already a ring in the rough shape of
// the building. Rasterizing that ring, filling its interior and tracing the
// result gives a footprint that "basically matches" the building without a PDF
// trace, an API call, or a foreman drawing anything.
//
// Deliberately coarse: this is a schematic a crew reads at a glance on a phone,
// not a survey. A 12-vertex right-angled polygon reads as a building; a faithful
// 200-vertex trace of the same pins reads as noise.
//
// Pure and deterministic — no DOM, no canvas, no network — so the same job
// always produces the same shape and the whole thing is unit-testable.

import {
  clampOutlinePoint,
  collapseCollinear,
  dedupeClosePoints,
  dilate,
  erode,
  fillHoles,
  isValidOutlinePolygon,
  largestComponent,
  rdp,
  snapRectilinear,
  traceOuterBoundary,
  type BuildingOutline,
  type OutlinePoint,
} from "./outline";

/** Grid cells across the page width. Cells stay square via the page aspect. */
const GRID_COLS = 26;
/**
 * Cells to grow each pin by. The ring has to close for `fillHoles` to find an
 * interior, and consecutive marks on one wall are rarely in touching cells.
 */
const PIN_DILATE = 2;
/** A ring needs enough marks to enclose anything; below this, use the box. */
const MIN_PINS_FOR_RING = 8;
/** Outward pad on the bounding-box fallback, as a fraction of page width. */
const BOX_PAD = 0.045;
/** Vertex budget for a shape that should read as a building, not a trace. */
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
 * A rough building footprint traced from the job's own pins.
 *
 * Pins are rasterized onto a coarse grid, grown until neighbours on the same
 * wall touch, then the enclosed interior is filled and the outer boundary
 * traced. Falls back to a padded bounding box when there are too few pins to
 * enclose anything, or when the traced ring turns out not to enclose anything.
 */
export function footprintFromPins(
  pins: FootprintPin[],
  aspect: number,
): BuildingOutline | null {
  const usable = pins.filter(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= 0 &&
      p.x <= 1 &&
      p.y >= 0 &&
      p.y <= 1,
  );
  if (usable.length === 0) return null;
  const safeAspect = aspect > 0 ? aspect : 0.7;
  if (usable.length < MIN_PINS_FOR_RING) {
    return boundingFootprint(usable, safeAspect);
  }

  const cols = GRID_COLS;
  const rows = Math.max(4, Math.round(GRID_COLS * safeAspect));
  const grid = new Uint8Array(rows * cols);
  for (const p of usable) {
    const c = Math.min(cols - 1, Math.max(0, Math.round(p.x * (cols - 1))));
    const r = Math.min(rows - 1, Math.max(0, Math.round(p.y * (rows - 1))));
    grid[r * cols + c] = 1;
  }

  // Grow to close the ring, fill the interior it now encloses, then shrink most
  // of the way back. Not shrinking at all puts the wall a full dilation radius
  // outside the marks; shrinking all the way puts it ON them, which leaves marks
  // stranded outside the building once the polygon is coarsened. One cell of
  // slack keeps every mark inside its own building, where a window belongs.
  const grown = dilate(grid, rows, cols, PIN_DILATE);
  const filled = fillHoles(grown, rows, cols);
  const shrunk = erode(filled, rows, cols, Math.max(1, PIN_DILATE - 1));
  const mass = largestComponent(shrunk, rows, cols)
    ? largestComponent(fillHoles(shrunk, rows, cols), rows, cols)
    : largestComponent(filled, rows, cols);
  if (!mass) return boundingFootprint(usable, safeAspect);

  const loop = traceOuterBoundary(mass, rows, cols);
  if (loop.length < 4) return boundingFootprint(usable, safeAspect);

  const points = loop.map(([c, r]) =>
    clampOutlinePoint({ x: c / cols, y: r / rows }),
  );
  const shaped = coarsen(points, MAX_FOOTPRINT_VERTICES, safeAspect);
  if (!isValidOutlinePolygon(shaped)) {
    return boundingFootprint(usable, safeAspect);
  }
  // A dilated ring that never closed fills to little more than the ring
  // itself; the box is a more honest shape than a blob in that case.
  if (polygonArea(shaped, safeAspect) < pinSpread(usable, safeAspect) * 0.35) {
    return boundingFootprint(usable, safeAspect);
  }
  return { points: shaped, pageAspect: safeAspect };
}

/** Where the drawn shape came from. Surfaced in the sheet header. */
export type FootprintSource = "saved" | "traced" | "pins";

export interface ResolvedFootprint {
  outline: BuildingOutline;
  source: FootprintSource;
}

/**
 * Pick the best available shape for a page: a saved outline, else the PDF
 * trace, else the job's own pins. There is no "no shape" branch by design —
 * the old fixed grey rectangle bore no relation to the building and told a
 * crew nothing.
 */
export function resolveFootprint(args: {
  saved?: BuildingOutline | null;
  traced?: BuildingOutline | null;
  pins: FootprintPin[];
  aspect: number;
}): ResolvedFootprint | null {
  const { saved, traced, pins } = args;
  const aspect = args.aspect > 0 ? args.aspect : 0.7;

  if (saved && isValidOutlinePolygon(saved.points)) {
    // A person drew or corrected this. Never second-guess it.
    return { outline: saved, source: "saved" };
  }

  if (traced && isValidOutlinePolygon(traced.points)) {
    const tracedAspect = traced.pageAspect > 0 ? traced.pageAspect : aspect;
    const points = coarsen(traced.points, MAX_FOOTPRINT_VERTICES, tracedAspect);
    if (isValidOutlinePolygon(points)) {
      return {
        outline: { points, pageAspect: tracedAspect },
        source: "traced",
      };
    }
  }

  const fromPins = footprintFromPins(pins, aspect);
  return fromPins ? { outline: fromPins, source: "pins" } : null;
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

/** Bounding-box area of the pins, in the same units as `polygonArea`. */
function pinSpread(pins: FootprintPin[], aspect: number): number {
  const xs = pins.map((p) => p.x);
  const ys = pins.map((p) => p.y);
  return (
    (Math.max(...xs) - Math.min(...xs)) *
    (Math.max(...ys) - Math.min(...ys)) *
    aspect
  );
}
