import { describe, expect, it } from "vitest";
import { formatLogDateLabel, jobsNeedingLog, localDateISO } from "./dailyLogDay";

describe("localDateISO", () => {
  it("returns the local calendar day as YYYY-MM-DD", () => {
    // Noon is nowhere near a local-midnight boundary in any real timezone,
    // so this is a safe instant to pin without flaking in CI.
    const noon = new Date(2026, 7, 20, 12, 0, 0); // months are 0-based: Aug 20
    expect(localDateISO(noon)).toBe("2026-08-20");
  });

  it("defaults to right now when called with nothing", () => {
    const before = localDateISO(new Date());
    expect(localDateISO()).toBe(before);
  });
});

describe("formatLogDateLabel", () => {
  it("reads a log_date as LOCAL midnight, not UTC — never the day before", () => {
    // The Horizon bug's shape: new Date("2026-08-20") alone is UTC midnight,
    // which is the evening of the 19th in every US timezone. Parsed as
    // local midnight (this function's job), the calendar day must never
    // slip backward.
    const label = formatLogDateLabel("2026-08-20");
    expect(label).toContain("20");
    expect(label).not.toContain("19");
  });
});

describe("jobsNeedingLog", () => {
  it("keeps a worked job that has no log yet", () => {
    expect(jobsNeedingLog(["p1"], [])).toEqual(["p1"]);
  });

  it("drops a worked job that already has today's log", () => {
    expect(jobsNeedingLog(["p1", "p2"], ["p1"])).toEqual(["p2"]);
  });

  it("de-duplicates a job worked by more than one person (a shift AND a session)", () => {
    expect(jobsNeedingLog(["p1", "p1", "p1"], [])).toEqual(["p1"]);
  });

  it("returns nothing when everything worked today is already logged", () => {
    expect(jobsNeedingLog(["p1", "p2"], ["p1", "p2"])).toEqual([]);
  });

  it("returns nothing when nobody worked today", () => {
    expect(jobsNeedingLog([], [])).toEqual([]);
  });

  it("preserves first-seen order", () => {
    expect(jobsNeedingLog(["p3", "p1", "p2"], ["p1"])).toEqual(["p3", "p2"]);
  });
});
