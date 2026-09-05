// "You're near <job>" — the pure half.
//
// Jobs carry a text address and no coordinates, so "near this job" is measured
// against where clock-ins for it have ACTUALLY happened (getJobLastGeo, the
// same signal the far-from-job clock prompt uses). Reusing that rather than
// geocoding an address means the two features can never disagree about where a
// job is, and it costs no third-party lookup.
//
// The rules, and the reason for each:
//
//   * A fix fuzzier than the radius cannot tell near from far. A 2km-accurate
//     city-block fix would nominate whichever job happened to be closest, with
//     total confidence. Silence is the honest answer.
//   * One winner, not a ranked list. This is a chip offering the single best
//     guess; three "maybe" chips is a quiz, not a suggestion.
//   * Nothing is auto-applied. The chip says why it is there and waits for a
//     tap, because a photo filed to the wrong job by a confident guess is
//     worse than one the person picked.

import { haversineMeters, type DeviceFix, type LatLng } from "../jobProximity";

/** Where a job's clock-ins have happened, plus what to call it. */
export interface JobGeo extends LatLng {
  projectId: string;
  label: string;
}

export interface NearbyJob {
  projectId: string;
  label: string;
  meters: number;
}

/**
 * How close counts as "you're near this one". Tighter than the clock's
 * FAR_FROM_JOB_M (800m), on purpose: that number is the point past which the
 * app is willing to say you are AWAY, chosen generous so it rarely nags. This
 * one is the point at which it is willing to say you are HERE, and a wrong
 * "here" quietly files a photo on the neighbouring job.
 */
export const NEAR_JOB_M = 250;

function isFinitePoint(p: LatLng | null | undefined): p is LatLng {
  return p != null && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

/**
 * The single closest job within {@link NEAR_JOB_M}, or null when nothing can
 * honestly be said: no fix, no job coordinates, a fix too fuzzy to trust, or
 * nothing close enough.
 */
export function nearestJob(
  fix: DeviceFix | null | undefined,
  jobs: JobGeo[],
  radiusMeters: number = NEAR_JOB_M,
): NearbyJob | null {
  if (!isFinitePoint(fix)) return null;
  if (
    fix.accuracyM != null &&
    Number.isFinite(fix.accuracyM) &&
    fix.accuracyM > radiusMeters
  ) {
    return null;
  }
  let best: NearbyJob | null = null;
  for (const job of jobs) {
    if (!isFinitePoint(job)) continue;
    const meters = haversineMeters(fix, job);
    if (meters > radiusMeters) continue;
    if (!best || meters < best.meters) {
      best = { projectId: job.projectId, label: job.label, meters };
    }
  }
  return best;
}
