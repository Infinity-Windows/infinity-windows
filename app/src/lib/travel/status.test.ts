import { describe, expect, it } from "vitest";
import { areCodesVisible, phaseLabel, tripPhase, tripSortKey } from "./status";

describe("tripPhase", () => {
  it("is upcoming before the start date", () => {
    expect(tripPhase("2026-08-01", "2026-08-05", "2026-07-21")).toBe("upcoming");
  });
  it("is in_progress within the range (inclusive)", () => {
    expect(tripPhase("2026-07-20", "2026-07-25", "2026-07-20")).toBe("in_progress");
    expect(tripPhase("2026-07-20", "2026-07-25", "2026-07-25")).toBe("in_progress");
    expect(tripPhase("2026-07-20", "2026-07-25", "2026-07-22")).toBe("in_progress");
  });
  it("is past after the end date", () => {
    expect(tripPhase("2026-07-01", "2026-07-05", "2026-07-21")).toBe("past");
  });
});

describe("areCodesVisible", () => {
  it("keeps codes visible for upcoming and in-progress trips", () => {
    expect(areCodesVisible("2026-08-01", "2026-08-05", "2026-07-21")).toBe(true);
    expect(areCodesVisible("2026-07-20", "2026-07-25", "2026-07-22")).toBe(true);
  });
  it("hides codes once the trip is over", () => {
    expect(areCodesVisible("2026-07-01", "2026-07-05", "2026-07-21")).toBe(false);
  });
});

describe("phaseLabel", () => {
  it("maps phases to chips", () => {
    expect(phaseLabel("upcoming")).toBe("Upcoming");
    expect(phaseLabel("in_progress")).toBe("In progress");
    expect(phaseLabel("past")).toBe("Past");
  });
});

describe("tripSortKey", () => {
  const today = "2026-07-21";
  it("orders in-progress before upcoming before past", () => {
    const inProgress = tripSortKey("2026-07-20", "2026-07-25", today);
    const upcoming = tripSortKey("2026-08-01", "2026-08-05", today);
    const past = tripSortKey("2026-06-01", "2026-06-05", today);
    expect(inProgress < upcoming).toBe(true);
    expect(upcoming < past).toBe(true);
  });
  it("puts the most recent past trip first among past trips", () => {
    const older = tripSortKey("2026-05-01", "2026-05-05", today);
    const newer = tripSortKey("2026-06-01", "2026-06-05", today);
    expect(newer < older).toBe(true);
  });
  it("puts the soonest upcoming trip first", () => {
    const soon = tripSortKey("2026-08-01", "2026-08-05", today);
    const later = tripSortKey("2026-09-01", "2026-09-05", today);
    expect(soon < later).toBe(true);
  });
});
