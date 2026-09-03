// The clock-in proximity check: distance maths, and the SOFT "far from job"
// rule that only ever whispers. The rule's whole job is to say nothing unless
// it is sure, so the uncertain cases matter as much as the far one.

import { describe, expect, it } from "vitest";
import { FAR_FROM_JOB_M, farFromJob, haversineMeters } from "./jobProximity";

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters({ lat: 40.76, lng: -111.89 }, { lat: 40.76, lng: -111.89 })).toBe(0);
  });

  it("reads one degree of longitude at the equator as ~111 km", () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("is symmetric", () => {
    const a = { lat: 40.5, lng: -111.9 };
    const b = { lat: 40.51, lng: -111.88 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("farFromJob (advisory only)", () => {
  const job = { lat: 40.7608, lng: -111.891 }; // where the job's clock-ins land

  it("is false when you're right on the job", () => {
    expect(farFromJob({ lat: 40.7608, lng: -111.891 }, job)).toBe(false);
  });

  it("is false a few hundred metres out (inside the threshold)", () => {
    // ~0.004° lat ≈ 445 m north — comfortably inside 800 m.
    expect(farFromJob({ lat: 40.7648, lng: -111.891 }, job)).toBe(false);
  });

  it("is true well outside the threshold", () => {
    // ~0.02° lat ≈ 2.2 km north.
    expect(farFromJob({ lat: 40.7808, lng: -111.891 }, job)).toBe(true);
  });

  it("respects a custom threshold", () => {
    const near = { lat: 40.7648, lng: -111.891 }; // ~445 m
    expect(farFromJob(near, job, 300)).toBe(true);
    expect(farFromJob(near, job, 800)).toBe(false);
  });

  it("says nothing when a point is missing", () => {
    expect(farFromJob(null, job)).toBe(false);
    expect(farFromJob({ lat: 40.78, lng: -111.9 }, null)).toBe(false);
    expect(farFromJob(undefined, undefined)).toBe(false);
  });

  it("says nothing when coordinates aren't real numbers", () => {
    expect(farFromJob({ lat: NaN, lng: -111.9 }, job)).toBe(false);
    expect(farFromJob({ lat: 40.78, lng: Infinity }, job)).toBe(false);
  });

  it("holds its tongue when the fix is fuzzier than the threshold", () => {
    // 2 km out, but the fix could be anywhere within 1 km — can't call it.
    const fuzzy = { lat: 40.7808, lng: -111.891, accuracyM: 1000 };
    expect(farFromJob(fuzzy, job)).toBe(false);
    // The same distance with a tight fix does earn the note.
    const tight = { lat: 40.7808, lng: -111.891, accuracyM: 15 };
    expect(farFromJob(tight, job)).toBe(true);
  });

  it("defaults its threshold to FAR_FROM_JOB_M", () => {
    expect(FAR_FROM_JOB_M).toBe(800);
  });
});
