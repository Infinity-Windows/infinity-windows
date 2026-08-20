// Turning a saved Studio model into a picture of one mark's wall — a
// "synthetic elevation crop" (Studio 100x #36).
//
// The OCR-based elevation reference (lib/install/elevationViews.ts) reads a
// crew's pinned reference off the SCANNED plans: it only exists when the
// supplier's planset actually drew exterior elevation sheets, and only for
// marks whose callout survived the read. A job with a Studio model has a
// second, independent source for the same picture — point a camera at the
// wall the mark is really built on and take a snapshot.
//
// Split in two on purpose, because only half of this can be tested honestly:
//   • PLANNING (this file's first half) is pure data-in, data-out — which
//     wall a mark's item sits on, and the orthographic camera bounds that
//     frame it. No DOM, no WebGL, no vendor engine. Unit-tested below.
//   • CAPTURE (renderWallElevation) needs a real WebGL context to mean
//     anything, same as every other Studio render — it mounts the vendor
//     engine on a hidden offscreen element, points a camera per the plan
//     above, and reads back a PNG. Not unit-testable; covered by Playwright.

import {
  parseFloorLite,
  parseFloors,
  type LiteItem,
  type LiteWall,
} from "./floors";
import type { JobModel } from "./projects";
import type { UnitConfig } from "./units";

// --------------------------------------------------------------- planning

/** A mark's own footprint on the wall it's built into, plan cm. */
export interface MarkUnitRect {
  /** Distance along the wall from its start corner to the unit's centre. */
  xCm: number;
  /** Height of the unit's bottom edge off the floor. */
  sillCm: number;
  widthCm: number;
  heightCm: number;
}

/** One wall in plan space, cm, plus which way its OUTSIDE face is. */
export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  heightCm: number;
  /** Unit vector in the studio's XZ ground plane, pointing away from the
   * building — the side an elevation sheet actually draws. */
  outwardNormal: { x: number; z: number };
}

export interface MarkWallLocation {
  floorIndex: number;
  wall: WallSegment;
  unitRect: MarkUnitRect;
}

/** A blank window/door reference size, used only when a placed item somehow
 * carries no unitConfig (hand-added catalog item, corrupted save) — better
 * than a zero-size frame. */
const DEFAULT_UNIT_WIDTH_CM = 90;
const DEFAULT_UNIT_HEIGHT_CM = 120;

/** Nothing genuinely wall-mounted is ever farther than this from its own
 * wall. Same cutoff ModelStudio.tsx's own nearestWallTo uses for the live
 * vendor walls — this is the identical check over parseFloorLite's plain
 * data instead. */
const MAX_WALL_DISTANCE_CM = 200;

/**
 * Pull the mark code back out of an item's name — "Window 4A", "Door 12 ·
 * JOB-9" — the exact pattern fromProject.ts's catalogByMarkFrom already
 * uses to go the same direction, so every "what mark is this item" question
 * in the Studio agrees on the answer. PURE.
 */
function markTokenOf(itemName: unknown): string | null {
  if (typeof itemName !== "string") return null;
  const m = /^(?:Window|Door)\s+([^\s·]+)/.exec(itemName);
  return m ? m[1].toUpperCase() : null;
}

/** Perpendicular distance from a point to a segment, clamped to the
 * segment's own span, plus where along it (0..1) the closest point fell.
 * PURE. */
function distanceToSegment(
  px: number,
  py: number,
  wall: LiteWall,
): { distance: number; t: number } {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const lenSq = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - wall.x1) * dx + (py - wall.y1) * dy) / lenSq));
  const cx = wall.x1 + t * dx;
  const cy = wall.y1 + t * dy;
  return { distance: Math.hypot(px - cx, py - cy), t };
}

/** Center of every wall endpoint on a floor — a cheap stand-in for "inside
 * the building" that only needs the walls we already have. */
function floorCentroid(walls: LiteWall[]): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const w of walls) {
    sx += w.x1 + w.x2;
    sy += w.y1 + w.y2;
    n += 2;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

/**
 * Which way is "outside" for one wall: the perpendicular pointing away from
 * the floor's own centroid. Wrong only for a wall whose building is more
 * concave than convex at that exact point — good enough to pick a camera
 * side, not a load-bearing measurement. Plan (x,y) becomes studio world
 * (x,_,z) — confirmed at ModelStudio.tsx's own placement call, `{ x:
 * pl.xCm, y: pl.elevationCm, z: pl.yCm }`. PURE.
 */
function outwardNormalFor(
  wall: LiteWall,
  centroid: { x: number; y: number },
): { x: number; z: number } {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy) || 1;
  // The two perpendiculars of (dx,dy): (-dy,dx) and (dy,-dx).
  const nx = -dy / len;
  const ny = dx / len;
  const midX = (wall.x1 + wall.x2) / 2;
  const midY = (wall.y1 + wall.y2) / 2;
  const dot = nx * (midX - centroid.x) + ny * (midY - centroid.y);
  const sign = dot < 0 ? -1 : 1;
  return { x: nx * sign, z: ny * sign };
}

function unitRectFor(item: LiteItem, wall: LiteWall): MarkUnitRect {
  const { t } = distanceToSegment(item.x, item.y, wall);
  const wallLen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  const config = item.metadata.unitConfig as UnitConfig | undefined;
  const widthCm = config?.panels?.length
    ? config.panels.reduce((sum, p) => sum + p.widthMm, 0) / 10
    : DEFAULT_UNIT_WIDTH_CM;
  const heightCm = config?.heightMm ? config.heightMm / 10 : DEFAULT_UNIT_HEIGHT_CM;
  return {
    xCm: t * wallLen,
    sillCm: item.z - heightCm / 2,
    widthCm,
    heightCm,
  };
}

/**
 * Find the wall a mark's Studio item is built into, and the item's own
 * rectangle on that wall. Null when the model has no floors, no item whose
 * name resolves to this mark, or the nearest item to a wall isn't actually
 * near one (a stray, unattached item). Searches floors in order and stops
 * at the first that has the mark — a mark belongs to exactly one floor in
 * every job seen so far, so the first hit is the only one that matters.
 * PURE — no DOM, no vendor engine, safe to call on every render.
 */
export function findMarkWall(model: JobModel, markCode: string): MarkWallLocation | null {
  const wanted = markCode.trim().toUpperCase();
  if (!wanted) return null;
  const { floors } = parseFloors(model, "");

  for (let floorIndex = 0; floorIndex < floors.length; floorIndex++) {
    const { walls, items } = parseFloorLite(floors[floorIndex]);
    if (walls.length === 0 || items.length === 0) continue;

    const item = items.find((it) => markTokenOf(it.metadata.itemName) === wanted);
    if (!item) continue;

    let best: LiteWall | null = null;
    let bestDistance = Infinity;
    for (const wall of walls) {
      const { distance } = distanceToSegment(item.x, item.y, wall);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = wall;
      }
    }
    if (!best || bestDistance > MAX_WALL_DISTANCE_CM) return null;

    const centroid = floorCentroid(walls);
    return {
      floorIndex,
      wall: {
        x1: best.x1,
        y1: best.y1,
        x2: best.x2,
        y2: best.y2,
        heightCm: best.height,
        outwardNormal: outwardNormalFor(best, centroid),
      },
      unitRect: unitRectFor(item, best),
    };
  }
  return null;
}

/** Everything needed to build a THREE.OrthographicCamera square onto a
 * wall — plain numbers so the capture half only has to construct and point
 * a camera, never decide where. */
export interface ElevationFrame {
  /** Camera position, studio world cm. */
  position: { x: number; y: number; z: number };
  /** The wall's own centre — what the camera looks at. */
  lookAt: { x: number; y: number; z: number };
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

/**
 * An orthographic frame square onto one wall: centred on the wall, backed
 * off outward along its normal, bounds equal to the wall's own span
 * (length × height) padded by `margin` on every side — "the roofline, the
 * ground and the neighbouring windows", same reasoning
 * elevationViews.ts's regionCropBbox uses for the OCR crop. PURE.
 */
export function frameForWall(wall: WallSegment, margin = 0.1): ElevationFrame {
  const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  const midX = (wall.x1 + wall.x2) / 2;
  const midZ = (wall.y1 + wall.y2) / 2;
  const midY = wall.heightCm / 2;
  const standoff = Math.max(length, wall.heightCm, 100);
  return {
    position: {
      x: midX + wall.outwardNormal.x * standoff,
      y: midY,
      z: midZ + wall.outwardNormal.z * standoff,
    },
    lookAt: { x: midX, y: midY, z: midZ },
    left: -(length / 2) * (1 + margin),
    right: (length / 2) * (1 + margin),
    top: (wall.heightCm / 2) * (1 + margin),
    bottom: -(wall.heightCm / 2) * (1 + margin),
    near: 1,
    far: standoff * 2 + wall.heightCm,
  };
}
