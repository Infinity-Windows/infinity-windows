// Parametric unit geometry: a placed window/door renders its REAL
// configuration — outer frame, a mullion between every panel, glass per
// panel — instead of a stretched placeholder mesh (owner report: "window 16
// needs six vertical panels, not two horizontal panes"). Frame and mullion
// widths are per-unit editable. Built from composed boxes; the CSG/HD pass
// later swaps materials, not this layout math.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cornerLegs, panelsWidthMm, type UnitConfig, type UnitPanel } from "./units";

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
export interface CornerGeometryInfo {
  /** Main-leg width, cm (the leg that attaches to a wall). */
  mainWcm: number;
  /** Wrap-leg width, cm (the leg that turns 90° at a building corner). */
  wrapWcm: number;
  /** +1: wrap at the outside-left (+x) end; -1: outside-right (-x). */
  sideSign: 1 | -1;
  depthCm: number;
}

/**
 * Which leg attaches to a wall, and which wraps. The LONGER leg is the
 * main one (window 16's four-panel run stays on its wall; the 30¼" left
 * panel wraps). Returns null for flat units.
 */
export function cornerGeometryInfo(
  config: UnitConfig,
  opts: UnitGeometryOptions = {},
): CornerGeometryInfo | null {
  const legs = cornerLegs(config);
  if (!legs) return null;
  const depth = (opts.depthMm ?? UNIT_GEOMETRY_DEFAULTS.depthMm) * MM_TO_CM;
  const leftW = panelsWidthMm(legs.left) * MM_TO_CM;
  const rightW = panelsWidthMm(legs.right) * MM_TO_CM;
  // Outside-left is local +x (see the layout note below): a wrapping LEFT
  // group sits at +x, a wrapping RIGHT group at -x.
  if (leftW <= rightW) {
    return { mainWcm: rightW, wrapWcm: leftW, sideSign: 1, depthCm: depth };
  }
  return { mainWcm: leftW, wrapWcm: rightW, sideSign: -1, depthCm: depth };
}

export function buildUnitGeometry(
  config: UnitConfig,
  opts: UnitGeometryOptions = {},
): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  const frame = (opts.frameMm ?? UNIT_GEOMETRY_DEFAULTS.frameMm) * MM_TO_CM;
  const mull = (opts.mullionMm ?? UNIT_GEOMETRY_DEFAULTS.mullionMm) * MM_TO_CM;
  const depth = (opts.depthMm ?? UNIT_GEOMETRY_DEFAULTS.depthMm) * MM_TO_CM;
  const H = config.heightMm * MM_TO_CM;

  const frameGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  };

  /**
   * One straight run of panels. `pushBox` maps run-space (u along the run,
   * v across the depth) into local space, so the same math builds the
   * wall-parallel main leg and the perpendicular wrap leg.
   *
   * Panels arrive in the order the DRAWING reads them — left → right as
   * seen from OUTSIDE (spec elevations are always the Outside View). An
   * item's local +x faces the outside viewer's left once attached to a
   * wall (verified empirically in e2e/studio-holes.spec.ts), so the caller
   * passes panels reversed for the main leg.
   */
  const buildRun = (
    panels: UnitPanel[],
    runW: number,
    pushBox: (
      list: THREE.BufferGeometry[],
      uLen: number,
      h: number,
      vLen: number,
      uC: number,
      y: number,
      vC?: number,
    ) => void,
  ) => {
    // Top and bottom rails, and the two end posts.
    pushBox(frameGeos, runW, frame, depth, 0, H / 2 - frame / 2);
    pushBox(frameGeos, runW, frame, depth, 0, -H / 2 + frame / 2);
    pushBox(frameGeos, frame, H - 2 * frame, depth, -runW / 2 + frame / 2, 0);
    pushBox(frameGeos, frame, H - 2 * frame, depth, runW / 2 - frame / 2, 0);
    let u = -runW / 2;
    panels.forEach((p, i) => {
      const pw = p.widthMm * MM_TO_CM;
      const isFirst = i === 0;
      const isLast = i === panels.length - 1;
      const innerLeft = u + (isFirst ? frame : mull / 2);
      const innerRight = u + pw - (isLast ? frame : mull / 2);
      const gw = Math.max(2, innerRight - innerLeft);
      const gh = H - 2 * frame;
      // Moving panels read as a pane in its own sash: slightly inset frame.
      const sash = p.mechanism === "fixed" ? 0 : frame * 0.6;
      if (sash > 0) {
        pushBox(frameGeos, gw, sash, depth * 0.7, (innerLeft + innerRight) / 2, gh / 2 - sash / 2);
        pushBox(frameGeos, gw, sash, depth * 0.7, (innerLeft + innerRight) / 2, -gh / 2 + sash / 2);
      }
      pushBox(glassGeos, gw, gh - 2 * sash, depth * 0.25, (innerLeft + innerRight) / 2, 0);
      if (!isLast) {
        pushBox(frameGeos, mull, H - 2 * frame, depth, u + pw, 0);
      }
      u += pw;
    });
  };

  const corner = cornerGeometryInfo(config, opts);
  const legs = cornerLegs(config);
  if (corner && legs) {
    const mainPanels = corner.sideSign === 1 ? legs.right : legs.left;
    const wrapPanels = corner.sideSign === 1 ? legs.left : legs.right;
    const mainW = corner.mainWcm;
    const wrapW = corner.wrapWcm;
    // Main leg along x, centred at the origin, drawing order reversed.
    buildRun(
      [...mainPanels].reverse(),
      mainW,
      (list, uLen, h, vLen, uC, y, vC = 0) =>
        list.push(box(uLen, h, vLen, uC, y, vC)),
    );
    // Wrap leg: perpendicular run behind the corner (local +z recedes from
    // the outside viewer — the adjacent wall runs that way). The panel
    // nearest the corner is the one that touches it in the drawing.
    const xC = corner.sideSign * (mainW / 2);
    const zStart = depth / 2;
    const nearCornerFirst =
      corner.sideSign === 1 ? [...wrapPanels].reverse() : wrapPanels;
    buildRun(
      nearCornerFirst,
      wrapW,
      (list, uLen, h, vLen, uC, y, vC = 0) =>
        list.push(
          box(vLen, h, uLen, xC + vC, y, zStart + wrapW / 2 + uC),
        ),
    );
    // Corner post joining the legs.
    frameGeos.push(box(depth, H, depth, xC, 0, 0));
  } else {
    const W = panelsWidthMm(config.panels) * MM_TO_CM;
    buildRun(
      [...config.panels].reverse(),
      W,
      (list, uLen, h, vLen, uC, y, vC = 0) =>
        list.push(box(uLen, h, vLen, uC, y, vC)),
    );
  }

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
