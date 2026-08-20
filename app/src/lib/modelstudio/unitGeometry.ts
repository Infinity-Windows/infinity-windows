// Parametric unit geometry: a placed window/door renders its REAL
// configuration — outer frame, a mullion between every panel, glass per
// panel — instead of a stretched placeholder mesh (owner report: "window 16
// needs six vertical panels, not two horizontal panes"). Frame and mullion
// widths are per-unit editable. Built from composed boxes; the CSG/HD pass
// later swaps materials, not this layout math.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  cornerLegs,
  panelsWidthMm,
  rowHeightsCm,
  slideCountOf,
  unitTiers,
  type CornerSource,
  type UnitConfig,
  type UnitPanel,
  type UnitTier,
} from "./units";

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
 * Frame + glass hex per color choice (Studio 100x #47). "white" is
 * load-bearing: it's byte-for-byte the hardcoded hex this file used before
 * frameColor existed, so an absent/undefined choice (every unit built
 * before this field, and every catalog unit that never picks a color)
 * renders pixel-identical to today.
 */
export const FRAME_COLOR_HEXES: Record<
  NonNullable<UnitConfig["frameColor"]>,
  { frame: number; glass: number }
> = {
  white: { frame: 0xf4f1ec, glass: 0x9fc4d4 },
  bronze: { frame: 0x5c4630, glass: 0x8a7a5c },
  black: { frame: 0x2a2a2a, glass: 0x6e7d82 },
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
 * panel wraps). Returns null for flat units. Takes a `CornerSource` (not
 * the full `UnitConfig`) so the SAME rule applies to one tier of a
 * multi-tier unit — every existing caller already passes a full
 * UnitConfig, which satisfies it unchanged.
 */
export function cornerGeometryInfo(
  config: CornerSource,
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

/**
 * A moving sash split out for animation: its own little geometry (glass +
 * sash bars) built RELATIVE to `origin` — the hinge stile for swings, the
 * panel centre for slides — so a pivot Group at `origin` animates it with
 * plain rotation/translation (three.js has no transform-origin).
 */
export interface MoverSpec {
  panelIndex: number;
  /** Which tier (unitTiers order, base = 0) this mover's panel belongs
   * to — tiers repeat panelIndex from 0, so telling two panels apart
   * across a multi-tier unit needs both. Optional: every hand-built
   * mover fixture that predates Studio 100x #22 (a single-tier unit) is
   * tier 0 and never had to say so. */
  tierIndex?: number;
  mechanism: Exclude<UnitPanel["mechanism"], "fixed">;
  direction: "left" | "right";
  /** Pivot position in unit-local space, cm. */
  origin: { x: number; y: number; z: number };
  /** Slide distance (slider/hung), cm — ONE panel-width of travel. */
  travelCm: number;
  /** Panel-widths of travel for multi-track sliders (1–8); 1 otherwise. */
  slideCount: number;
  geometry: THREE.BufferGeometry;
}

export function buildUnitGeometry(
  config: UnitConfig,
  opts: UnitGeometryOptions = {},
): {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  movers: MoverSpec[];
} {
  const frame = (opts.frameMm ?? UNIT_GEOMETRY_DEFAULTS.frameMm) * MM_TO_CM;
  const mull = (opts.mullionMm ?? UNIT_GEOMETRY_DEFAULTS.mullionMm) * MM_TO_CM;
  const depth = (opts.depthMm ?? UNIT_GEOMETRY_DEFAULTS.depthMm) * MM_TO_CM;

  const frameGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];
  const movers: MoverSpec[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  };

  /**
   * One TIER's full geometry (Studio 100x #22), built in its OWN local
   * frame — Y=0 at the tier's own vertical centre, byte-for-byte the same
   * math a single-tier unit always used — then every box's Y gets
   * `yOffset` added via the `at()` wrapper below. `yOffset` is the summed
   * height of every tier BELOW this one, so tier 0 (offset 0) renders
   * exactly where a flat unit always has, and each tier above stacks
   * directly on the one below it.
   *
   * MULTI-TIER 3D MOUNTING — read this before changing how tiers stack:
   * the unit's ITEM lives on its BASE tier's floor (unchanged: sill and
   * world position still come from the base tier alone, see
   * ModelStudio.tsx's item.position.y = sill + baseHeight/2). Tiers above
   * it are pure geometry stacked straight up through this function alone
   * — they are NOT cut into the floor shells above. Those shells are
   * separate, frozen meshes built without any knowledge of what pokes
   * through their floor, so a tall multi-tier unit can render behind or
   * inside an upper floor's walls. That occlusion is an ACCEPTED v1 limit
   * (owner-approved design): fixing it means teaching the floor-shell
   * builder about every unit that crosses a floor line, a separate piece
   * of work. Sill/height drag handles and the docked in-canvas pane-grid
   * palette (ModelStudio.tsx) are also base-tier-only in v1 — they still
   * write only the flat `panels`/`heightMm` fields, which mirror tier 0.
   */
  const buildTier = (
    tier: UnitTier,
    tierIdx: number,
    yOffset: number,
  ): { frameGeos: THREE.BufferGeometry[]; glassGeos: THREE.BufferGeometry[]; movers: MoverSpec[] } => {
    const H = tier.heightMm * MM_TO_CM;
    // Only the BASE tier has a pane grid today — UnitTier carries no
    // `rows` yet (no wizard step offers one above the base), so any tier
    // above it is always a single full-height row, same fallback
    // rowHeightsCm already uses for a flat unit with no grid.
    const rowsCm = tierIdx === 0 ? rowHeightsCm(config) : [tier.heightMm / 10];
    const tierFrame: THREE.BufferGeometry[] = [];
    const tierGlass: THREE.BufferGeometry[] = [];
    const tierMovers: MoverSpec[] = [];
    const at = (y: number) => y + yOffset;

    /**
     * One straight run of panels. `pushBox` maps run-space (u along the
     * run, v across the depth) into local space, so the same math builds
     * the wall-parallel main leg and the perpendicular wrap leg.
     *
     * Panels arrive in the order the DRAWING reads them — left → right as
     * seen from OUTSIDE (spec elevations are always the Outside View). An
     * item's local +x faces the outside viewer's left once attached to a
     * wall (verified empirically in e2e/studio-holes.spec.ts), so the
     * caller passes panels reversed for the main leg.
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
      // Movers split out only where run-space IS local space (the wall-
      // parallel legs); the corner wrap leg animates in a later slice.
      allowMovers = false,
    ) => {
      // Top and bottom rails, and the two end posts.
      pushBox(tierFrame, runW, frame, depth, 0, at(H / 2 - frame / 2));
      pushBox(tierFrame, runW, frame, depth, 0, at(-H / 2 + frame / 2));
      pushBox(tierFrame, frame, H - 2 * frame, depth, -runW / 2 + frame / 2, at(0));
      pushBox(tierFrame, frame, H - 2 * frame, depth, runW / 2 - frame / 2, at(0));
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
        // A moving panel's sash + glass split into their OWN geometry so a
        // pivot group can animate them. Origin: the hinge stile for swings
        // ("opens left" hinges the outside-left = higher-u edge), the panel
        // centre for slides.
        const moving = allowMovers && p.mechanism !== "fixed";
        const swing = p.mechanism === "casement" || p.mechanism === "bifold";
        const dir: "left" | "right" = p.direction === "right" ? "right" : "left";
        const originU = !moving
          ? 0
          : swing
            ? dir === "left"
              ? innerRight
              : innerLeft
            : (innerLeft + innerRight) / 2;
        const mFrame: THREE.BufferGeometry[] = [];
        const mGlass: THREE.BufferGeometry[] = [];
        const sashTo = (w: number, h: number, d: number, x: number, y: number) => {
          if (moving) mFrame.push(box(w, h, d, x - originU, y));
          else pushBox(tierFrame, w, h, d, x, at(y));
        };
        const glassTo = (w: number, h: number, d: number, x: number, y: number) => {
          if (moving) mGlass.push(box(w, h, d, x - originU, y));
          else pushBox(tierGlass, w, h, d, x, at(y));
        };
        if (sash > 0) {
          sashTo(gw, sash, depth * 0.7, (innerLeft + innerRight) / 2, gh / 2 - sash / 2);
          sashTo(gw, sash, depth * 0.7, (innerLeft + innerRight) / 2, -gh / 2 + sash / 2);
        }
        // One glass CELL per row (grid support): rows read top→bottom and
        // share their break lines across every column.
        let yTop = gh / 2 - sash;
        rowsCm.forEach((rh, ri) => {
          const isTopRow = ri === 0;
          const isBottomRow = ri === rowsCm.length - 1;
          // Row band scaled into the inner (glass) height.
          const bandH = (rh / H) * (gh - 2 * sash);
          const cellTop = yTop - (isTopRow ? 0 : mull / 2);
          const cellBottom = yTop - bandH + (isBottomRow ? 0 : mull / 2);
          const ch = Math.max(2, cellTop - cellBottom);
          glassTo(gw, ch, depth * 0.25, (innerLeft + innerRight) / 2, (cellTop + cellBottom) / 2);
          yTop -= bandH;
        });
        if (moving && (mFrame.length > 0 || mGlass.length > 0)) {
          const parts: THREE.BufferGeometry[] = [];
          if (mFrame.length > 0) parts.push(mergeGeometries(mFrame, false)!);
          if (mGlass.length > 0) parts.push(mergeGeometries(mGlass, false)!);
          const geometry = mergeGeometries(parts, true)!;
          // Single-part movers still need TWO groups so the shared
          // [frame, glass] material array indexes correctly.
          if (parts.length === 1 && mGlass.length > 0 && geometry.groups[0]) {
            geometry.groups[0].materialIndex = 1;
          }
          tierMovers.push({
            panelIndex: i,
            tierIndex: tierIdx,
            mechanism: p.mechanism as MoverSpec["mechanism"],
            direction: dir,
            // yOffset here, not 0: the mover's PIVOT GROUP carries this
            // tier's stack height; its own box geometry above stays built
            // relative to y=0, unaffected — the group's world position is
            // what moves it (ModelStudio.tsx sets group.position from
            // this origin verbatim).
            origin: { x: originU, y: yOffset, z: 0 },
            travelCm: gw * 0.85,
            slideCount: slideCountOf(p),
            geometry,
          });
        }
        if (!isLast) {
          pushBox(tierFrame, mull, H - 2 * frame, depth, u + pw, at(0));
        }
        u += pw;
      });
      // Full-width transom bars on each row boundary (shared mullion lines).
      let yCut = H / 2;
      for (let ri = 0; ri < rowsCm.length - 1; ri++) {
        yCut -= rowsCm[ri];
        pushBox(tierFrame, runW - 2 * frame, mull, depth, 0, at(yCut));
      }
    };

    const corner = cornerGeometryInfo(tier, opts);
    const legs = cornerLegs(tier);
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
        true,
      );
      // Wrap leg: perpendicular run behind the corner (local +z recedes
      // from the outside viewer — the adjacent wall runs that way). The
      // panel nearest the corner is the one that touches it in the
      // drawing.
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
      tierFrame.push(box(depth, H, depth, xC, at(0), 0));
    } else {
      const W = panelsWidthMm(tier.panels) * MM_TO_CM;
      buildRun(
        [...tier.panels].reverse(),
        W,
        (list, uLen, h, vLen, uC, y, vC = 0) =>
          list.push(box(uLen, h, vLen, uC, y, vC)),
        true,
      );
    }

    return { frameGeos: tierFrame, glassGeos: tierGlass, movers: tierMovers };
  };

  // Each tier is built centred on its OWN local 0 (half above, half
  // below — same as a flat unit always was), so stacking tier N directly
  // on tier N-1's top means offsetting tier N's centre by HALF of the
  // tier below's height plus HALF of its own — not the tier below's FULL
  // height, which would leave a gap (or overlap) whenever the two
  // tiers' heights differ.
  let yOffset = 0;
  let prevHalfH = 0;
  unitTiers(config).forEach((tier, tierIdx) => {
    const halfH = (tier.heightMm * MM_TO_CM) / 2;
    if (tierIdx > 0) yOffset += prevHalfH + halfH;
    const built = buildTier(tier, tierIdx, yOffset);
    frameGeos.push(...built.frameGeos);
    glassGeos.push(...built.glassGeos);
    movers.push(...built.movers);
    prevHalfH = halfH;
  });

  const merged = mergeGeometries(
    [
      mergeGeometries(frameGeos, false)!,
      mergeGeometries(glassGeos, false)!,
    ],
    true,
  )!;

  const hexes = FRAME_COLOR_HEXES[config.frameColor ?? "white"];
  const frameMat = new THREE.MeshLambertMaterial({
    color: hexes.frame,
    side: THREE.DoubleSide,
  });
  const glassMat = new THREE.MeshLambertMaterial({
    color: hexes.glass,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
  });
  return { geometry: merged, materials: [frameMat, glassMat], movers };
}
