// Seed the Model Studio from what the app already knows: the fit-view job
// (traced footprint in meters + windows placed per wall) becomes a
// blueprint3d floorplan (corners/walls in cm) plus world-positioned window
// items. SPIKE-scope: ground story only, first N openings — enough to judge
// the foundation on a real building, not a demo house.

import { elevationsOf } from "../fitview/fitviewRenderer";
import { normalizeMarkCode } from "../fitview/adapter";
import {
  indexSpecsByMark,
  specForOpeningCode,
  type ProjectMarkSpec,
} from "../install/specs";
import {
  cornerLegs,
  panelsWidthMm,
  specToUnitConfig,
  type UnitConfig,
} from "./units";

interface SeedWindow {
  id: string;
  /** World position, cm (blueprint plan axes: x east, y south). */
  x: number;
  y: number;
  /** Sill height + half the unit height, cm — the item's centre. */
  elevation: number;
  /** Rotation around vertical, radians, aligned to its wall. */
  rotation: number;
  widthCm: number;
  heightCm: number;
}

export interface StudioSeed {
  serialized: string;
  windows: SeedWindow[];
}

interface FitJobLike {
  building: {
    footprints?: { x: number; z: number }[][];
    stories?: { footprints: { x: number; z: number }[][] }[];
  };
  windows: {
    id: string;
    elev: string;
    x: number; // meters along the wall
    y: number; // sill, meters
    w: number; // mm
    h: number; // mm
  }[];
}

const M_TO_CM = 100;

/** Ground-story footprints in meters, whichever shape the job carries. */
function groundFootprints(job: FitJobLike): { x: number; z: number }[][] {
  const st = job.building.stories;
  if (Array.isArray(st) && st.length > 0 && st[0].footprints?.length) {
    return st[0].footprints;
  }
  return job.building.footprints ?? [];
}

export interface PullPlacement {
  itemName: string;
  config: UnitConfig;
  /** World plan position, cm (same axes as the seed). */
  xCm: number;
  yCm: number;
  /** Floor-relative centre height, cm (each studio floor edits at y=0). */
  elevationCm: number;
  rotation: number;
  /** 0-based studio floor (fitview story n → floor n−1). */
  floorIndex: number;
  /** The unit was slid along its wall to fit inside the segment. */
  shifted?: boolean;
  /** The wall is SHORTER than the unit: grow it by this much (cm) — the
   * last-resort width change (owner: height more often than width). */
  lengthenWallCm?: number;
}

export interface PullResult {
  placements: PullPlacement[];
  /** Marks skipped because they're already placed somewhere. */
  alreadyPlaced: number;
  /** Marks with no wall to land on (bad/missing elevation key). */
  noWall: number;
}

/**
 * "Pull from plans" (owner spec, 2026-08-14): every window the plans know
 * about, auto-placed as a PARAMETRIC, mark-labeled, editable unit — the
 * map's auto-placement, but in the Studio. Add-only by contract: anything
 * already placed (by an earlier pull or by hand) is skipped, so re-pulls
 * only fill gaps and never move a unit the owner has edited.
 *
 * Config priority per mark: the company catalog's refined unit when one
 * exists (`catalogByMark`, keyed by BASE mark — the hand-split window 16
 * with its corner beats the raw spec), then the spec row via
 * specToUnitConfig, then a one-fixed-panel fallback from the window's own
 * plan size — every mark still lands parametric and editable.
 */
export function buildStudioPull(
  job: FitJobLike,
  specs: ProjectMarkSpec[],
  existingNames: Set<string>,
  catalogByMark: Map<string, UnitConfig> = new Map(),
): PullResult {
  const elevs = elevationsOf(job) as {
    key: string; x1: number; z1: number; x2: number; z2: number; len: number;
    A: number; story?: number; base?: number;
  }[];
  const byKey = new Map(elevs.map((e) => [e.key, e]));
  const specIndex = indexSpecsByMark(specs);

  const placements: PullPlacement[] = [];
  let alreadyPlaced = 0;
  let noWall = 0;

  for (const w of job.windows) {
    if (existingNames.has(w.id)) {
      alreadyPlaced += 1;
      continue;
    }
    const e = byKey.get(w.elev);
    if (!e || !(e.len > 0)) {
      noWall += 1;
      continue;
    }
    const mark = normalizeMarkCode(w.id);
    const spec = specForOpeningCode(specIndex, mark);
    const config: UnitConfig =
      catalogByMark.get(markKeyOf(mark)) ??
      (spec ? specToUnitConfig(spec) : null) ?? {
        kind: "window",
        heightMm: w.h,
        panels: [{ widthMm: w.w, mechanism: "fixed" }],
      };

    // A corner unit fits its wall by the MAIN leg only (the longer one —
    // cornerGeometryInfo's rule); the wrap leg turns 90° down the next
    // wall, so counting it inflated the width, slid corner units to
    // mid-wall and grew walls that were never short. snapIfCorner seats
    // the wrap end exactly at the wall end after placement.
    const legs = cornerLegs(config);
    const wMm = legs
      ? Math.max(panelsWidthMm(legs.left), panelsWidthMm(legs.right))
      : panelsWidthMm(config.panels);
    const hMm = config.heightMm;
    // Fit-to-wall (owner report: "windows sticking past walls"): slide the
    // centre so the whole unit sits INSIDE the segment; if the wall itself
    // is shorter than the unit, report how much it must grow.
    const halfM = wMm / 2000;
    const MARGIN_M = 0.05;
    const desired = (w.x + halfM) / e.len;
    let t: number;
    let shifted = false;
    let lengthenWallCm: number | undefined;
    const lo = (halfM + MARGIN_M) / e.len;
    const hi = 1 - lo;
    if (lo > hi) {
      t = 0.5;
      lengthenWallCm = Math.ceil((wMm / 10 + 2 * MARGIN_M * 100) - e.len * 100);
    } else {
      t = Math.min(hi, Math.max(lo, desired));
      shifted = Math.abs(t - desired) * e.len > 0.02;
    }
    const baseM = e.base ?? 0;
    placements.push({
      itemName: w.id,
      config,
      xCm: (e.x1 + (e.x2 - e.x1) * t) * M_TO_CM,
      yCm: (e.z1 + (e.z2 - e.z1) * t) * M_TO_CM,
      elevationCm: (w.y + hMm / 2000 - baseM) * M_TO_CM,
      rotation: (e.A * Math.PI) / 180,
      floorIndex: Math.max(0, (e.story ?? 1) - 1),
      shifted: shifted || undefined,
      lengthenWallCm,
    });
  }

  return { placements, alreadyPlaced, noWall };
}

/** Base-mark key used for catalog preference lookups. */
export function markKeyOf(idOrMark: string): string {
  const norm = normalizeMarkCode(idOrMark);
  const m = /^(.+?)-\d+$/.exec(norm);
  return (m ? m[1] : norm).toUpperCase();
}

export function buildStudioSeed(job: FitJobLike, maxWindows = 8): StudioSeed {
  const fps = groundFootprints(job).filter((fp) => fp.length >= 3);

  // Corners are merged ACROSS masses by coordinate (3 cm snap) and duplicate
  // segments dropped: adjacent masses trace the same boundary, and seeding it
  // twice used to mint coincident twin walls — a window cut its hole in one
  // while the twin rendered solid in front of it ("window hiding behind the
  // wall"). One shared wall is also what an editor expects to drag.
  const corners: Record<string, { x: number; y: number }> = {};
  const cornerList: { id: string; x: number; y: number }[] = [];
  const walls: { corner1: string; corner2: string }[] = [];
  const wallKeys = new Set<string>();
  const SNAP_CM = 3;
  const cornerId = (p: { x: number; z: number }): string => {
    const xCm = p.x * M_TO_CM;
    const yCm = p.z * M_TO_CM;
    // Linear proximity scan — corner counts are tiny, and a grid bucket
    // would miss near-identical points straddling a bucket boundary.
    for (const c of cornerList) {
      if (Math.hypot(c.x - xCm, c.y - yCm) <= SNAP_CM) return c.id;
    }
    const id = `c${cornerList.length}`;
    cornerList.push({ id, x: xCm, y: yCm });
    corners[id] = { x: xCm, y: yCm };
    return id;
  };
  fps.forEach((fp) => {
    const ids = fp.map(cornerId);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      if (a === b) continue; // merged corners collapse zero-length segments
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (wallKeys.has(key)) continue;
      wallKeys.add(key);
      walls.push({ corner1: a, corner2: b });
    }
  });

  const serialized = JSON.stringify({
    floorplan: { corners, walls, wallTextures: [], floorTextures: {}, newFloorTextures: {} },
    items: [],
  });

  // Windows: wall-relative fit-view coords -> world points via the same
  // elevation walk the 3D map uses, so both views agree on where a mark is.
  const elevs = elevationsOf(job) as {
    key: string; x1: number; z1: number; x2: number; z2: number; len: number; A: number;
  }[];
  const byKey = new Map(elevs.map((e) => [e.key, e]));
  const windows: SeedWindow[] = [];
  for (const w of job.windows) {
    if (windows.length >= maxWindows) break;
    const e = byKey.get(w.elev);
    if (!e || !(e.len > 0)) continue;
    const t = Math.min(1, Math.max(0, (w.x + w.w / 2000) / e.len));
    windows.push({
      id: w.id,
      x: (e.x1 + (e.x2 - e.x1) * t) * M_TO_CM,
      y: (e.z1 + (e.z2 - e.z1) * t) * M_TO_CM,
      elevation: (w.y + w.h / 2000) * M_TO_CM,
      rotation: (e.A * Math.PI) / 180,
      widthCm: (w.w / 1000) * M_TO_CM,
      heightCm: (w.h / 1000) * M_TO_CM,
    });
  }

  return { serialized, windows };
}
