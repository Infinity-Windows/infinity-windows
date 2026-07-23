import { describe, expect, it } from "vitest";
import { isValidLatLng, lastSeenLabel, locationStatus } from "./location";

const NOW = Date.parse("2026-07-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("locationStatus", () => {
  it("buckets by age: live < 2min, recent < 30min, else stale", () => {
    expect(locationStatus(ago(30_000), NOW)).toBe("live");
    expect(locationStatus(ago(1 * MIN), NOW)).toBe("live");
    expect(locationStatus(ago(10 * MIN), NOW)).toBe("recent");
    expect(locationStatus(ago(45 * MIN), NOW)).toBe("stale");
    expect(locationStatus(ago(3 * 24 * 60 * MIN), NOW)).toBe("stale");
  });

  it("treats missing/invalid timestamps as none", () => {
    expect(locationStatus(null, NOW)).toBe("none");
    expect(locationStatus(undefined, NOW)).toBe("none");
    expect(locationStatus("not-a-date", NOW)).toBe("none");
  });

  it("treats future timestamps (clock skew) as live", () => {
    expect(locationStatus(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe("live");
  });
});

describe("lastSeenLabel", () => {
  it("renders human relative time", () => {
    expect(lastSeenLabel(ago(20_000), NOW)).toBe("Just now");
    expect(lastSeenLabel(ago(5 * MIN), NOW)).toBe("5 min ago");
    expect(lastSeenLabel(ago(2 * 60 * MIN), NOW)).toBe("2 hr ago");
    expect(lastSeenLabel(ago(24 * 60 * MIN), NOW)).toBe("1 day ago");
    expect(lastSeenLabel(ago(3 * 24 * 60 * MIN), NOW)).toBe("3 days ago");
  });
  it("handles missing data", () => {
    expect(lastSeenLabel(null, NOW)).toBe("No location yet");
  });
});

describe("isValidLatLng", () => {
  it("accepts real coordinates and rejects out-of-range / null island", () => {
    expect(isValidLatLng(40.71, -74.0)).toBe(true);
    expect(isValidLatLng(0, 0)).toBe(false);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, 200)).toBe(false);
    expect(isValidLatLng(NaN, 5)).toBe(false);
  });
});
