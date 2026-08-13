// Parametric unit geometry: a placed window/door renders its REAL
// configuration — outer frame, a mullion between every panel, glass per
// panel — instead of a stretched placeholder mesh (owner report: "window 16
// needs six vertical panels, not two horizontal panes"). Frame and mullion
// widths are per-unit editable. Built from composed boxes; the CSG/HD pass
// later swaps materials, not this layout math.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { UnitConfig } from "./units";

const MM_TO_CM = 0.1;

export interface UnitGeometryOptions {
  /** Outer frame face width, mm. */
  frameMm?: number;
  /** Mullion (gap bar between panes) width, mm — the owner's "frame gap". */
  mullionMm?: number;
  /** Unit depth, mm. */
  depthMm?: number;
}

export const UNIT_GEOMETRY_DEFAULTS: Required<UnitGeometryOptions> = {
  frameMm: 50,
  mullionMm: 40,
  depthMm: 100,
};

/**
 * Geometry groups: material 0 = frame, 1 = glass. Origin at the unit's
 * centre (the item pipeline positions by centre), dimensions in cm to match
 * the blueprint world.
 */
export function buildUnitGeometry(
  config: UnitConfig,
  opts: UnitGeometryOptions = {},
): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  const frame = (opts.frameMm ?? UNIT_GEOMETRY_DEFAULTS.frameMm) * MM_TO_CM;
  const mull = (opts.mullionMm ?? UNIT_GEOMETRY_DEFAULTS.mullionMm) * MM_TO_CM;
  const depth = (opts.depthMm ?? UNIT_GEOMETRY_DEFAULTS.depthMm) * MM_TO_CM;
  const H = config.heightMm * MM_TO_CM;
  const W = config.panels.reduce((t, p) => t + p.widthMm, 0) * MM_TO_CM;

  const frameGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  };

  // Outer frame: top, bottom, left, right.
  frameGeos.push(box(W, frame, depth, 0, H / 2 - frame / 2));
  frameGeos.push(box(W, frame, depth, 0, -H / 2 + frame / 2));
  frameGeos.push(box(frame, H - 2 * frame, depth, -W / 2 + frame / 2, 0));
  frameGeos.push(box(frame, H - 2 * frame, depth, W / 2 - frame / 2, 0));

  // Panels in the order the DRAWING reads them — left → right as seen from
  // OUTSIDE (spec elevations are always the Outside View). An item's local
  // +x faces the outside viewer's left once it is attached to a wall
  // (verified empirically in e2e/studio-holes.spec.ts), so the config order
  // is laid out reversed along local x: glass pane per panel, mullion
  // between neighbours.
  const ordered = [...config.panels].reverse();
  let x = -W / 2;
  ordered.forEach((p, i) => {
    const pw = p.widthMm * MM_TO_CM;
    const isFirst = i === 0;
    const isLast = i === config.panels.length - 1;
    const innerLeft = x + (isFirst ? frame : mull / 2);
    const innerRight = x + pw - (isLast ? frame : mull / 2);
    const gw = Math.max(2, innerRight - innerLeft);
    const gh = H - 2 * frame;
    // Moving panels read as a pane in its own sash: slightly inset frame.
    const sash = p.mechanism === "fixed" ? 0 : frame * 0.6;
    if (sash > 0) {
      frameGeos.push(box(gw, sash, depth * 0.7, (innerLeft + innerRight) / 2, gh / 2 - sash / 2));
      frameGeos.push(box(gw, sash, depth * 0.7, (innerLeft + innerRight) / 2, -gh / 2 + sash / 2));
    }
    glassGeos.push(
      box(gw, gh - 2 * sash, depth * 0.25, (innerLeft + innerRight) / 2, 0),
    );
    if (!isLast) {
      frameGeos.push(box(mull, H - 2 * frame, depth, x + pw, 0));
    }
    x += pw;
  });

  const merged = mergeGeometries(
    [
      mergeGeometries(frameGeos, false)!,
      mergeGeometries(glassGeos, false)!,
    ],
    true,
  )!;

  const frameMat = new THREE.MeshLambertMaterial({
    color: 0xf4f1ec,
    side: THREE.DoubleSide,
  });
  const glassMat = new THREE.MeshLambertMaterial({
    color: 0x9fc4d4,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
  });
  return { geometry: merged, materials: [frameMat, glassMat] };
}
