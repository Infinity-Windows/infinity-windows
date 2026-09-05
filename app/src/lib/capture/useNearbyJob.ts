// "You're near <job>" — the React half.
//
// THE ONE RULE: this never makes anybody wait. The Capture sheet's whole point
// is that it opens instantly wherever a person is standing, and GPS indoors —
// which is where windows get installed — routinely takes eight seconds. So the
// chip either appears or it does not, and either way every tile on the sheet
// was tappable from the first frame.
//
// How that is kept true:
//   * The fix comes from the warm holder the capture surfaces already share
//     (lib/geoWatch.ts), not a fresh high-accuracy lookup.
//   * It is waited on for two seconds, once. Past that there is no chip; the
//     recent-job chips underneath were always the real answer anyway.
//   * The job coordinates are one query (listJobLastGeos), and a failure is
//     swallowed — a suggestion that cannot be computed is a suggestion that
//     does not appear, never an error on a screen someone opened to take a
//     photo.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWarmGeoFix, warmGeoFix } from "../geoWatch";
import { listJobLastGeos } from "../timeclock";
import type { Project } from "../types";
import type { DeviceFix } from "../jobProximity";
import { nearestJob, type JobGeo, type NearbyJob } from "./nearbyJob";

/** How long the chip is willing to wait for a first fix before giving up. */
export const CHIP_FIX_WAIT_MS = 2_000;

/**
 * The single job the phone appears to be standing on, or null. Safe to call
 * with `active: false` (the sheet is closed) — it starts no watch and no query.
 */
export function useNearbyJob(active: boolean, projects: Project[] | undefined): NearbyJob | null {
  // Ref-counted; stops with the last screen that wanted it. The capture sheet
  // wants it for the same reason the camera does — except here it is to name a
  // job, not to stamp a photo.
  useWarmGeoFix(active);

  const [fix, setFix] = useState<DeviceFix | null>(null);
  useEffect(() => {
    if (!active) {
      setFix(null);
      return;
    }
    let cancelled = false;
    void warmGeoFix.waitFor(CHIP_FIX_WAIT_MS).then((f) => {
      if (cancelled) return;
      if (typeof f.lat === "number" && typeof f.lng === "number") {
        setFix({ lat: f.lat, lng: f.lng, accuracyM: f.accuracyM });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const projectIds = useMemo(() => (projects ?? []).map((p) => p.id), [projects]);

  const geos = useQuery({
    queryKey: ["jobLastGeos", projectIds.length],
    queryFn: () => listJobLastGeos(projectIds),
    // Only once there is a fix to compare against: with no fix the answer is
    // null whatever comes back, so the read would be pure cost.
    enabled: active && fix != null && projectIds.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return useMemo(() => {
    if (!active || !fix || !geos.data) return null;
    const jobs: JobGeo[] = [];
    for (const p of projects ?? []) {
      const g = geos.data.get(p.id);
      if (g) jobs.push({ projectId: p.id, label: p.job_code || p.name, ...g });
    }
    return nearestJob(fix, jobs);
  }, [active, fix, geos.data, projects]);
}
