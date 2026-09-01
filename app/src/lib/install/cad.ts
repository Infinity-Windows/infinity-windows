// CAD-lite drawing helpers for the manual plan editor: angle snapping,
// rectangle drag-out, divider lines, and wall openings (window/door symbols).
//
// Coordinates are normalized page space (x, y in 0..1). Geometry that cares
// about visual angles/distances works in "display" space — the SVG viewBox of
// 1000 × (1000 * aspect) — so a 45° line looks 45° on screen.

import { clampOutlinePoint, type OutlinePoint } from "./outline";

export interface DividerLine {
  id: string;
  a: OutlinePoint;
  b: OutlinePoint;
}

export interface WallOpening {
  id: string;
  /** Polygon edge index (vertex i → i+1, ring closed). */
  edge: number;
  /** 0..1 center position along that edge. */
  t: number;
  /** Gap width in viewBox units (page width = 1000). */
  width: number;
  kind: "window" | "door";
}

export interface OutlineFeatures {
  dividers: DividerLine[];
  wallOpenings: WallOpening[];
}

export const EMPTY_FEATURES: OutlineFeatures = {
  dividers: [],
  wallOpenings: [],
};

export function newFeatureId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `f${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

function parsePoint(raw: unknown): OutlinePoint | null {
  if (!raw || typeof raw !== "object") return null;
  const x = Number((raw as { x?: unknown }).x);
  const y = Number((raw as { y?: unknown }).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return clampOutlinePoint({ x, y });
}

/** Tolerant parse of the jsonb `features` column (or local copy). */
export function parseOutlineFeatures(raw: unknown): OutlineFeatures {
  if (!raw || typeof raw !== "object") return { dividers: [], wallOpenings: [] };
  const o = raw as { dividers?: unknown; wallOpenings?: unknown };
  const dividers: DividerLine[] = [];
  if (Array.isArray(o.dividers)) {
    for (const d of o.dividers) {
      if (!d || typeof d !== "object") continue;
      const a = parsePoint((d as { a?: unknown }).a);
      const b = parsePoint((d as { b?: unknown }).b);
      if (!a || !b) continue;
      const id =
        typeof (d as { id?: unknown }).id === "string"
          ? ((d as { id: string }).id)
          : newFeatureId();
      dividers.push({ id, a, b });
    }
  }
  const wallOpenings: WallOpening[] = [];
  if (Array.isArray(o.wallOpenings)) {
    for (const w of o.wallOpenings) {
      if (!w || typeof w !== "object") continue;
      const rec = w as {
        id?: unknown;
        edge?: unknown;
        t?: unknown;
        width?: unknown;
        kind?: unknown;
      };
      const edge = Number(rec.edge);
      const t = Number(rec.t);
      const width = Number(rec.width);
      const kind = rec.kind === "door" ? "door" : "window";
      if (!Number.isInteger(edge) || edge < 0) continue;
      if (!Number.isFinite(t) || !Number.isFinite(width) || width <= 0) continue;
      wallOpenings.push({
        id: typeof rec.id === "string" ? rec.id : newFeatureId(),
        edge,
        t: Math.min(1, Math.max(0, t)),
        width,
        kind,
      });
    }
  }
  return { dividers, wallOpenings };
}

export function hasFeatures(features: OutlineFeatures): boolean {
  return features.dividers.length > 0 || features.wallOpenings.length > 0;
}

/**
 * PlanModelEditor's own save writes only what it knows — dividers and wall
 * openings — but the `features` jsonb column also carries `fitview` (the
 * tracer's survey model, calibration, wave N's northDeg) and `modelstudio`
 * (the 3D builder's model). Saving `patch` on its own as the whole column
 * would wipe both wholesale; this merges it into the outline row's raw
 * features instead, same shallow spread ModelStudio.tsx's save() already
 * uses (`{ ...prev, modelstudio: body }`) — every OTHER top-level key rides
 * through untouched, only `dividers`/`wallOpenings` change.
 */
export function mergeOutlineFeatures(
  prevRaw: unknown,
  patch: OutlineFeatures,
): Record<string, unknown> {
  const prev =
    prevRaw && typeof prevRaw === "object" ? (prevRaw as Record<string, unknown>) : {};
  return { ...prev, ...patch };
}

// --- display-space conversion ---

function toDisp(p: OutlinePoint, aspect: number): { x: number; y: number } {
  return { x: p.x * 1000, y: p.y * 1000 * aspect };
}

function fromDisp(x: number, y: number, aspect: number): OutlinePoint {
  return clampOutlinePoint({ x: x / 1000, y: y / (1000 * aspect) });
}

// --- angle snapping ---

export const SNAP_TOLERANCE_DEG = 2;

/**
 * Snap `next` so the segment prev→next locks perfectly horizontal or vertical
 * when it is within `tolDeg` of 0°/180° or 90°/270° on screen.
 */
export function snapPointToAxis(
  prev: OutlinePoint,
  next: OutlinePoint,
  aspect: number,
  tolDeg: number = SNAP_TOLERANCE_DEG,
): OutlinePoint {
  const a = toDisp(prev, aspect);
  const b = toDisp(next, aspect);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-6) return next;
  const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI; // 0..90
  if (deg <= tolDeg) return { x: next.x, y: prev.y };
  if (90 - deg <= tolDeg) return { x: prev.x, y: next.y };
  return next;
}

/** Snap a dragged vertex against both of its ring neighbors. */
export function snapVertexToNeighbors(
  points: OutlinePoint[],
  index: number,
  next: OutlinePoint,
  aspect: number,
  tolDeg: number = SNAP_TOLERANCE_DEG,
): OutlinePoint {
  if (points.length < 2) return next;
  const prev = points[(index - 1 + points.length) % points.length];
  const after = points[(index + 1) % points.length];
  let snapped = snapPointToAxis(prev, next, aspect, tolDeg);
  if (points.length > 2) snapped = snapPointToAxis(after, snapped, aspect, tolDeg);
  return snapped;
}

// --- rectangle tool ---

/**
 * Axis-aligned rectangle from a drag anchor to the cursor. With `square`,
 * width and height lock equal in display space (a visually perfect square).
 */
export function rectFromDrag(
  anchor: OutlinePoint,
  cursor: OutlinePoint,
  square: boolean,
  aspect: number,
): OutlinePoint[] {
  const a = toDisp(anchor, aspect);
  const c = toDisp(cursor, aspect);
  let w = c.x - a.x;
  let h = c.y - a.y;
  if (square) {
    const size = Math.max(Math.abs(w), Math.abs(h));
    w = (w < 0 ? -1 : 1) * size;
    h = (h < 0 ? -1 : 1) * size;
  }
  const p2 = fromDisp(a.x + w, a.y, aspect);
  const p3 = fromDisp(a.x + w, a.y + h, aspect);
  const p4 = fromDisp(a.x, a.y + h, aspect);
  return [clampOutlinePoint(anchor), p2, p3, p4];
}

// --- outline hit-testing ---

export interface OutlineEdgeHit {
  edge: number;
  t: number;
  point: OutlinePoint;
  /** Distance from the probe to the edge, in viewBox units. */
  dist: number;
}

/** Closest point on the closed outline ring to `p`. */
export function nearestPointOnOutline(
  points: OutlinePoint[],
  p: OutlinePoint,
  aspect: number,
): OutlineEdgeHit | null {
  if (points.length < 2) return null;
  const probe = toDisp(p, aspect);
  let best: OutlineEdgeHit | null = null;
  for (let i = 0; i < points.length; i++) {
    const a = toDisp(points[i], aspect);
    const b = toDisp(points[(i + 1) % points.length], aspect);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) continue;
    const t = Math.min(
      1,
      Math.max(0, ((probe.x - a.x) * dx + (probe.y - a.y) * dy) / lenSq),
    );
    const qx = a.x + t * dx;
    const qy = a.y + t * dy;
    const dist = Math.hypot(probe.x - qx, probe.y - qy);
    if (!best || dist < best.dist) {
      best = { edge: i, t, point: fromDisp(qx, qy, aspect), dist };
    }
  }
  return best;
}

/** Distance (viewBox units) from probe point to a divider segment. */
export function distanceToDivider(
  divider: DividerLine,
  p: OutlinePoint,
  aspect: number,
): number {
  const a = toDisp(divider.a, aspect);
  const b = toDisp(divider.b, aspect);
  const probe = toDisp(p, aspect);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t =
    lenSq < 1e-9
      ? 0
      : Math.min(1, Math.max(0, ((probe.x - a.x) * dx + (probe.y - a.y) * dy) / lenSq));
  return Math.hypot(probe.x - (a.x + t * dx), probe.y - (a.y + t * dy));
}

// --- wall opening geometry + gapped outline path ---

export interface WallOpeningGeometry {
  id: string;
  kind: "window" | "door";
  /** Gap endpoints in viewBox coords. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Unit normal pointing toward the polygon interior. */
  nx: number;
  ny: number;
  width: number;
}

function centroidDisp(points: OutlinePoint[], aspect: number) {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    const d = toDisp(p, aspect);
    cx += d.x;
    cy += d.y;
  }
  return { x: cx / points.length, y: cy / points.length };
}

/** Resolve a stored wall opening into gap endpoints + interior normal. */
export function wallOpeningGeometry(
  points: OutlinePoint[],
  aspect: number,
  opening: WallOpening,
): WallOpeningGeometry | null {
  if (points.length < 2 || opening.edge >= points.length) return null;
  const a = toDisp(points[opening.edge], aspect);
  const b = toDisp(points[(opening.edge + 1) % points.length], aspect);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return null;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const half = Math.min(opening.width, len * 0.9) / 2;
  // Keep the whole gap on the edge.
  const center = Math.min(len - half, Math.max(half, opening.t * len));
  const ax = a.x + ux * (center - half);
  const ay = a.y + uy * (center - half);
  const bx = a.x + ux * (center + half);
  const by = a.y + uy * (center + half);
  let nx = -uy;
  let ny = ux;
  const c = centroidDisp(points, aspect);
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  if (nx * (c.x - mx) + ny * (c.y - my) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { id: opening.id, kind: opening.kind, ax, ay, bx, by, nx, ny, width: half * 2 };
}

/**
 * Stroke path for the outline ring with wall-opening gaps cut out of it.
 * Returns null when the polygon is too small. (Fill the plain ring separately.)
 */
export function outlinePathWithOpenings(
  points: OutlinePoint[],
  aspect: number,
  openings: WallOpening[],
): string | null {
  if (points.length < 3) return null;
  const parts: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = toDisp(points[i], aspect);
    const b = toDisp(points[(i + 1) % points.length], aspect);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const gaps = openings
      .filter((o) => o.edge === i)
      .map((o) => {
        const half = Math.min(o.width, len * 0.9) / 2;
        const center = Math.min(len - half, Math.max(half, o.t * len));
        return { from: center - half, to: center + half };
      })
      .sort((g1, g2) => g1.from - g2.from);
    let cursor = 0;
    for (const gap of gaps) {
      if (gap.from > cursor + 0.5) {
        parts.push(
          `M${(a.x + ux * cursor).toFixed(1)} ${(a.y + uy * cursor).toFixed(1)} ` +
            `L${(a.x + ux * gap.from).toFixed(1)} ${(a.y + uy * gap.from).toFixed(1)}`,
        );
      }
      cursor = Math.max(cursor, gap.to);
    }
    if (cursor < len - 0.5) {
      parts.push(
        `M${(a.x + ux * cursor).toFixed(1)} ${(a.y + uy * cursor).toFixed(1)} ` +
          `L${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
