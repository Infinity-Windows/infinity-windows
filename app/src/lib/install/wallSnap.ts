// Turning marks into openings in walls.
//
// A window is a hole in a wall. The map drew walls as one polygon and marks as
// dots floating over it, with nothing connecting the two — so a job read as a
// building with 42 unexplained spots inside it. This decides which marks sit on
// a wall and hands back the gap geometry the CAD helpers already know how to
// draw (`outlinePathWithOpenings`, `OutlineFeatureLayer`), so the automatic
// footprint gets the same treatment a hand-drawn model already gets.
//
// Every mark becomes an opening in a wall. There is no such thing as a window
// in the middle of a room, so a dot floating inside the building is not a
// cautious drawing — it is a wrong one, and it made the map useless: Black
// Desert drew 42 spots hanging in mid-air inside its own outline.
//
// This used to only snap a mark that was already near a wall, on the principle
// that moving the others would invent a position we do not know. That had it
// backwards. The x/y on most marks is not a survey — it is wherever the
// extractor happened to drop the callout on the sheet, in rows across the
// middle for most of Pecan's floor 3. Preserving that is preserving noise, and
// drawing the noise inside the building states something that cannot be true.
//
// So a mark's position is treated as a hint about where it belongs around the
// building, not as a coordinate. Marks that really are near a wall stay put;
// the rest are spread around the perimeter in the order the plan implies. The
// number on the opening is what identifies it, and tapping it is what tells you
// what it is.
//
// Pure and deterministic. Distances are viewBox units, where the page is 1000
// wide and 1000 × aspect tall, matching cad.ts.

import {
  nearestPointOnOutline,
  wallOpeningGeometry,
  type WallOpening,
} from "./cad";
import { clampOutlinePoint, type OutlinePoint } from "./outline";

/**
 * How close a mark must be to a wall to be drawn as an opening in it. 55 units
 * is 5.5% of the page width — about 20px on a 390px phone, i.e. "already on the
 * wall, give or take the width of the dot". Anything further away is a mark
 * whose real position we do not know.
 */
export const WALL_SNAP_DISTANCE = 55;

/** Gap widths in viewBox units. Doors are wider, as they are in life. */
export const WINDOW_GAP_WIDTH = 46;
export const DOOR_GAP_WIDTH = 62;
/**
 * The share of its own stretch of wall an opening may take.
 *
 * This is the number that decides whether the drawing reads as a building or as
 * a ring of holes. Each mark gets one slot of the perimeter — perimeter divided
 * by however many marks are on the floor — and may fill at most this much of
 * it, so the rest stays wall. Without it a 58-mark floor asks for 3074 units of
 * opening on a 2869-unit perimeter, every gap shrinks to fit, and the building
 * comes out with no wall left between its windows.
 *
 * Magnifying that does not help: zoom scales the wall and the holes together,
 * so the proportion a crowded floor looks wrong at is the proportion it looks
 * wrong at from any distance. The fix has to be here.
 */
const MAX_OPENING_SLOT_SHARE = 0.45;
/** Never shrink a gap below this, or it stops reading as an opening. */
export const MIN_GAP_WIDTH = 20;
/**
 * The floor when a crowded wall leaves no choice. Below the comfortable
 * minimum, but a narrow notch in the right place beats either sliding an
 * opening away from its mark or letting two gaps merge and erase the wall.
 */
const HARD_MIN_GAP_WIDTH = 9;
/** Wall left between neighbouring gaps, so two openings never merge into one. */
const GAP_MARGIN = 7;
/**
 * Wall kept between a gap and the corner at each end of it. Neighbours on the
 * same wall are spaced by `GAP_MARGIN`, but two openings either side of a
 * corner are on different walls and never see each other — without this they
 * meet at the corner and merge, which is the one thing the spacing exists to
 * prevent. Wide enough to clear the swing and jamb lines the symbols draw out
 * from the wall, not just the gap itself.
 */
const CORNER_INSET = 36;
/**
 * How far along its wall a gap may be nudged to stop it colliding with its
 * neighbour. Same principle as the pin separation: a small, bounded shift is
 * worth it for legibility; a large one would be a lie.
 */
const MAX_SLIDE = 34;

export interface SnapCandidate {
  id: string;
  /** Normalized pin position, 0..1. */
  x: number;
  y: number;
  kind: "window" | "door";
  /**
   * True when a foreman dragged this mark to where the opening really is.
   *
   * Everything else came off the planset extractor, which reads a drawing row
   * by row: those coordinates say where a number was printed on a sheet, not
   * where a window is in a wall. Openings on a wall nobody has touched are
   * spaced out evenly, because an even row of windows is no less true than the
   * clump the extractor produced and is far easier to read.
   */
  placed?: boolean;
}

export interface SnappedOpening extends WallOpening {
  /** Where on the wall this opening ended up, normalized. */
  point: OutlinePoint;
  /** Distance from the mark to its wall, in viewBox units. */
  distance: number;
}

export interface WallSnapResult {
  /** Openings drawn as gaps in a wall, keyed by opening id. */
  snapped: Map<string, SnappedOpening>;
  /** Marks left as free-floating dots because no wall was near enough. */
  freeIds: string[];
}

export interface EdgeGapItem {
  id: string;
  /** Desired centre along the edge, in viewBox units from the edge start. */
  center: number;
  width: number;
}

/**
 * Space gaps along one wall so they do not overlap.
 *
 * Widths shrink first — a narrower window is honest, a moved one less so — and
 * only then are centres nudged, by at most `maxSlide`. Deterministic: input is
 * sorted by position before anything moves.
 */
export function layoutEdgeGaps(
  edgeLength: number,
  items: EdgeGapItem[],
  options: { maxSlide?: number; margin?: number } = {},
): EdgeGapItem[] {
  if (items.length === 0) return [];
  const maxSlide = options.maxSlide ?? MAX_SLIDE;
  const margin = options.margin ?? GAP_MARGIN;
  const sorted = [...items].sort(
    (a, b) => a.center - b.center || a.id.localeCompare(b.id),
  );

  // Shrink everything by one factor if the wall cannot hold the gaps at full
  // width. Uniform, so no single opening looks arbitrarily squeezed.
  const wanted =
    sorted.reduce((sum, it) => sum + it.width, 0) + margin * sorted.length;
  const usable = edgeLength * 0.92;
  let widths = sorted.map((it) => {
    if (wanted <= usable || wanted <= 0) return it.width;
    const scaled = it.width * (usable / wanted);
    return Math.max(Math.min(MIN_GAP_WIDTH, it.width), scaled);
  });

  const place = (w: number[]): number[] => {
    // Left-to-right pass, then right-to-left: the classic label-placement fix.
    const centers = sorted.map((it) => it.center);
    for (let i = 0; i < sorted.length; i++) {
      const half = w[i] / 2;
      let lo = half;
      if (i > 0) lo = Math.max(lo, centers[i - 1] + w[i - 1] / 2 + margin + half);
      if (centers[i] < lo) centers[i] = lo;
    }
    for (let i = sorted.length - 1; i >= 0; i--) {
      const half = w[i] / 2;
      let hi = edgeLength - half;
      if (i < sorted.length - 1) {
        hi = Math.min(hi, centers[i + 1] - w[i + 1] / 2 - margin - half);
      }
      if (centers[i] > hi) centers[i] = hi;
    }
    // Then refuse to move any gap further than the cap from its own mark, and
    // keep it on the wall.
    return centers.map((center, i) => {
      const shift = center - sorted[i].center;
      const capped =
        Math.abs(shift) > maxSlide
          ? sorted[i].center + Math.sign(shift) * maxSlide
          : center;
      const half = w[i] / 2;
      return Math.min(
        Math.max(capped, half),
        Math.max(half, edgeLength - half),
      );
    });
  };

  const overlaps = (centers: number[], w: number[]): boolean => {
    for (let i = 1; i < centers.length; i++) {
      if (centers[i] - w[i] / 2 < centers[i - 1] + w[i - 1] / 2 - 1e-6) {
        return true;
      }
    }
    return false;
  };

  // The slide cap can leave gaps still overlapping — and two merged gaps erase
  // the wall between them, which is worse than either problem it was solving.
  // So when that happens, shrink instead of sliding further: a narrow opening is
  // still in the right place, whereas a slid one is not.
  let centers = place(widths);
  for (let attempt = 0; attempt < 10 && overlaps(centers, widths); attempt++) {
    if (widths.every((w) => w <= HARD_MIN_GAP_WIDTH + 1e-6)) break;
    widths = widths.map((w) => Math.max(HARD_MIN_GAP_WIDTH, w * 0.78));
    centers = place(widths);
  }

  return sorted.map((it, i) => ({
    id: it.id,
    center: centers[i],
    width: widths[i],
  }));
}

/**
 * Space gaps around the whole building rather than along one wall.
 *
 * The per-wall pass cannot help a wall that is asked to hold more openings than
 * it has length — and that is the normal case, because the marks arrive bunched
 * wherever the extractor left them. Going round the perimeter lets a crowded
 * stretch push its overflow onto the next wall instead of dropping it.
 *
 * Order is preserved: openings come out in the same sequence they went round
 * the building, so a page stays readable as you walk it. Positions move only
 * where they must — a stretch with room keeps what it was given.
 */
export function layoutPerimeterGaps(
  perimeter: number,
  items: EdgeGapItem[],
  options: { margin?: number } = {},
): EdgeGapItem[] {
  const n = items.length;
  if (n === 0 || perimeter <= 0) return [];
  const margin = options.margin ?? GAP_MARGIN;
  const wrap = (v: number) => ((v % perimeter) + perimeter) % perimeter;
  const sorted = [...items].sort(
    (a, b) => a.center - b.center || a.id.localeCompare(b.id),
  );
  if (n === 1) return [{ ...sorted[0], center: wrap(sorted[0].center) }];

  // Shrink everything by one factor if the building cannot hold the gaps at
  // full width, uniformly so no single opening looks arbitrarily squeezed.
  const wanted = sorted.reduce((sum, it) => sum + it.width + margin, 0);
  const usable = perimeter * 0.96;
  const scale = wanted > usable ? usable / wanted : 1;
  const widths = sorted.map((it) =>
    Math.max(HARD_MIN_GAP_WIDTH, it.width * scale),
  );

  // Room needed between each pair of neighbours, going round.
  const need = widths.map(
    (w, i) => (w + widths[(i + 1) % n]) / 2 + margin,
  );
  // What the marks themselves asked for, as gaps between neighbours.
  const desired: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    desired.push(sorted[i + 1].center - sorted[i].center);
  }
  desired.push(perimeter - (sorted[n - 1].center - sorted[0].center));

  /*
   * Give every pair the room it needs, and take it back from the pairs that had
   * room to spare, in proportion to how much they had. Where nothing has room
   * to spare, everything ends up evenly spaced — which is the right answer for
   * a page whose marks all landed in one strip.
   */
  const gaps = desired.map((d, i) => Math.max(d, need[i]));
  const owed = gaps.reduce((sum, d) => sum + d, 0) - perimeter;
  if (owed > 0) {
    const spare = gaps.map((d, i) => Math.max(0, d - need[i]));
    const totalSpare = spare.reduce((sum, s) => sum + s, 0);
    for (let i = 0; i < n; i++) {
      gaps[i] -= totalSpare > 0 ? (owed * spare[i]) / totalSpare : owed / n;
    }
  }

  // Walk the gaps back into positions, then rotate the whole ring so it sits as
  // close to where the marks asked as the spacing allows.
  const raw = [sorted[0].center];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1] + gaps[i - 1]);
  const drift =
    raw.reduce((sum, c, i) => sum + (c - sorted[i].center), 0) / n;

  return sorted.map((it, i) => ({
    id: it.id,
    center: wrap(raw[i] - drift),
    width: widths[i],
  }));
}

function edgeLengths(points: OutlinePoint[], aspect: number): number[] {
  const h = 1000 * aspect;
  return points.map((p, i) => {
    const q = points[(i + 1) % points.length];
    return Math.hypot((q.x - p.x) * 1000, (q.y - p.y) * h);
  });
}

/** Which wall a distance around the perimeter lands on, and where along it. */
function edgeAt(
  center: number,
  lengths: number[],
  starts: number[],
): { edge: number; t: number } {
  for (let i = lengths.length - 1; i >= 0; i--) {
    if (center >= starts[i] - 1e-9 && lengths[i] > 0) {
      return { edge: i, t: Math.min(1, (center - starts[i]) / lengths[i]) };
    }
  }
  return { edge: 0, t: 0 };
}

/**
 * Put every mark on a wall, and say where.
 *
 * Two passes. The first goes round the whole building, so a stretch of wall
 * asked to hold more openings than it can fit pushes the overflow onto its
 * neighbour instead of stacking them. The second tidies each wall individually,
 * which is where a gap gets kept clear of the corners it would otherwise run
 * past.
 *
 * `freeIds` is only ever non-empty when there is no building to put anything
 * on — no outline, or one too small to hold a single opening.
 */
export function snapOpeningsToWalls(args: {
  openings: SnapCandidate[];
  points: OutlinePoint[];
  aspect: number;
}): WallSnapResult {
  const { openings, points } = args;
  const aspect = args.aspect > 0 ? args.aspect : 0.7;
  const snapped = new Map<string, SnappedOpening>();
  const freeIds: string[] = [];
  if (points.length < 3 || openings.length === 0) {
    return { snapped, freeIds: openings.map((o) => o.id) };
  }

  const lengths = edgeLengths(points, aspect);
  const starts: number[] = [];
  let perimeter = 0;
  for (const length of lengths) {
    starts.push(perimeter);
    perimeter += length;
  }
  if (perimeter < MIN_GAP_WIDTH) {
    return { snapped, freeIds: openings.map((o) => o.id) };
  }

  /*
   * Where each mark asks to be, as a distance round the building. A mark
   * already sitting on a wall asks for that spot and usually keeps it; one
   * dropped in the middle of the page asks for the nearest wall, which is a
   * guess — but a guess on a wall beats a certainty floating in a room.
   */
  /*
   * How wide an opening may be drawn on THIS floor. Both kinds shrink by the
   * same factor, so a door stays wider than a window on a crowded floor rather
   * than every opening collapsing to one size.
   */
  const slot = perimeter / openings.length;
  const widthScale = Math.min(
    1,
    Math.max(HARD_MIN_GAP_WIDTH, slot * MAX_OPENING_SLOT_SHARE) /
      DOOR_GAP_WIDTH,
  );

  const kinds = new Map<string, "window" | "door">();
  const distances = new Map<string, number>();
  const placedIds = new Set(
    openings.filter((o) => o.placed).map((o) => o.id),
  );
  const items: EdgeGapItem[] = [];
  openings.forEach((o, index) => {
    kinds.set(o.id, o.kind);
    const hit = Number.isFinite(o.x) && Number.isFinite(o.y)
      ? nearestPointOnOutline(points, { x: o.x, y: o.y }, aspect)
      : null;
    distances.set(o.id, hit?.dist ?? Number.POSITIVE_INFINITY);
    items.push({
      id: o.id,
      // No usable position at all: take a slot in list order, so a job with no
      // pins still comes out spread evenly round the building.
      center: hit
        ? starts[hit.edge] + hit.t * lengths[hit.edge]
        : (index / openings.length) * perimeter,
      width:
        (o.kind === "door" ? DOOR_GAP_WIDTH : WINDOW_GAP_WIDTH) * widthScale,
    });
  });

  const spread = layoutPerimeterGaps(perimeter, items);

  // Second pass, per wall: keep each gap clear of its corners and of its
  // neighbours on that wall.
  const byEdge = new Map<number, EdgeGapItem[]>();
  for (const gap of spread) {
    const { edge, t } = edgeAt(gap.center, lengths, starts);
    const row = { id: gap.id, center: t * lengths[edge], width: gap.width };
    const list = byEdge.get(edge);
    if (list) list.push(row);
    else byEdge.set(edge, [row]);
  }

  for (const [edge, rows] of byEdge) {
    const length = lengths[edge];
    if (length < HARD_MIN_GAP_WIDTH) {
      // A wall too short to hold anything. The perimeter pass avoids sending
      // openings here, but a degenerate polygon can still have one.
      for (const row of rows) freeIds.push(row.id);
      continue;
    }
    // Lay the wall out as if it were shorter, then put the gaps back in the
    // middle of it: the simplest way to keep every opening off the corners.
    const inset = Math.min(
      CORNER_INSET,
      Math.max(0, (length - HARD_MIN_GAP_WIDTH) / 2),
    );
    const usable = length - inset * 2;

    /*
     * Black Desert's marks come off the extractor in rows, so a wall arrives
     * with fourteen of them piled into a third of its length and the rest of it
     * empty. That pile does not mean the windows are really side by side; it
     * means the extractor read a row of a drawing. Since the positions are
     * fiction either way, an evenly spaced row is the more honest drawing and
     * by far the easier one to tap.
     *
     * A wall where a foreman has dragged a mark is different — there the
     * positions were put in by someone who stood in front of the building, so
     * every opening on that wall keeps the spot it asks for.
     */
    const ordered = [...rows].sort(
      (a, b) => a.center - b.center || a.id.localeCompare(b.id),
    );
    const spreadEvenly =
      ordered.length > 1 && !ordered.some((r) => placedIds.has(r.id));

    const laid = layoutEdgeGaps(
      usable,
      ordered.map((r, i) => ({
        ...r,
        center: spreadEvenly
          ? (usable * (i + 0.5)) / ordered.length
          : r.center - inset,
      })),
      // Already positioned by the pass above, so this one is free to move a gap
      // as far as it needs to keep it inside its own wall.
      { maxSlide: length },
    );
    for (const gap of laid) {
      const center = gap.center + inset;
      const opening: WallOpening = {
        id: gap.id,
        edge,
        t: length > 0 ? Math.min(1, Math.max(0, center / length)) : 0,
        width: Math.min(gap.width, length * 0.9),
        kind: kinds.get(gap.id) ?? "window",
      };
      const geo = wallOpeningGeometry(points, aspect, opening);
      if (!geo) {
        freeIds.push(gap.id);
        continue;
      }
      snapped.set(gap.id, {
        ...opening,
        point: clampOutlinePoint({
          x: (geo.ax + geo.bx) / 2 / 1000,
          y: (geo.ay + geo.by) / 2 / (1000 * aspect),
        }),
        distance: distances.get(gap.id) ?? 0,
      });
    }
  }

  return { snapped, freeIds };
}

/**
 * Where the touch handle for a wall opening goes: just inside the room, clear
 * of the gap so the window or door symbol stays visible. The handle is next to
 * its own opening rather than on top of it — the gap is the precise thing, the
 * dot is what a thumb aims at.
 */
export function wallPinPosition(
  points: OutlinePoint[],
  aspect: number,
  opening: SnappedOpening,
): OutlinePoint | null {
  const geo = wallOpeningGeometry(points, aspect, opening);
  if (!geo) return null;
  const h = 1000 * (aspect > 0 ? aspect : 0.7);
  // Clear of the symbol's own lines, which straddle the wall, and roughly where
  // the mark already was: callouts on these plans sit about this far inside the
  // wall they annotate.
  const offset = opening.width / 2 + 22;
  return clampOutlinePoint({
    x: ((geo.ax + geo.bx) / 2 + geo.nx * offset) / 1000,
    y: ((geo.ay + geo.by) / 2 + geo.ny * offset) / h,
  });
}
