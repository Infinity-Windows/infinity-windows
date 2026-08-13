// Seed the Model Studio from what the app already knows: the fit-view job
// (traced footprint in meters + windows placed per wall) becomes a
// blueprint3d floorplan (corners/walls in cm) plus world-positioned window
// items. SPIKE-scope: ground story only, first N openings — enough to judge
// the foundation on a real building, not a demo house.

import { elevationsOf } from "../fitview/fitviewRenderer";

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

export function buildStudioSeed(job: FitJobLike, maxWindows = 8): StudioSeed {
  const fps = groundFootprints(job).filter((fp) => fp.length >= 3);

  const corners: Record<string, { x: number; y: number }> = {};
  const walls: { corner1: string; corner2: string }[] = [];
  fps.forEach((fp, pi) => {
    const ids = fp.map((p, i) => {
      const id = `c${pi}-${i}`;
      corners[id] = { x: p.x * M_TO_CM, y: p.z * M_TO_CM };
      return id;
    });
    for (let i = 0; i < ids.length; i++) {
      walls.push({ corner1: ids[i], corner2: ids[(i + 1) % ids.length] });
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
