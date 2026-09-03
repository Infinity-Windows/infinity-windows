// "Are you actually near this job?" — a SOFT clock-in check (standard-tracking
// -jobs slice 1, recommendation 4).
//
// Projects carry a text address and no coordinates, so "near the job" is
// measured against where clock-ins for this job have ACTUALLY happened — the
// most recent clock-in fix on the project (see getJobLastGeo in timeclock.ts).
// This is advisory only: it can shade a clock-in with a "you're not near this
// job" note, and it never blocks one. When anything is unknown — no current
// fix, no prior fix, or a fix too fuzzy to trust — it says nothing rather than
// nagging a crew who really is on site.

export interface LatLng {
  lat: number;
  lng: number;
}

/** A current device fix: coordinates plus an optional accuracy radius (metres). */
export interface DeviceFix extends LatLng {
  accuracyM?: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two points, in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The default "you're not near this job" radius: farther than this from where
 * the job's clock-ins have happened earns the soft note. Generous on purpose —
 * a false "not near" is worse than a missed one for an advisory. */
export const FAR_FROM_JOB_M = 800;

function isFinitePoint(p: LatLng | null | undefined): p is LatLng {
  return (
    p != null && Number.isFinite(p.lat) && Number.isFinite(p.lng)
  );
}

/**
 * True only when we can SAY the device is far from the job: both points are
 * real, the current fix is precise enough to trust (its accuracy radius is not
 * itself larger than the threshold), and the distance exceeds the threshold.
 * Every uncertain case returns false — this drives an advisory note, never a
 * block, so silence is the safe answer.
 */
export function farFromJob(
  my: DeviceFix | null | undefined,
  job: LatLng | null | undefined,
  thresholdMeters: number = FAR_FROM_JOB_M,
): boolean {
  if (!isFinitePoint(my) || !isFinitePoint(job)) return false;
  // A fix fuzzier than the threshold can't tell "near" from "far".
  if (
    my.accuracyM != null &&
    Number.isFinite(my.accuracyM) &&
    my.accuracyM > thresholdMeters
  ) {
    return false;
  }
  return haversineMeters(my, job) > thresholdMeters;
}
