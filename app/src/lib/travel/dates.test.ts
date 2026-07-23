import { describe, expect, it } from "vitest";
import {
  arriveByISO,
  defaultMinutesBeforeDeparture,
  formatDateTimeWithZone,
  formatTimeInZone,
  formatTimeWithZone,
  humanizeCountdown,
  leaveByISO,
  msUntil,
  utcToZonedWallTime,
  zoneAbbrev,
  zonedWallTimeToUtc,
} from "./dates";

describe("defaultMinutesBeforeDeparture", () => {
  it("is 120 domestic, 180 international", () => {
    expect(defaultMinutesBeforeDeparture(false)).toBe(120);
    expect(defaultMinutesBeforeDeparture(true)).toBe(180);
  });
});

describe("arriveByISO / leaveByISO", () => {
  const depart = "2026-07-21T12:15:00.000Z"; // 6:15 AM MDT in Denver

  it("subtracts the airport buffer from departure", () => {
    expect(arriveByISO(depart, 120)).toBe("2026-07-21T10:15:00.000Z");
  });

  it("subtracts buffer + drive time for leave-by", () => {
    expect(leaveByISO(depart, 120, 40)).toBe("2026-07-21T09:35:00.000Z");
  });

  it("returns null leave-by without a drive estimate", () => {
    expect(leaveByISO(depart, 120, null)).toBeNull();
  });

  it("is null-safe on a missing departure", () => {
    expect(arriveByISO(null, 120)).toBeNull();
    expect(leaveByISO(undefined, 120, 30)).toBeNull();
  });

  it("clamps negative buffers/drive times to zero", () => {
    expect(arriveByISO(depart, -30)).toBe(depart);
    expect(leaveByISO(depart, 120, -10)).toBe("2026-07-21T10:15:00.000Z");
  });
});

describe("formatTimeWithZone", () => {
  it("renders the airport's local time with the zone label (summer = MDT)", () => {
    expect(formatTimeWithZone("2026-07-21T12:15:00Z", "America/Denver")).toBe(
      "6:15 AM MDT",
    );
  });

  it("is DST-correct (winter same clock offset shows MST)", () => {
    expect(formatTimeWithZone("2026-01-21T13:15:00Z", "America/Denver")).toBe(
      "6:15 AM MST",
    );
  });

  it("renders a different arrival zone correctly", () => {
    // 12:15Z is 8:15 AM EDT in New York in July.
    expect(formatTimeWithZone("2026-07-21T12:15:00Z", "America/New_York")).toBe(
      "8:15 AM EDT",
    );
  });

  it("falls back to UTC on a bad zone instead of throwing", () => {
    expect(formatTimeWithZone("2026-07-21T12:15:00Z", "Not/AZone")).toBe(
      "12:15 PM UTC",
    );
  });

  it("is null-safe", () => {
    expect(formatTimeWithZone(null, "America/Denver")).toBeNull();
  });
});

describe("formatTimeInZone / zoneAbbrev / formatDateTimeWithZone", () => {
  it("formats time without a zone label", () => {
    expect(formatTimeInZone("2026-07-21T12:15:00Z", "America/Denver")).toBe("6:15 AM");
  });

  it("extracts just the zone abbreviation", () => {
    expect(zoneAbbrev("2026-07-21T12:15:00Z", "America/Denver")).toBe("MDT");
    expect(zoneAbbrev("2026-01-21T12:15:00Z", "America/Denver")).toBe("MST");
  });

  it("combines day + time + zone", () => {
    expect(formatDateTimeWithZone("2026-07-21T12:15:00Z", "America/Denver")).toBe(
      "Tue, Jul 21 · 6:15 AM MDT",
    );
  });
});

describe("zonedWallTimeToUtc / utcToZonedWallTime", () => {
  it("converts a Denver summer wall time to the right UTC instant (MDT)", () => {
    expect(zonedWallTimeToUtc("2026-07-21T06:15", "America/Denver")).toBe(
      "2026-07-21T12:15:00.000Z",
    );
  });

  it("converts a Denver winter wall time (MST) correctly", () => {
    expect(zonedWallTimeToUtc("2026-01-21T06:15", "America/Denver")).toBe(
      "2026-01-21T13:15:00.000Z",
    );
  });

  it("round-trips UTC → wall → UTC in a zone", () => {
    const utc = "2026-07-21T12:15:00.000Z";
    const wall = utcToZonedWallTime(utc, "America/Denver");
    expect(wall).toBe("2026-07-21T06:15");
    expect(zonedWallTimeToUtc(wall, "America/Denver")).toBe(utc);
  });

  it("is null/empty safe", () => {
    expect(zonedWallTimeToUtc("", "America/Denver")).toBeNull();
    expect(zonedWallTimeToUtc(null, "America/Denver")).toBeNull();
    expect(utcToZonedWallTime(null, "America/Denver")).toBe("");
  });
});

describe("msUntil / humanizeCountdown", () => {
  const now = Date.parse("2026-07-21T12:00:00Z");

  it("computes ms until an instant", () => {
    expect(msUntil("2026-07-21T12:30:00Z", now)).toBe(30 * 60 * 1000);
  });

  it("humanizes upcoming instants", () => {
    expect(humanizeCountdown("2026-07-21T12:25:00Z", now)).toBe("in 25 min");
    expect(humanizeCountdown("2026-07-21T15:00:00Z", now)).toBe("in 3 hr");
    expect(humanizeCountdown("2026-07-23T12:00:00Z", now)).toBe("in 2 days");
  });

  it("returns null once the instant is in the past", () => {
    expect(humanizeCountdown("2026-07-21T11:00:00Z", now)).toBeNull();
  });
});
