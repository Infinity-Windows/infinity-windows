// Wave W (w-walls-spec.md, 2026-08-31), W2 — angle-snap for the Studio
// floorplanner's draw/move path. Same shape as install/cad.ts's
// snapPointToAxis (SNAP_TOLERANCE_DEG=2, pure, unit-tested), generalized from
// "horizontal or vertical on screen" to "square or straight relative to the
// wall this one connects to" — the floorplanner's cm plane is isotropic
// (equal scale on both axes), so unlike cad.ts's normalized outline space,
// no `aspect` correction is needed here.
//
// SQUARE (90°) and STRAIGHT (180°) are the classic architectural turn-angle
// convention measured AT the shared corner: the vector back to where the
// wall came from, versus the vector out to the candidate point. A straight
// run puts those two vectors opposite each other (180°); a square corner
// puts them perpendicular (90°, either turn direction).

export interface Vec2 {
  x: number;
  y: number;
}

export const WALL_ANGLE_SNAP_TOLERANCE_DEG = 5;

/**
 * Snap `candidate` so the wall corner→candidate locks to exactly square
 * (90°/270°) or straight (180°) relative to `reference` — the OTHER end of
 * the wall already connected at `corner` — when it is already within
 * `toleranceDeg` of one. Pass `reference: null` for a first/disconnected
 * wall: the snap then locks to the global axes instead (equivalent to
 * treating the "wall it connects to" as running along +X).
 *
 * Length from `corner` to `candidate` is preserved exactly — only the angle
 * moves — so this never fights a length the user dragged out on purpose.
 * Returns `candidate` unchanged (same reference, not a copy edge case aside)
 * when nothing is within tolerance.
 */
export function snapWallAngle(
  corner: Vec2,
  reference: Vec2 | null,
  candidate: Vec2,
  toleranceDeg: number = WALL_ANGLE_SNAP_TOLERANCE_DEG,
): Vec2 {
  const cx = candidate.x - corner.x;
  const cy = candidate.y - corner.y;
  const candidateLen = Math.hypot(cx, cy);
  if (candidateLen < 1e-6) return candidate;

  const rx = reference ? reference.x - corner.x : 1;
  const ry = reference ? reference.y - corner.y : 0;
  const refLen = Math.hypot(rx, ry);
  if (refLen < 1e-6) return candidate;

  const refAngle = Math.atan2(ry, rx);
  const candAngle = Math.atan2(cy, cx);
  // Signed angle from reference to candidate, normalized to (-180, 180].
  let deg = ((candAngle - refAngle) * 180) / Math.PI;
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;

  const nearest = Math.round(deg / 90) * 90;
  if (Math.abs(deg - nearest) > toleranceDeg) return candidate;

  const snappedAngle = refAngle + (nearest * Math.PI) / 180;
  return {
    x: corner.x + Math.cos(snappedAngle) * candidateLen,
    y: corner.y + Math.sin(snappedAngle) * candidateLen,
  };
}
