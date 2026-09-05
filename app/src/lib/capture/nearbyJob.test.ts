import { describe, expect, it } from "vitest";
import { NEAR_JOB_M, nearestJob, type JobGeo } from "./nearbyJob";

// Austin, roughly. Latitude degrees are ~111km apart, so 0.001° ≈ 111m —
// enough to put jobs a known distance apart without hand-rolling a projection.
const HERE = { lat: 30.2672, lng: -97.7431 };
const job = (projectId: string, dLat: number): JobGeo => ({
  projectId,
  label: projectId.toUpperCase(),
  lat: HERE.lat + dLat,
  lng: HERE.lng,
});

const CLOSE = job("black22", 0.0005); // ~55m
const NEARBY = job("pecan14", 0.0015); // ~166m
const FAR = job("oakridge", 0.01); // ~1.1km

describe("nearestJob", () => {
  it("names the closest job inside the radius", () => {
    const hit = nearestJob(HERE, [FAR, NEARBY, CLOSE]);
    expect(hit?.projectId).toBe("black22");
    expect(hit?.meters).toBeLessThan(NEAR_JOB_M);
  });

  it("says nothing when everything is too far — silence beats a wrong guess", () => {
    expect(nearestJob(HERE, [FAR])).toBeNull();
  });

  it("says nothing with no fix at all", () => {
    expect(nearestJob(null, [CLOSE])).toBeNull();
    expect(nearestJob(undefined, [CLOSE])).toBeNull();
  });

  it("says nothing when no job has ever been clocked into with location on", () => {
    expect(nearestJob(HERE, [])).toBeNull();
  });

  // The one that matters most in the field: a phone indoors reports a fix with
  // a kilometre of slop. Trusting it would nominate whichever job happened to
  // be nearest and file the photo there with total confidence.
  it("refuses a fix fuzzier than the radius", () => {
    expect(nearestJob({ ...HERE, accuracyM: NEAR_JOB_M + 1 }, [CLOSE])).toBeNull();
  });

  it("accepts a fix tighter than the radius", () => {
    expect(nearestJob({ ...HERE, accuracyM: 9 }, [CLOSE])?.projectId).toBe("black22");
  });

  it("skips a job whose coordinates are not real numbers", () => {
    const broken = { projectId: "junk", label: "JUNK", lat: Number.NaN, lng: 0 };
    expect(nearestJob(HERE, [broken, CLOSE])?.projectId).toBe("black22");
  });

  it("takes a wider radius when asked, and still returns only one winner", () => {
    const hit = nearestJob(HERE, [FAR, NEARBY], 2_000);
    expect(hit?.projectId).toBe("pecan14");
  });
});
