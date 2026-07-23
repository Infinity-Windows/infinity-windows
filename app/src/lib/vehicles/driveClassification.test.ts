import { describe, expect, it } from "vitest";
import {
  businessTotals,
  classifyDrive,
  intervalsOverlap,
  personalTotals,
  shiftsToIntervals,
  type ClockInterval,
} from "./driveClassification";

const DRIVER = "driver-1";
const OTHER = "driver-2";
const NOW = Date.parse("2026-07-23T23:00:00Z");

const drive = (start: string, end: string) => ({ started_at: start, ended_at: end });

describe("shiftsToIntervals", () => {
  it("keeps closed shifts and extends open shifts to the open-end", () => {
    const iv = shiftsToIntervals(
      [
        { profile_id: DRIVER, clock_in_at: "2026-07-23T08:00:00Z", clock_out_at: "2026-07-23T16:00:00Z" },
        { profile_id: DRIVER, clock_in_at: "2026-07-23T22:00:00Z", clock_out_at: null },
      ],
      NOW,
    );
    expect(iv).toHaveLength(2);
    expect(iv[1].end_ms).toBe(NOW);
  });

  it("drops unparseable or zero/negative-length shifts", () => {
    const iv = shiftsToIntervals(
      [
        { profile_id: DRIVER, clock_in_at: "nope", clock_out_at: null },
        { profile_id: DRIVER, clock_in_at: "2026-07-23T10:00:00Z", clock_out_at: "2026-07-23T10:00:00Z" },
      ],
      NOW,
    );
    expect(iv).toHaveLength(0);
  });
});

describe("intervalsOverlap", () => {
  it("detects any shared time and rejects touching-but-not-overlapping", () => {
    expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(5, 6, 0, 100)).toBe(true);
  });
});

describe("classifyDrive", () => {
  const shiftIv: ClockInterval[] = [
    { profile_id: DRIVER, start_ms: Date.parse("2026-07-23T08:00:00Z"), end_ms: Date.parse("2026-07-23T16:00:00Z") },
  ];

  it("marks a drive BUSINESS when it fully sits inside a clocked-in shift", () => {
    const res = classifyDrive(drive("2026-07-23T09:00:00Z", "2026-07-23T09:30:00Z"), [DRIVER], shiftIv);
    expect(res).toEqual({ business: true, driver_id: DRIVER });
  });

  it("counts PARTIAL overlap as business", () => {
    // Drive starts before clock-in but overlaps the first minutes of the shift.
    const res = classifyDrive(drive("2026-07-23T07:45:00Z", "2026-07-23T08:10:00Z"), [DRIVER], shiftIv);
    expect(res.business).toBe(true);
    expect(res.driver_id).toBe(DRIVER);
  });

  it("is PERSONAL when the drive is outside every shift (safety default)", () => {
    const res = classifyDrive(
      drive("2026-07-23T18:00:00Z", "2026-07-23T18:30:00Z"),
      [DRIVER],
      shiftIv,
      DRIVER,
    );
    expect(res.business).toBe(false);
    expect(res.driver_id).toBe(DRIVER); // recorded for the log, still uncounted
  });

  it("is PERSONAL when there are no known drivers", () => {
    expect(classifyDrive(drive("2026-07-23T09:00:00Z", "2026-07-23T09:30:00Z"), [], shiftIv)).toEqual({
      business: false,
      driver_id: null,
    });
  });

  it("ignores shifts that belong to a different driver", () => {
    const res = classifyDrive(drive("2026-07-23T09:00:00Z", "2026-07-23T09:30:00Z"), [OTHER], shiftIv);
    expect(res.business).toBe(false);
  });

  it("is PERSONAL for an unparseable drive window", () => {
    expect(classifyDrive(drive("bad", "worse"), [DRIVER], shiftIv).business).toBe(false);
  });
});

describe("business/personal totals", () => {
  const sessions = [
    { business: true, distance_miles: 10, duration_seconds: 3600 },
    { business: true, distance_miles: 5, duration_seconds: 1800 },
    { business: false, distance_miles: 8, duration_seconds: 2400 },
  ];

  it("sums business drives only for the write-off number", () => {
    expect(businessTotals(sessions)).toEqual({ miles: 15, hours: 1.5 });
  });

  it("keeps personal as a separate subtotal", () => {
    expect(personalTotals(sessions)).toEqual({ miles: 8, hours: 0.67 });
  });
});
