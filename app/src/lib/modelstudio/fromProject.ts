// Seed the Model Studio from what the app already knows: the fit-view job
// (traced footprint in meters + windows placed per wall) becomes a
// blueprint3d floorplan (corners/walls in cm) plus world-positioned window
// items. SPIKE-scope: ground story only, first N openings — enough to judge
// the foundation on a real building, not a demo house.

import { elevationsOf } from "../fitview/fitviewRenderer";
import {
  DEFAULT_SILL_M,
  DEFAULT_WALL_HEIGHT_M,
  normalizeMarkCode,
} from "../fitview/adapter";
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
    /** Partitions the hand-read model carries (toFitview.ts's shape);
     * elevationsOf walks them after every exterior edge, `interior: true`. */
    interiorWalls?: {
      x1: number; z1: number; x2: number; z2: number;
      story?: number; heightM?: number; elevM?: number; interior?: boolean;
    }[];
  };
  windows: {
    id: string;
    elev: string;
    x: number; // meters along the wall
    y: number; // sill, meters
    w: number; // mm
    h: number; // mm
    /** True only for a placement buildStudioPull invented itself (the
     * unpinned-spec fallback below) — never set on a real job window. */
    fromSpec?: boolean;
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
  /** The plans have a wall the studio model doesn't: CREATE this segment
   * (studio-frame cm) before placing — emitted once per plan edge. */
  newWall?: StudioWallSeg;
  /** This mark has no pin yet — the position is a deterministic guess
   * (evenly spread along the ground floor's walls), not a survey result.
   * The caller's status line should say so plainly. */
  fromSpec?: boolean;
  /** Placed from the hand-read model's INTERIOR wall (the `readModel`
   * param) — a real position off the plans, not a guess, on a partition
   * the pins can never describe. */
  fromRead?: boolean;
}

/** One `elevationsOf` entry, typed for the pull (the renderer is plain JS). */
interface ElevEntry {
  key: string; x1: number; z1: number; x2: number; z2: number; len: number;
  A: number; story?: number; base?: number; hM?: number; interior?: boolean;
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
  let s = Math.min(
    5,
    Math.max(0.2, ratios.length ? ratios.reduce((t, r) => t + r, 0) / ratios.length : 1),
  );
  let tx = b.cx - a.cx * s;
  let ty = b.cy - a.cy * s;

  // Refine on INLIERS: a save missing a wing shrinks its bbox and the
  // seed transform squeezes everything (BLACK22: plan-added walls landed
  // offset from the building). Match plan corners to their nearest wall
  // endpoint under the seed transform, keep close pairs, and re-solve the
  // uniform scale + translation from those pairs only — the missing
  // region simply has no matches and stops distorting the fit.
  for (let pass = 0; pass < 2; pass++) {
    const pairs: { p: { x: number; y: number }; q: { x: number; y: number } }[] = [];
    for (const p of planPts) {
      const px = p.x * s + tx;
      const py = p.y * s + ty;
      let bq: { x: number; y: number } | null = null;
      let bd = Infinity;
      for (const q of wallPts) {
        const d = Math.hypot(q.x - px, q.y - py);
        if (d < bd) {
          bd = d;
          bq = q;
        }
      }
      if (bq && bd <= 300) pairs.push({ p, q: bq });
    }
    if (pairs.length < 4) break;
    const mean = (vals: number[]) => vals.reduce((t, v) => t + v, 0) / vals.length;
    const mpx = mean(pairs.map(({ p }) => p.x));
    const mpy = mean(pairs.map(({ p }) => p.y));
    const mqx = mean(pairs.map(({ q }) => q.x));
    const mqy = mean(pairs.map(({ q }) => q.y));
    let num = 0;
    let den = 0;
    for (const { p, q } of pairs) {
      num += (p.x - mpx) * (q.x - mqx) + (p.y - mpy) * (q.y - mqy);
      den += (p.x - mpx) ** 2 + (p.y - mpy) ** 2;
    }
    if (den > 1) s = Math.min(5, Math.max(0.2, num / den));
    tx = mqx - mpx * s;
    ty = mqy - mpy * s;
  }
  return (p) => ({ x: p.x * s + tx, y: p.y * s + ty });
}

/**
 * Merge endpoint-connected, near-collinear walls into straight RUNS. A
 * traced building is jagged (BLACK22: 93 walls, median 2.2 m) while spec
 * windows run to 8.6 m — the map draws a window across a straight run of
 * segments, so the studio must fit against the RUN, not one segment.
 */
export function buildWallRuns(walls: StudioWallSeg[]): StudioWallSeg[] {
  const JOIN_CM = 5;
  const COS_TOL = Math.cos((10 * Math.PI) / 180);
  const used = new Array(walls.length).fill(false);
  const runs: StudioWallSeg[] = [];
  const straightOn = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    q: { x: number; y: number },
  ) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const bqx = q.x - b.x;
    const bqy = q.y - b.y;
    const la = Math.hypot(abx, aby);
    const lb = Math.hypot(bqx, bqy);
    if (!(la > 1) || !(lb > 1)) return false;
    return (abx * bqx + aby * bqy) / (la * lb) >= COS_TOL;
  };
  for (let i = 0; i < walls.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let a = { x: walls[i].x1, y: walls[i].y1 };
    let b = { x: walls[i].x2, y: walls[i].y2 };
    let grown = true;
    while (grown) {
      grown = false;
      for (let j = 0; j < walls.length; j++) {
        if (used[j]) continue;
        const w = walls[j];
        const ends = [
          [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }],
          [{ x: w.x2, y: w.y2 }, { x: w.x1, y: w.y1 }],
        ] as const;
        for (const [p, q] of ends) {
          if (Math.hypot(p.x - b.x, p.y - b.y) <= JOIN_CM && straightOn(a, b, q)) {
            b = q;
            used[j] = true;
            grown = true;
            break;
          }
          if (Math.hypot(p.x - a.x, p.y - a.y) <= JOIN_CM && straightOn(b, a, q)) {
            a = q;
            used[j] = true;
            grown = true;
            break;
          }
        }
        if (grown) break;
      }
    }
    runs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return runs;
}

/** Nearest run going the placement's direction (±35° — old saves drift
 * off today's trace angles), within `maxDistCm`. Returns the projection
 * along it and the run-aligned rotation closest to the original. */
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
  const COS_TOL = Math.cos((35 * Math.PI) / 180);
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

/** Total plan-frame width a config's WIDEST leg demands — a corner unit
 * counts only its main leg (cornerGeometryInfo's rule; the wrap leg turns
 * down the next wall and never inflates THIS wall's demand). Shared by the
 * pinned path and the unpinned-spec fallback below so both measure a
 * unit's footprint the same way. */
function widthMmFor(config: UnitConfig): number {
  const legs = cornerLegs(config);
  return legs
    ? Math.max(panelsWidthMm(legs.left), panelsWidthMm(legs.right))
    : panelsWidthMm(config.panels);
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
 *
 * UNPINNED marks (Mad Moose, 2026-08-31): `job.windows` only ever holds
 * PINNED openings — buildFitViewJob (adapter.ts) skips any opening with no
 * `pin_x`/`pin_y`, by design, for the fit-view MAP. A job can carry a
 * traced building and a full extracted schedule (real sizes, ten marks)
 * with not one pin placed yet, and this function used to walk `job.windows`
 * only — an empty list — and report "0 placed" though nothing was actually
 * wrong. Every SPECCED mark still gets pulled in: real spec size, spread
 * deterministically along the ground floor's walls as an approximate,
 * obviously-editable starting point (`fromSpec: true`), never a randomly
 * or arbitrarily placed guess and never a substitute for a real pin.
 *
 * INTERIOR walls (Mad Moose, owner 2026-09-02: "i drew the interior walls,
 * add the 3 missing on the interior wall"): a pin is a point on the
 * exterior outline, so a unit on a partition — the office glass wall's
 * Add-1/2/3 — can never be pinned and used to fall into the spread above,
 * landing on the wrong (exterior) wall. The hand-read model (`readModel`,
 * the human-trace-backed authored job — the caller gates it on
 * humanTraceModel, so a Studio PUBLISH is never read back: the BLACK22
 * echo law) knows exactly which interior wall each one sits on and where.
 * Its windows on an `interior: true` elevation, unpinned and not yet
 * placed, are taken OUT of the spread and placed from the read position
 * instead (`fromRead: true`), snapped onto the studio wall the owner drew
 * there, or bringing the read wall with them when none is drawn. Exterior
 * read windows are ignored here on purpose — pins own exterior placement.
 */
export function buildStudioPull(
  job: FitJobLike,
  specs: ProjectMarkSpec[],
  existingNames: Set<string>,
  catalogByMark: Map<string, UnitConfig> = new Map(),
  studio?: { walls: StudioWallSeg[]; floorIndex: number },
  readModel?: FitJobLike | null,
): PullResult {
  const elevs = elevationsOf(job) as ElevEntry[];
  const byKey = new Map(elevs.map((e) => [e.key, e]));
  const specIndex = indexSpecsByMark(specs);

  // Plan → studio frame alignment, from the ground footprint's corners to
  // the real walls' corners. Identity when either side is degenerate.
  const snapWalls = studio?.walls ?? [];
  const snapRuns = buildWallRuns(snapWalls);
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
  /** Plan edges already emitted as new walls this pull (keyed by elev;
   * read-model edges under their own "read:" prefix — the two key spaces
   * both count "s0…sN" and must never share a wall). */
  const emittedWalls = new Map<string, StudioWallSeg>();

  const placements: PullPlacement[] = [];
  let alreadyPlaced = 0;
  let noWall = 0;

  // Specced marks with no pinned opening at all: everything job.windows
  // already covers (by BASE mark, so "16-1" pinned still counts for spec
  // "16") is excluded, so a mark never gets both a real placement and a
  // guessed one.
  const pinnedMarks = new Set(job.windows.map((w) => markKeyOf(w.id)));

  // Interior-wall windows off the hand-read model. Pinned-ness is checked
  // by the window's OWN normalized id (and by base only when the id IS a
  // base mark): Mad Moose's Add-1/2/3 are three separate marks that
  // markKeyOf folds onto one base, "ADD", so a base-only check would drop
  // Add-2 and Add-3 the moment Add-1 got pinned. Frame alignment comes
  // from the READ model's own footprint — it's a different source than
  // `job` and may sit in its own frame, so `toStudio` above can't serve.
  const readElevs = readModel ? (elevationsOf(readModel) as ElevEntry[]) : [];
  const readByKey = new Map(readElevs.map((e) => [e.key, e]));
  const pinnedIds = new Set(job.windows.map((w) => normalizeMarkCode(w.id)));
  const readWindows = (readModel?.windows ?? []).filter((w) => {
    const e = readByKey.get(w.elev);
    if (!e?.interior || !(e.len > 0)) return false;
    const norm = normalizeMarkCode(w.id);
    return !pinnedIds.has(norm) && !pinnedMarks.has(norm);
  });
  const toStudioRead = readModel
    ? frameTransform(
        groundFootprints(readModel)
          .flat()
          .map((p) => ({ x: p.x * M_TO_CM, y: p.z * M_TO_CM })),
        snapWalls.flatMap((w) => [
          { x: w.x1, y: w.y1 },
          { x: w.x2, y: w.y2 },
        ]),
      )
    : toStudio;
  // The owner hand-draws partitions over the plan underlay, so a read
  // wall must snap across ordinary drawing drift (half a metre) — but a
  // PARALLEL partition must not steal the unit: Mad Moose's bay wall runs
  // 4.1 m from the office glass wall. 3 m sits between the two.
  const READ_SNAP_MAX_CM = 300;
  // A read-placed mark never ALSO gets a spread guess. Keyed by the exact
  // normalized id and its base, so spec "16" is covered by a read "16-1"
  // while spec "Add-2" stays in the spread unless Add-2 itself was read.
  const readKeys = new Set(
    readWindows.flatMap((w) => [normalizeMarkCode(w.id), markKeyOf(w.id)]),
  );
  const unpinnedMarks = specs
    .filter(
      (s) =>
        !pinnedMarks.has(s.mark_code.toUpperCase()) &&
        !readKeys.has(normalizeMarkCode(s.mark_code)),
    )
    .map((s) => ({
      spec: s,
      config: catalogByMark.get(markKeyOf(s.mark_code)) ?? specToUnitConfig(s),
    }))
    // A spec with no usable width/height has no real size to place with —
    // it's left out (and counted below) rather than inventing one.
    .filter(
      (u): u is { spec: ProjectMarkSpec; config: UnitConfig } => u.config != null,
    )
    .sort((a, b) =>
      a.spec.mark_code.localeCompare(b.spec.mark_code, undefined, { numeric: true }),
    );

  const groundWalls = elevs.filter((e) => (e.story ?? 1) === 1 && e.len > 0);
  const groundLenM = groundWalls.reduce((t, e) => t + e.len, 0);
  const synthetic: FitJobLike["windows"] = [];
  if (unpinnedMarks.length > 0 && groundLenM <= 0) {
    noWall += unpinnedMarks.length;
  } else if (unpinnedMarks.length > 0) {
    const n = unpinnedMarks.length;
    unpinnedMarks.forEach(({ spec, config }, i) => {
      const wMm = widthMmFor(config);
      const hM = config.heightMm / 1000;
      // Evenly spread along the ground floor's UNROLLED perimeter —
      // deterministic, no randomness — then land on whichever wall that
      // running distance falls inside.
      const target = ((i + 0.5) / n) * groundLenM;
      let acc = 0;
      let wall = groundWalls[groundWalls.length - 1];
      for (const cand of groundWalls) {
        if (target < acc + cand.len) {
          wall = cand;
          break;
        }
        acc += cand.len;
      }
      const centerM = Math.min(wall.len, Math.max(0, target - acc));
      const wallHeightM = wall.hM ?? DEFAULT_WALL_HEIGHT_M;
      const sillM =
        config.kind === "door"
          ? 0
          : Math.max(0.15, Math.min(DEFAULT_SILL_M, wallHeightM - hM - 0.2));
      synthetic.push({
        id: spec.mark_code,
        elev: wall.key,
        x: centerM - wMm / 2000,
        y: sillM,
        w: wMm,
        h: config.heightMm,
        fromSpec: true,
      });
    });
  }

  // Every window to land, each with the frame it was measured in: the
  // plans' windows (pinned + spread) in the plans frame, then the read
  // model's interior windows in the read frame, with its tighter snap.
  const walk = [
    ...[...job.windows, ...synthetic].map((w) => ({
      w,
      e: byKey.get(w.elev),
      toFrame: toStudio,
      snapMaxCm: SNAP_MAX_CM,
      wallKey: w.elev,
      fromRead: false,
    })),
    ...readWindows.map((w) => ({
      w,
      e: readByKey.get(w.elev),
      toFrame: toStudioRead,
      snapMaxCm: READ_SNAP_MAX_CM,
      wallKey: `read:${w.elev}`,
      fromRead: true,
    })),
  ];

  for (const { w, e, toFrame, snapMaxCm, wallKey, fromRead } of walk) {
    if (existingNames.has(w.id)) {
      alreadyPlaced += 1;
      continue;
    }
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
    const wMm = widthMmFor(config);
    const hMm = config.heightMm;
    const halfM = wMm / 2000;
    const baseM = e.base ?? 0;
    const floorIndex = Math.max(0, (e.story ?? 1) - 1);
    const elevationCm = (w.y + hMm / 2000 - baseM) * M_TO_CM;
    const rotation = (e.A * Math.PI) / 180;
    const desiredT = (w.x + halfM) / e.len;

    // Snap path: align the plan point into the studio frame, land it on
    // the nearest same-direction RUN of real walls, refit inside the run.
    if (snapWalls.length > 0 && floorIndex === studio!.floorIndex) {
      const raw = toFrame({
        x: (e.x1 + (e.x2 - e.x1) * desiredT) * M_TO_CM,
        y: (e.z1 + (e.z2 - e.z1) * desiredT) * M_TO_CM,
      });
      const snap = snapToWall(raw.x, raw.y, rotation, snapRuns, snapMaxCm);
      if (snap) {
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
          fromSpec: w.fromSpec || undefined,
          fromRead: fromRead || undefined,
        });
        continue;
      }
      // The plans have a wall this model doesn't (old save missing a
      // wing, retraced geometry, a read partition the owner hasn't drawn):
      // BRING THE WALL WITH THE WINDOW — the plan edge, transformed into
      // the studio frame, created once and shared by every window on it.
      // Nothing is skipped or floated.
      let seg = emittedWalls.get(wallKey);
      const isNew = !seg;
      if (!seg) {
        const p1 = toFrame({ x: e.x1 * M_TO_CM, y: e.z1 * M_TO_CM });
        const p2 = toFrame({ x: e.x2 * M_TO_CM, y: e.z2 * M_TO_CM });
        seg = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
        emittedWalls.set(wallKey, seg);
      }
      const segLenM = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) / 100;
      const fit = fitAlongSegment(desiredT, wMm, Math.max(0.01, segLenM));
      const ry = Math.atan2(-(seg.y2 - seg.y1), seg.x2 - seg.x1);
      const diffA = (p: number, q: number) =>
        Math.abs(Math.atan2(Math.sin(p - q), Math.cos(p - q)));
      placements.push({
        itemName: w.id,
        config,
        xCm: seg.x1 + (seg.x2 - seg.x1) * fit.t,
        yCm: seg.y1 + (seg.y2 - seg.y1) * fit.t,
        elevationCm,
        rotation: diffA(ry, rotation) <= diffA(ry + Math.PI, rotation) ? ry : ry + Math.PI,
        floorIndex,
        shifted: fit.shifted || undefined,
        lengthenWallCm: fit.lengthenWallCm,
        newWall: isNew ? seg : undefined,
        fromSpec: w.fromSpec || undefined,
        fromRead: fromRead || undefined,
      });
      continue;
    }

    // Frameless path (no studio walls / frozen floors): the plan's own
    // edge, fit-to-wall as before (owner: "windows sticking past walls").
    // A read window lands at the read model's own coordinates here.
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
      fromSpec: w.fromSpec || undefined,
      fromRead: fromRead || undefined,
    });
  }

  return { placements, alreadyPlaced, noWall };
}

/** Everything the "Pull from plans" status line needs to report, gathered
 * by the caller as it applies `PullResult.placements` to the live scene. */
export interface PullToastStats {
  /** Placements applied on the ACTIVE floor (pinned, fromSpec and fromRead). */
  placedHere: number;
  /** Of `placedHere`, how many came from the unpinned-spec fallback. */
  specPlacedHere: number;
  /** Of `placedHere`, how many landed on an interior wall from the
   * hand-read model (`fromRead`). */
  readPlacedHere: number;
  healed: number;
  shifted: number;
  lengthened: number;
  wallsAdded: number;
  raised: number;
  autoScale: { factor: number; longSideM: number } | null;
  alreadyPlaced: number;
  otherFloors: number;
  noWall: number;
}

/**
 * Plain-English "Pull from plans" status line (house style: an installer
 * or foreman reads this, not a developer). When some or all of what got
 * placed came off a spec with no pin yet, LEAD with that — a supervisor
 * needs to know up front that those positions are a guess to rearrange,
 * not a survey result (Mad Moose, 2026-08-31: a full 10-mark schedule with
 * zero pins used to report "0 placed" instead of placing all ten from
 * their specs). A pull that placed only real pinned windows keeps the
 * original, plainer wording unchanged.
 *
 * Units placed on an INTERIOR wall from the hand-read plans (Mad Moose,
 * 2026-09-02) get their own plain sentence so the owner can see the Adds
 * went where the plans put them — a real position, not a guess.
 */
export function formatPullToast(s: PullToastStats): string {
  const pinnedPlaced = s.placedHere - s.specPlacedHere - s.readPlacedHere;
  const bits: (string | null)[] = [];
  if (s.specPlacedHere > 0 || s.readPlacedHere > 0) {
    if (pinnedPlaced > 0) bits.push(`${pinnedPlaced} placed from pins`);
    if (s.readPlacedHere > 0) {
      bits.push(
        `${s.readPlacedHere} placed on your interior walls from the read plans`,
      );
    }
    if (s.specPlacedHere > 0) {
      bits.push(
        `${s.specPlacedHere} placed from specs (no pins yet; positions are a starting point)`,
      );
    }
  } else {
    bits.push(`${s.placedHere} placed`);
  }
  bits.push(
    s.healed > 0 ? `${s.healed} healed` : null,
    s.shifted > 0 ? `${s.shifted} slid to fit their wall` : null,
    s.lengthened > 0
      ? `${s.lengthened} wall${s.lengthened === 1 ? "" : "s"} lengthened`
      : null,
    s.wallsAdded > 0
      ? `${s.wallsAdded} wall${s.wallsAdded === 1 ? "" : "s"} added from the plans`
      : null,
    s.raised > 0 ? `${s.raised} wall${s.raised === 1 ? "" : "s"} raised` : null,
    s.autoScale
      ? `building auto-scaled ×${s.autoScale.factor} from specs (${Math.round(s.autoScale.longSideM)} m long side)`
      : null,
    s.alreadyPlaced > 0 ? `${s.alreadyPlaced} already placed` : null,
    s.otherFloors > 0
      ? `${s.otherFloors} on other floors — switch and pull again`
      : null,
    s.noWall > 0 ? `${s.noWall} had no wall to land on` : null,
  );
  const joined = bits.filter(Boolean).join(" · ");
  return s.specPlacedHere > 0
    ? `Pulled ${s.placedHere} mark${s.placedHere === 1 ? "" : "s"} — ${joined}.`
    : `Pull from plans: ${joined}.`;
}

/** Base-mark key used for catalog preference lookups. */
export function markKeyOf(idOrMark: string): string {
  const norm = normalizeMarkCode(idOrMark);
  const m = /^(.+?)-\d+$/.exec(norm);
  return (m ? m[1] : norm).toUpperCase();
}

/**
 * Catalog units keyed by BASE mark, read off each unit's own name ("Window
 * 16", "Door 3 · JOB-2") — the same regex signatureSync and this file's own
 * `buildStudioPull` already use to prefer a refined catalog unit over the
 * raw spec. Shared here so every OTHER "what does this mark look like"
 * feature (package-count suggestions, constructability warnings, RO-
 * mismatch flags) builds the map the same way instead of re-deriving it.
 */
export function catalogByMarkFrom(
  units: { name: string; config: UnitConfig }[],
): Map<string, UnitConfig> {
  const out = new Map<string, UnitConfig>();
  for (const u of units) {
    const m = /^(?:Window|Door)\s+([^\s·]+)/.exec(u.name);
    if (m) out.set(m[1].toUpperCase(), u.config);
  }
  return out;
}

/**
 * Resolve one mark's config the way `syncProjectSignatures` and
 * `buildStudioPull` both already do: the company catalog's refined unit
 * wins when one exists for the mark, the spec-derived draft otherwise, and
 * no config at all when neither has one. One function so every caller
 * agrees with the signature pipeline on what a mark IS, rather than
 * re-deriving the same two-line priority a third or fourth time.
 */
export function resolveMarkConfig(
  mark: string,
  specIndex: Map<string, ProjectMarkSpec>,
  catalogByMark: Map<string, UnitConfig>,
): UnitConfig | null {
  const spec = specForOpeningCode(specIndex, mark);
  return catalogByMark.get(markKeyOf(mark)) ?? (spec ? specToUnitConfig(spec) : null);
}

/**
 * One story's rings → one studio floor plan. Corners are merged ACROSS
 * masses by coordinate (3 cm snap) and duplicate segments dropped:
 * adjacent masses trace the same boundary, and seeding it twice used to
 * mint coincident twin walls — a window cut its hole in one while the
 * twin rendered solid in front of it ("window hiding behind the wall").
 * One shared wall is also what an editor expects to drag.
 */
function planFromRings(fps: { x: number; z: number }[][]): string {
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
  return JSON.stringify({
    floorplan: { corners, walls, wallTextures: [], floorTextures: {}, newFloorTextures: {} },
    items: [],
  });
}

/**
 * Every traced STORY → a studio floor plan (owner, 2026-08-14: "go up a
 * floor and do it again for as many floors as we have designed for").
 * Walls only — windows land per floor via Pull from plans or by hand.
 * A job with no stories array is one ground floor.
 */
export function buildStudioFloorsSeed(job: FitJobLike): string[] {
  const st = job.building.stories;
  const perStory =
    Array.isArray(st) && st.length > 0
      ? st.map((s) => s.footprints ?? [])
      : [job.building.footprints ?? []];
  return perStory.map((fps) =>
    planFromRings(fps.filter((fp) => fp.length >= 3)),
  );
}

export function buildStudioSeed(job: FitJobLike, maxWindows = 8): StudioSeed {
  const fps = groundFootprints(job).filter((fp) => fp.length >= 3);
  const serialized = planFromRings(fps);

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
