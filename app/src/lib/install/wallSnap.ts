// Turning marks into openings in walls.
//
// A window is a hole in a wall. The map drew walls as one polygon and marks as
// dots floating over it, with nothing connecting the two — so a job read as a
// building with 42 unexplained spots inside it. This decides which marks sit on
// a wall and hands back the gap geometry the CAD helpers already know how to
// draw (`outlinePathWithOpenings`, `OutlineFeatureLayer`), so the automatic
// footprint gets the same treatment a hand-drawn model already gets.
//
// The one rule that outranks looking good: a mark must never claim to be
// somewhere it isn't. A mark only becomes a wall opening when it is already
// close to a wall. Marks the extractor dumped in the middle of the page — most
// of Pecan's floor 3 — stay exactly where they are, as plain dots. Inventing a
// wall position for those would be a drawing that lies to a crew standing in
// the building.
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

function edgeLengths(points: OutlinePoint[], aspect: number): number[] {
  const h = 1000 * aspect;
  return points.map((p, i) => {
    const q = points[(i + 1) % points.length];
    return Math.hypot((q.x - p.x) * 1000, (q.y - p.y) * h);
  });
}

/**
 * Decide which marks are openings in walls, and where those openings sit.
 *
 * Returns gap geometry for the marks that are already on a wall, and the ids of
 * the ones that are not, which the caller should keep drawing as dots.
 */
export function snapOpeningsToWalls(args: {
  openings: SnapCandidate[];
  points: OutlinePoint[];
  aspect: number;
  maxDistance?: number;
}): WallSnapResult {
  const { openings, points } = args;
  const aspect = args.aspect > 0 ? args.aspect : 0.7;
  const maxDistance = args.maxDistance ?? WALL_SNAP_DISTANCE;
  const snapped = new Map<string, SnappedOpening>();
  const freeIds: string[] = [];
  if (points.length < 3 || openings.length === 0) {
    return { snapped, freeIds: openings.map((o) => o.id) };
  }

  const lengths = edgeLengths(points, aspect);
  // Group by wall first: gaps only ever collide with others on the same wall.
  const byEdge = new Map<number, { item: EdgeGapItem; cand: SnapCandidate; distance: number }[]>();
  for (const o of openings) {
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) {
      freeIds.push(o.id);
      continue;
    }
    const hit = nearestPointOnOutline(points, { x: o.x, y: o.y }, aspect);
    if (!hit || hit.dist > maxDistance) {
      freeIds.push(o.id);
      continue;
    }
    const width = o.kind === "door" ? DOOR_GAP_WIDTH : WINDOW_GAP_WIDTH;
    const row = {
      item: { id: o.id, center: hit.t * lengths[hit.edge], width },
      cand: o,
      distance: hit.dist,
    };
    const list = byEdge.get(hit.edge);
    if (list) list.push(row);
    else byEdge.set(hit.edge, [row]);
  }

  for (const [edge, rows] of byEdge) {
    const length = lengths[edge];
    if (length < MIN_GAP_WIDTH) {
      // A wall shorter than one opening cannot hold one.
      for (const row of rows) freeIds.push(row.cand.id);
      continue;
    }
    const laid = layoutEdgeGaps(
      length,
      rows.map((r) => r.item),
      {},
    );
    const byId = new Map(rows.map((r) => [r.cand.id, r]));
    for (const gap of laid) {
      const row = byId.get(gap.id);
      if (!row) continue;
      const t = length > 0 ? Math.min(1, Math.max(0, gap.center / length)) : 0;
      const opening: WallOpening = {
        id: gap.id,
        edge,
        t,
        width: gap.width,
        kind: row.cand.kind,
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
        distance: row.distance,
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
