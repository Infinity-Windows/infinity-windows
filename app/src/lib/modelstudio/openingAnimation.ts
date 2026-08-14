// Opening animations (owner spec, 2026-08-14): "a few models, the
// animation logic would always be the same... the only things that change
// are which direction they open." Sliders slide, casements/doors swing on
// their hinge, bi-folds fold, hung sash rises — direction from the same
// Opens-left/right choice the glyphs draw. One eased ticker, no library;
// the vendor renders on demand, so each frame pokes its dirty flag.

import type { MoverSpec } from "./unitGeometry";

export const OPEN_MS = 600;
const SWING_RAD = 1.75; // ~100°, reads as fully open
const FOLD_RAD = 1.4;

export interface MoverTransform {
  x: number;
  y: number;
  rotY: number;
}

/** PURE: where a mover sits at openness t ∈ [0,1]. Outside-left is local
 * +x (the pane-glyph convention), so "opens left" slides/swings positive. */
export function moverTransform(mover: MoverSpec, t: number): MoverTransform {
  const sign = mover.direction === "left" ? 1 : -1;
  switch (mover.mechanism) {
    case "slider":
      return { x: sign * mover.travelCm * t, y: 0, rotY: 0 };
    case "hung":
      return { x: 0, y: mover.travelCm * 0.9 * t, rotY: 0 };
    case "casement":
      // Hinge pivot sits at the stile; swing OUT (toward local -z, the
      // outside) — rotation sign follows the hinge side.
      return { x: 0, y: 0, rotY: sign * SWING_RAD * t };
    case "bifold":
      return { x: 0, y: 0, rotY: sign * FOLD_RAD * t };
    default:
      return { x: 0, y: 0, rotY: 0 };
  }
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface MoverGroupLike {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
  rotation: { y: number };
  userData: { mover?: MoverSpec; baseX?: number; baseY?: number };
}

interface AnimState {
  openness: number;
  target: number;
  raf: number | null;
}

const states = new WeakMap<object, AnimState>();

/**
 * Toggle a unit's sashes open/closed. `groups` are the pivot groups built
 * by the page (userData.mover + base position); `dirty()` pokes the
 * vendor's render loop each frame.
 */
export function toggleUnitOpening(
  key: object,
  groups: MoverGroupLike[],
  dirty: () => void,
): "opening" | "closing" | "none" {
  if (groups.length === 0) return "none";
  let st = states.get(key);
  if (!st) {
    st = { openness: 0, target: 0, raf: null };
    states.set(key, st);
  }
  st.target = st.target > 0.5 ? 0 : 1;
  if (st.raf == null) {
    let last = performance.now();
    const tick = (now: number) => {
      const s = st!;
      const dt = Math.min(50, now - last);
      last = now;
      const step = dt / OPEN_MS;
      s.openness =
        s.target > s.openness
          ? Math.min(s.target, s.openness + step)
          : Math.max(s.target, s.openness - step);
      const eased = easeInOutCubic(s.openness);
      for (const g of groups) {
        const mover = g.userData.mover;
        if (!mover) continue;
        const tr = moverTransform(mover, eased);
        g.position.set(
          (g.userData.baseX ?? 0) + tr.x,
          (g.userData.baseY ?? 0) + tr.y,
          g.position.z,
        );
        g.rotation.y = tr.rotY;
      }
      dirty();
      if (Math.abs(s.openness - s.target) > 0.001) {
        s.raf = requestAnimationFrame(tick);
      } else {
        s.raf = null;
      }
    };
    st.raf = requestAnimationFrame(tick);
  }
  return st.target > 0.5 ? "opening" : "closing";
}
