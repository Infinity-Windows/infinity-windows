// The Studio's "Flat" view (owner ask, 2026-08-20): every wall of the
// current floor laid out side by side in real-world proportion, editable —
// "build the unwrapped model … and be able to move windows and doors
// around on it by dragging them." Same walking-order + labeled-divider
// idea the map's flat view already uses (lib/fitview/fitviewRenderer.ts's
// flattenHouse): walk the walls in connectivity order, one closed loop per
// building, so a traced multi-mass building shows as clearly divided
// groups instead of two buildings' walls shuffled together.
//
// Framework/vendor-free on purpose — ModelStudio.tsx (and its
// FlatElevationsView) is the untested glue that reads the live Blueprint3d
// model through lib/modelstudio/core.d.ts and turns it into the plain
// shapes below; this module is the tested logic underneath that glue.

export interface FlatCorner {
  id: string;
  x: number;
  y: number;
}

export interface FlatWall {
  id: string;
  corner1: string;
  corner2: string;
  heightCm: number;
}

export interface WalkedWall extends FlatWall {
  /** True when this wall is walked corner2 → corner1 — the opposite of how
   * it's stored — so the loop still reads in one consistent direction. */
  reversed: boolean;
  /** 0-based: a second disconnected loop of walls is a second building
   * (owner design: multiple disconnected loops = multiple buildings, same
   * idea the map's flat view uses). Numbered in the order each loop's
   * first wall appears in `walls`. */
  loop: number;
}

/**
 * Connectivity walk over a floor's walls: chain wall-to-wall through shared
 * corners, one closed loop per building. Multiple disconnected loops walk
 * independently, each getting its own `loop` index.
 *
 * Every real floor's corners have exactly two walls (a closed perimeter),
 * so the walk is deterministic for the box/L/multi-loop shapes floors
 * actually trace. Two robustness notes, both exercised in the tests rather
 * than left as assumptions:
 *  - A branch (3+ walls sharing one corner) picks the first unvisited
 *    candidate in `walls` order — real floors don't branch, so this is a
 *    defined tie-break, not a modeled case.
 *  - An OPEN chain (a hand-drawn wall run never closed into a loop) still
 *    walks correctly: the walk runs both forward AND backward from its
 *    arbitrary starting wall, so it doesn't matter that the outer loop
 *    picked a wall in the middle of the run rather than at an end.
 */
export function wallWalkOrder(corners: FlatCorner[], walls: FlatWall[]): WalkedWall[] {
  const cornerIds = new Set(corners.map((c) => c.id));
  const validWalls = walls.filter((w) => cornerIds.has(w.corner1) && cornerIds.has(w.corner2));

  const byCorner = new Map<string, FlatWall[]>();
  const touch = (id: string, w: FlatWall) => {
    const list = byCorner.get(id);
    if (list) list.push(w);
    else byCorner.set(id, [w]);
  };
  for (const w of validWalls) {
    touch(w.corner1, w);
    touch(w.corner2, w);
  }

  const visited = new Set<string>();
  const result: WalkedWall[] = [];
  const guard = validWalls.length + 2;
  let loop = 0;

  for (const seed of validWalls) {
    if (visited.has(seed.id)) continue;
    visited.add(seed.id);
    const chain: WalkedWall[] = [{ ...seed, reversed: false, loop }];

    // Forward: extend from the seed's corner2 outward.
    let lead = seed.corner2;
    for (let i = 0; i < guard; i++) {
      const next = (byCorner.get(lead) ?? []).find((w) => !visited.has(w.id));
      if (!next) break;
      visited.add(next.id);
      const reversed = next.corner2 === lead;
      chain.push({ ...next, reversed, loop });
      lead = reversed ? next.corner1 : next.corner2;
      if (lead === seed.corner1) break; // closed the loop
    }

    // Backward: extend from the seed's corner1 outward, prepending. Only
    // does anything when the forward walk above didn't already close the
    // loop — i.e. an open chain.
    let trail = seed.corner1;
    for (let i = 0; i < guard; i++) {
      const prev = (byCorner.get(trail) ?? []).find((w) => !visited.has(w.id));
      if (!prev) break;
      visited.add(prev.id);
      const reversed = prev.corner1 === trail;
      chain.unshift({ ...prev, reversed, loop });
      trail = reversed ? prev.corner2 : prev.corner1;
    }

    result.push(...chain);
    loop += 1;
  }

  return result;
}

export interface FlatLayoutItem {
  id: string;
  name: string;
  kind: string;
  /** This item's LEFT edge, cm from the wall's stored corner1 — always
   * measured in the wall's own stored direction; flatLayout flips it for a
   * `reversed` wall so the whole loop still reads left-to-right. */
  offsetFromCorner1Cm: number;
  widthCm: number;
  heightCm: number;
  /** Height off the floor — together with heightCm, where the rectangle
   * sits vertically in its wall panel. */
  sillCm: number;
}

export interface FlatLayoutWallInput {
  id: string;
  lengthCm: number;
  heightCm: number;
  loop: number;
  reversed: boolean;
  items: FlatLayoutItem[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlatItemRect {
  id: string;
  name: string;
  kind: string;
  /** Wall-panel-local: (0,0) is that panel's own top-left corner. */
  rect: Rect;
}

export interface FlatWallPanel {
  wallId: string;
  loop: number;
  /** Row-content px, absolute — the same space dropTarget's dragX lives in. */
  x: number;
  width: number;
  height: number;
  lengthCm: number;
  heightCm: number;
  items: FlatItemRect[];
}

export interface FlatLayout {
  scale: number;
  /** Tallest panel, px — the basis the caller fits to ~60% of stage height. */
  maxHeight: number;
  totalWidth: number;
  panels: FlatWallPanel[];
}

/** Gap between two consecutive wall panels of the SAME building. */
export const WALL_GAP_PX = 14;
/** Wider gap between one building's last wall and the next building's
 * first — where the labeled divider (owner design) renders. */
export const BUILDING_GAP_PX = 56;

/**
 * Panel + item rects for a horizontal scroll row, at a caller-chosen scale
 * (px per cm — the ~60%-of-stage-height fit lives in the component, since
 * it needs a DOM measurement this pure function can't take). `walls` is
 * expected in walk order (wallWalkOrder's output, enriched with each
 * wall's real length + its items) — flatLayout itself only lays out and
 * flips for `reversed`; it never reorders.
 */
export function flatLayout(walls: FlatLayoutWallInput[], scale: number): FlatLayout {
  const panels: FlatWallPanel[] = [];
  let x = 0;
  let maxHeight = 0;
  let prevLoop: number | null = null;

  for (const w of walls) {
    if (prevLoop !== null) x += w.loop !== prevLoop ? BUILDING_GAP_PX : WALL_GAP_PX;
    const width = w.lengthCm * scale;
    const height = w.heightCm * scale;
    if (height > maxHeight) maxHeight = height;

    const items: FlatItemRect[] = w.items.map((it) => {
      const rawLeft = it.offsetFromCorner1Cm;
      const leftCm = w.reversed ? w.lengthCm - rawLeft - it.widthCm : rawLeft;
      const topCm = w.heightCm - (it.sillCm + it.heightCm);
      return {
        id: it.id,
        name: it.name,
        kind: it.kind,
        rect: {
          x: leftCm * scale,
          y: topCm * scale,
          width: it.widthCm * scale,
          height: it.heightCm * scale,
        },
      };
    });

    panels.push({
      wallId: w.id,
      loop: w.loop,
      x,
      width,
      height,
      lengthCm: w.lengthCm,
      heightCm: w.heightCm,
      items,
    });
    x += width;
    prevLoop = w.loop;
  }

  return { scale, maxHeight, totalWidth: x, panels };
}

export interface DropTarget {
  wallId: string;
  /** Clamped left-edge offset within the target wall, cm. */
  offsetCm: number;
}

/**
 * Which wall a drag lands on, and where — the same computation drives the
 * live ghost on every pointermove and the commit on release, so dragging
 * never "jumps" between preview and drop.
 *
 * `dragLeftX` is the dragged item's proposed LEFT edge in row-content px
 * (the same space FlatWallPanel.x lives in — i.e. already corrected for
 * horizontal scroll). The item's CENTER, not its left edge, decides which
 * panel owns the drag — that's what lets a drag that crosses a wall
 * boundary re-home the item onto the neighboring panel exactly at the
 * boundary's midpoint rather than only once the whole item has crossed.
 * Once a panel is chosen, the offset clamps to [0, panel width − item
 * width] so the item can never render or commit hanging off a wall's end.
 */
export function dropTarget(
  layout: FlatLayout,
  dragLeftX: number,
  itemWidthCm: number,
): DropTarget | null {
  if (layout.panels.length === 0) return null;
  const widthPx = itemWidthCm * layout.scale;
  const centerX = dragLeftX + widthPx / 2;

  let best = layout.panels[0];
  let bestD = Infinity;
  for (const p of layout.panels) {
    const d =
      centerX < p.x ? p.x - centerX : centerX > p.x + p.width ? centerX - (p.x + p.width) : 0;
    if (d < bestD) {
      bestD = d;
      best = p;
      if (d === 0) break; // inside a panel — nothing beats that
    }
  }

  const maxLeftPx = Math.max(0, best.width - widthPx);
  const leftPx = Math.min(Math.max(0, dragLeftX - best.x), maxLeftPx);
  return { wallId: best.wallId, offsetCm: leftPx / layout.scale };
}
