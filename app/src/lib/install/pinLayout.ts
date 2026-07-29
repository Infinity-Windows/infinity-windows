// Nudging overlapping map pins apart so a dense wall stays countable.
//
// Black Desert has 42 marks on one page and Pecan 57; several sit within a few
// millimetres of each other on the plan, so at any usable dot size they stack
// into an unreadable blob. This spreads a cluster along its own principal axis —
// which for marks on a wall IS the wall — so the fan-out follows the building
// instead of scattering.
//
// Two rules keep it honest:
//   - Displacement is capped, so a pin still points at its own window. A pin
//     that lies is worse than a pin that overlaps.
//   - It is purely visual. The stored pin_x/pin_y are never touched.
//
// Deterministic: same pins in any order produce the same layout.

export interface LayoutPin {
  id: string;
  x: number;
  y: number;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface SeparateOptions {
  /** Centre-to-centre spacing to aim for, as a fraction of page width. */
  minDist: number;
  /** Page aspect, so vertical distance is measured as it looks on screen. */
  aspect: number;
  /** How far a pin may be moved from the truth. Defaults to 1.5 × minDist. */
  maxShift?: number;
}

/** Union-find, so clustering does not depend on the order pins arrive in. */
function findRoot(parent: number[], i: number): number {
  let root = i;
  while (parent[root] !== root) root = parent[root];
  let node = i;
  while (parent[node] !== node) {
    const next = parent[node];
    parent[node] = root;
    node = next;
  }
  return root;
}

/**
 * Dominant direction of a point set, as a unit vector. For marks along a wall
 * this is the wall's direction; for a shapeless blob it falls back to
 * horizontal, which spreads pins the way a phone has room to spare.
 */
function principalAxis(points: LayoutPoint[]): LayoutPoint {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (Math.abs(sxy) < 1e-12) {
    return syy > sxx ? { x: 0, y: 1 } : { x: 1, y: 0 };
  }
  // Larger eigenvalue of the 2×2 covariance matrix.
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (trace * trace) / 4 - det);
  const lambda = trace / 2 + Math.sqrt(disc);
  const vx = sxy;
  const vy = lambda - sxx;
  const len = Math.hypot(vx, vy);
  if (len < 1e-12) return { x: 1, y: 0 };
  // Normalize sign so the axis does not flip with input order.
  const sign = vx < 0 || (vx === 0 && vy < 0) ? -1 : 1;
  return { x: (sign * vx) / len, y: (sign * vy) / len };
}

/**
 * Display positions for a set of pins, with overlapping ones fanned apart.
 * Returns a position for every input pin; isolated pins come back untouched.
 */
export function separatePins(
  pins: LayoutPin[],
  options: SeparateOptions,
): Map<string, LayoutPoint> {
  const result = new Map<string, LayoutPoint>();
  if (pins.length === 0) return result;
  const aspect = options.aspect > 0 ? options.aspect : 0.7;
  const minDist = options.minDist > 0 ? options.minDist : 0;
  const maxShift = options.maxShift ?? options.minDist * 1.5;

  // Stable order: position first, id last. Never the caller's array order.
  const sorted = [...pins].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );
  for (const p of sorted) result.set(p.id, { x: p.x, y: p.y });
  if (minDist <= 0 || sorted.length < 2) return result;

  // Distances are compared in display space, where a circle looks like one.
  const disp = sorted.map((p) => ({ x: p.x, y: p.y * aspect }));
  const parent = sorted.map((_, i) => i);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (Math.hypot(disp[i].x - disp[j].x, disp[i].y - disp[j].y) < minDist) {
        const a = findRoot(parent, i);
        const b = findRoot(parent, j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = findRoot(parent, i);
    const members = clusters.get(root);
    if (members) members.push(i);
    else clusters.set(root, [i]);
  }

  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const points = members.map((i) => disp[i]);
    const axis = principalAxis(points);
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    // Lay them out in the order they already appear along the wall, so marks
    // stay in sequence rather than shuffling.
    const ordered = [...members].sort((a, b) => {
      const pa = (disp[a].x - cx) * axis.x + (disp[a].y - cy) * axis.y;
      const pb = (disp[b].x - cx) * axis.x + (disp[b].y - cy) * axis.y;
      return pa - pb || sorted[a].id.localeCompare(sorted[b].id);
    });
    const span = (ordered.length - 1) / 2;
    ordered.forEach((index, slot) => {
      const offset = (slot - span) * minDist;
      let nx = cx + axis.x * offset;
      let ny = cy + axis.y * offset;
      // Never move a pin further than the cap from where it really is.
      const shiftX = nx - disp[index].x;
      const shiftY = ny - disp[index].y;
      const shift = Math.hypot(shiftX, shiftY);
      if (shift > maxShift && shift > 1e-12) {
        const k = maxShift / shift;
        nx = disp[index].x + shiftX * k;
        ny = disp[index].y + shiftY * k;
      }
      result.set(sorted[index].id, {
        x: Math.min(1, Math.max(0, nx)),
        y: Math.min(1, Math.max(0, ny / aspect)),
      });
    });
  }

  return result;
}
