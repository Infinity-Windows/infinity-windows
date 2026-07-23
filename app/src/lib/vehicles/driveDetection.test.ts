import { describe, expect, it } from "vitest";
import {
  availableYears,
  detectDriveSessions,
  filterSessionsByYear,
  haversineMeters,
  metersToMiles,
  sessionYear,
  totalHours,
  totalMiles,
  type DriveFix,
} from "./driveDetection";

// ~0.000898 deg latitude ≈ 100 m; keep helpers so tests read in real distances.
const LAT0 = 40.0;
const LNG0 = -74.0;
const metersToLat = (m: number) => m / 111_320;
const at = (iso: string) => iso;

function fix(lat: number, lng: number, iso: string): DriveFix {
  return { lat, lng, at: at(iso) };
}

describe("haversineMeters", () => {
  it("is ~0 for the same point and grows with separation", () => {
    expect(haversineMeters(LAT0, LNG0, LAT0, LNG0)).toBeCloseTo(0, 5);
    const d = haversineMeters(LAT0, LNG0, LAT0 + metersToLat(100), LNG0);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(105);
  });

  it("converts meters to miles", () => {
    expect(metersToMiles(1609.344)).toBeCloseTo(1, 6);
  });
});

describe("detectDriveSessions", () => {
  it("returns nothing for fewer than two fixes", () => {
    expect(detectDriveSessions([])).toEqual([]);
    expect(detectDriveSessions([fix(LAT0, LNG0, "2026-01-01T10:00:00Z")])).toEqual([]);
  });

  it("ignores tiny jitter while parked (below movement thresholds)", () => {
    // ~5 m apart, one minute apart → ~0.19 mph, under both thresholds.
    const jitter: DriveFix[] = [];
    for (let i = 0; i < 6; i += 1) {
      jitter.push(
        fix(LAT0 + metersToLat(i % 2 === 0 ? 0 : 5), LNG0, `2026-01-01T10:0${i}:00Z`),
      );
    }
    expect(detectDriveSessions(jitter)).toEqual([]);
  });

  it("opens a drive on movement, accumulates distance, and closes after 5 min still", () => {
    const fixes: DriveFix[] = [
      fix(LAT0, LNG0, "2026-03-10T08:00:00Z"),
      fix(LAT0 + metersToLat(1000), LNG0, "2026-03-10T08:01:00Z"), // moving fast
      fix(LAT0 + metersToLat(2000), LNG0, "2026-03-10T08:02:00Z"),
      // now sits still for > 5 minutes → closes
      fix(LAT0 + metersToLat(2000), LNG0, "2026-03-10T08:04:00Z"),
      fix(LAT0 + metersToLat(2000), LNG0, "2026-03-10T08:10:00Z"),
    ];
    const sessions = detectDriveSessions(fixes);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.started_at).toBe("2026-03-10T08:00:00Z");
    // ended when it last moved (08:02), not while parked
    expect(s.ended_at).toBe("2026-03-10T08:02:00Z");
    expect(s.duration_seconds).toBe(120);
    expect(s.distance_miles).toBeGreaterThan(1.2);
    expect(s.distance_miles).toBeLessThan(1.3);
  });

  it("splits into two drives when a large time gap breaks the trail", () => {
    const fixes: DriveFix[] = [
      fix(LAT0, LNG0, "2026-03-10T08:00:00Z"),
      fix(LAT0 + metersToLat(1000), LNG0, "2026-03-10T08:01:00Z"),
      // 45-minute gap (> maxGap 30) → break
      fix(LAT0 + metersToLat(1000), LNG0, "2026-03-10T08:46:00Z"),
      fix(LAT0 + metersToLat(2000), LNG0, "2026-03-10T08:47:00Z"),
    ];
    const sessions = detectDriveSessions(fixes);
    expect(sessions).toHaveLength(2);
  });

  it("keeps a single drive through a short (<5 min) stop", () => {
    const fixes: DriveFix[] = [
      fix(LAT0, LNG0, "2026-03-10T08:00:00Z"),
      fix(LAT0 + metersToLat(1000), LNG0, "2026-03-10T08:01:00Z"),
      // 3-minute idle at a light (under close threshold)
      fix(LAT0 + metersToLat(1000), LNG0, "2026-03-10T08:04:00Z"),
      fix(LAT0 + metersToLat(2000), LNG0, "2026-03-10T08:05:00Z"),
    ];
    const sessions = detectDriveSessions(fixes);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ended_at).toBe("2026-03-10T08:05:00Z");
  });

  it("sorts unordered fixes before detecting", () => {
    const fixes: DriveFix[] = [
      fix(LAT0 + metersToLat(2000), LNG0, "2026-03-10T08:02:00Z"),
      fix(LAT0, LNG0, "2026-03-10T08:00:00Z"),
      fix(LAT0 + metersToLat(1000), LNG0, "2026-03-10T08:01:00Z"),
    ];
    const sessions = detectDriveSessions(fixes);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].started_at).toBe("2026-03-10T08:00:00Z");
  });
});

describe("aggregation helpers", () => {
  const sessions = [
    { started_at: "2025-12-31T23:00:00Z", distance_miles: 10, duration_seconds: 3600 },
    { started_at: "2026-06-01T10:00:00Z", distance_miles: 5.5, duration_seconds: 1800 },
    { started_at: "2026-07-01T10:00:00Z", distance_miles: 4.5, duration_seconds: 900 },
  ];

  it("totals miles and hours", () => {
    expect(totalMiles(sessions)).toBe(20);
    expect(totalHours(sessions)).toBe(1.75);
  });

  it("derives the calendar year of a start", () => {
    expect(sessionYear("2026-07-01T10:00:00Z")).toBe(2026);
    expect(sessionYear("not-a-date")).toBeNull();
  });

  it("filters by calendar year and lists available years newest-first", () => {
    const y2026 = filterSessionsByYear(sessions, 2026);
    expect(y2026).toHaveLength(2);
    expect(totalMiles(y2026)).toBe(10);
    expect(availableYears(sessions)).toEqual([2026, 2025]);
  });
});
