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

/** One studio wall, plan cm — the frame the pull must land in. */
export interface StudioWallSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Slide a centre inside [0,1] of a segment, 5 cm margins; too-short
 * segments centre the unit and report the growth needed. */
function fitAlongSegment(
  desiredT: number,
  wMm: number,
  lenM: number,
): { t: number; shifted: boolean; lengthenWallCm?: number } {
  const MARGIN_M = 0.05;
  const halfM = wMm / 2000;
  const lo = (halfM + MARGIN_M) / lenM;
  const hi = 1 - lo;
  if (lo > hi) {
    return {
      t: 0.5,
      shifted: false,
      lengthenWallCm: Math.ceil(wMm / 10 + 2 * MARGIN_M * 100 - lenM * 100),
    };
  }
  const t = Math.min(hi, Math.max(lo, desiredT));
  return { t, shifted: Math.abs(t - desiredT) * lenM > 0.02 };
}

/**
 * Best-fit frame transform plan → studio walls: uniform scale about the
 * bbox centres. The studio's saved plan lives in the VENDOR's frame — it
 * re-centres on detected rooms at save, and the owner drags walls — so
 * absolute plan coordinates only match right after a fresh seed. (BLACK22,
 * 2026-08-14: pulled windows floated in a ghost of the building offset
 * from the real walls.)
 */
function frameTransform(
  planPts: { x: number; y: number }[],
  wallPts: { x: number; y: number }[],
): (p: { x: number; y: number }) => { x: number; y: number } {
  if (planPts.length < 2 || wallPts.length < 2) return (p) => p;
  const bbox = (pts: { x: number; y: number }[]) => {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  };
  const a = bbox(planPts);
  const b = bbox(wallPts);
  const ratios = [
    a.w > 100 ? b.w / a.w : null,
    a.h > 100 ? b.h / a.h : null,
  ].filter((r): r is number => r != null && r > 0);
  const s = Math.min(
    5,
    Math.max(0.2, ratios.length ? ratios.reduce((t, r) => t + r, 0) / ratios.length : 1),
  );
  return (p) => ({ x: b.cx + (p.x - a.cx) * s, y: b.cy + (p.y - a.cy) * s });
}

/** Nearest wall running the placement's direction (±25°, either facing),
 * within `maxDistCm` of the point. Returns the projection along it and the
 * wall-aligned rotation closest to the original. */
function snapToWall(
  x: number,
  y: number,
  rotation: number,
  walls: StudioWallSeg[],
  maxDistCm: number,
): { wall: StudioWallSeg; t: number; lenCm: number; rotation: number } | null {
  // Item rotation → plan direction, the snapIfCorner convention:
  // (cos ry, −sin ry) runs along the item's wall.
  const dx = Math.cos(rotation);
  const dy = -Math.sin(rotation);
  const COS_TOL = Math.cos((25 * Math.PI) / 180);
  let best: { wall: StudioWallSeg; t: number; lenCm: number; d: number } | null = null;
  for (const w of walls) {
    const wx = w.x2 - w.x1;
    const wy = w.y2 - w.y1;
    const len = Math.hypot(wx, wy);
    if (!(len > 1)) continue;
    if (Math.abs((dx * wx + dy * wy) / len) < COS_TOL) continue;
    const raw = ((x - w.x1) * wx + (y - w.y1) * wy) / (len * len);
    const tc = Math.min(1, Math.max(0, raw));
    const d = Math.hypot(x - (w.x1 + wx * tc), y - (w.y1 + wy * tc));
    if (d <= maxDistCm && (!best || d < best.d)) {
      best = { wall: w, t: raw, lenCm: len, d };
    }
  }
  if (!best) return null;
  const wx = best.wall.x2 - best.wall.x1;
  const wy = best.wall.y2 - best.wall.y1;
  // Wall-aligned rotation, keeping the facing closest to the plan's.
  const ry = Math.atan2(-wy, wx);
  const diff = (a: number, b: number) =>
    Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const aligned = diff(ry, rotation) <= diff(ry + Math.PI, rotation) ? ry : ry + Math.PI;
  return { wall: best.wall, t: best.t, lenCm: best.lenCm, rotation: aligned };
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
 *
 * When `studio` is given (the active floor's real walls), every placement
 * on that floor is aligned into the STUDIO's frame and snapped onto its
 * nearest same-direction wall — a window either lands ON a wall or is
 * skipped and counted, never left floating.
 */
export function buildStudioPull(
  job: FitJobLike,
  specs: ProjectMarkSpec[],
  existingNames: Set<string>,
  catalogByMark: Map<string, UnitConfig> = new Map(),
  studio?: { walls: StudioWallSeg[]; floorIndex: number },
): PullResult {
  const elevs = elevationsOf(job) as {
    key: string; x1: number; z1: number; x2: number; z2: number; len: number;
    A: number; story?: number; base?: number;
  }[];
  const byKey = new Map(elevs.map((e) => [e.key, e]));
  const specIndex = indexSpecsByMark(specs);

  // Plan → studio frame alignment, from the ground footprint's corners to
  // the real walls' corners. Identity when either side is degenerate.
  const snapWalls = studio?.walls ?? [];
  const toStudio = frameTransform(
    groundFootprints(job)
      .flat()
      .map((p) => ({ x: p.x * M_TO_CM, y: p.z * M_TO_CM })),
    snapWalls.flatMap((w) => [
      { x: w.x1, y: w.y1 },
      { x: w.x2, y: w.y2 },
    ]),
  );
  const SNAP_MAX_CM = 500;

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
    const halfM = wMm / 2000;
    const baseM = e.base ?? 0;
    const floorIndex = Math.max(0, (e.story ?? 1) - 1);
    const elevationCm = (w.y + hMm / 2000 - baseM) * M_TO_CM;
    const rotation = (e.A * Math.PI) / 180;
    const desiredT = (w.x + halfM) / e.len;

    // Snap path: align the plan point into the studio frame, land it on
    // the nearest same-direction REAL wall, refit inside that wall.
    if (snapWalls.length > 0 && floorIndex === studio!.floorIndex) {
      const raw = toStudio({
        x: (e.x1 + (e.x2 - e.x1) * desiredT) * M_TO_CM,
        y: (e.z1 + (e.z2 - e.z1) * desiredT) * M_TO_CM,
      });
      const snap = snapToWall(raw.x, raw.y, rotation, snapWalls, SNAP_MAX_CM);
      if (!snap) {
        noWall += 1;
        continue;
      }
      const fit = fitAlongSegment(snap.t, wMm, snap.lenCm / 100);
      placements.push({
        itemName: w.id,
        config,
        xCm: snap.wall.x1 + (snap.wall.x2 - snap.wall.x1) * fit.t,
        yCm: snap.wall.y1 + (snap.wall.y2 - snap.wall.y1) * fit.t,
        elevationCm,
        rotation: snap.rotation,
        floorIndex,
        shifted: fit.shifted || undefined,
        lengthenWallCm: fit.lengthenWallCm,
      });
      continue;
    }

    // Frameless path (no studio walls / frozen floors): the plan's own
    // edge, fit-to-wall as before (owner: "windows sticking past walls").
    const fit = fitAlongSegment(desiredT, wMm, e.len);
    placements.push({
      itemName: w.id,
      config,
      xCm: (e.x1 + (e.x2 - e.x1) * fit.t) * M_TO_CM,
      yCm: (e.z1 + (e.z2 - e.z1) * fit.t) * M_TO_CM,
      elevationCm,
      rotation,
      floorIndex,
      shifted: fit.shifted || undefined,
      lengthenWallCm: fit.lengthenWallCm,
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
