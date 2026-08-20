// Floors 2–10 (owner spec, 2026-08-13): one floor is edited at a time in
// the vendor; the rest are frozen serialized plans. Going up a floor puts a
// flat ceiling on the one below and starts EMPTY — like BLACK22, where only
// one section goes taller — with "copy the floor below" offered for hotel/
// apartment repeats. Pure helpers here; the Studio page owns the vendor.

export const MAX_FLOORS = 10;
/** A floor with no walls yet still needs a height to stack on. */
export const DEFAULT_FLOOR_CM = 250;

export interface StudioFloorsModel {
  /** Serialized vendor plans, index 0 = floor 1 (ground). */
  floors: string[];
}

/** Saved-model shapes old and new both parse: a lone `serialized` string is
 * a one-floor building. */
export function parseFloors(
  saved: { serialized?: string; floors?: string[] } | null | undefined,
  blank: string,
): StudioFloorsModel {
  if (saved?.floors?.length) {
    return { floors: saved.floors.slice(0, MAX_FLOORS) };
  }
  return { floors: [saved?.serialized ?? blank] };
}

export interface LiteWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  height: number;
}

export interface LiteItem {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  metadata: Record<string, unknown>;
}

/** Read a serialized floor without waking the vendor — shells, the 2D
 * ghost, and multi-floor publish all draw from this. */
export function parseFloorLite(serialized: string): { walls: LiteWall[]; items: LiteItem[] } {
  try {
    const data = JSON.parse(serialized) as {
      floorplan?: {
        corners?: Record<string, { x: number; y: number }>;
        walls?: { corner1: string; corner2: string; height?: number }[];
      };
      items?: {
        xpos: number;
        ypos: number;
        zpos: number;
        rotation?: number;
        item_name?: string;
        metadata?: Record<string, unknown>;
      }[];
    };
    const corners = data.floorplan?.corners ?? {};
    const walls: LiteWall[] = [];
    for (const w of data.floorplan?.walls ?? []) {
      const a = corners[w.corner1];
      const b = corners[w.corner2];
      if (!a || !b) continue;
      walls.push({
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        height: w.height && w.height > 0 ? w.height : DEFAULT_FLOOR_CM,
      });
    }
    const items: LiteItem[] = (data.items ?? []).map((it) => ({
      x: it.xpos,
      y: it.ypos,
      z: it.zpos,
      rotationY: it.rotation ?? 0,
      metadata: { itemName: it.item_name, ...(it.metadata ?? {}) },
    }));
    return { walls, items };
  } catch {
    return { walls: [], items: [] };
  }
}

/** A floor's stacking height: its tallest wall, or the default when bare. */
export function floorHeightCm(walls: LiteWall[]): number {
  return walls.reduce((h, w) => Math.max(h, w.height), 0) || DEFAULT_FLOOR_CM;
}

/** Base elevation of each floor, cm — floor N stands on the tallest walls
 * of every floor below it. */
export function floorElevationsCm(floors: string[]): number[] {
  const out: number[] = [];
  let elev = 0;
  for (const f of floors) {
    out.push(elev);
    elev += floorHeightCm(parseFloorLite(f).walls);
  }
  return out;
}

/** "Copy the floor below": the plan AND its windows ride along. */
export function duplicateFloorSerialized(serialized: string): string {
  return serialized;
}

// --------------------------------------------------------------- roof (#49)

export type RoofStyle = "none" | "flat";

/**
 * The building's roof choice — a sibling of `floors` in the saved model,
 * not per-floor: one roof caps the whole building, laid on the TOP floor's
 * walls (see roofShell.ts). Absent/unrecognized (old saves, a blank
 * project) reads as "none" — today's shells, unchanged.
 */
export function parseRoof(saved: { roof?: string } | null | undefined): RoofStyle {
  return saved?.roof === "flat" ? "flat" : "none";
}

/**
 * The ONE shape a saved Studio model takes, whoever is writing it. Save
 * always used this; Publish hand-rolled its own copy with no `floors` and
 * `serialized` set to whichever floor was ACTIVE — so publishing a
 * multi-story building from floor 2 silently threw away every other floor
 * AND wrote floor 2 where old readers expect floor 1 (found during the
 * look-and-feel wave, 2026-08-20). Both writers call this now; the bug
 * class is gone because there is nothing left to hand-roll.
 *
 * `floors` must already contain the flushed live floor — flushing touches
 * the vendor model, which stays the caller's job so this stays pure.
 */
export function modelBody(
  floors: string[],
  roof: RoofStyle,
  savedAt: string = new Date().toISOString(),
): { serialized: string; floors: string[]; savedAt: string; roof: RoofStyle } {
  return { serialized: floors[0], floors: [...floors], savedAt, roof };
}
