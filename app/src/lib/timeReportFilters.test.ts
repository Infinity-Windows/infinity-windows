import { describe, expect, it } from "vitest";
import { customTimeRange, dateFieldValue, includesJob, NO_JOB } from "./timeReportFilters";

describe("job selection", () => {
  it("distinguishes all jobs, no jobs, multiple jobs and unassigned hours", () => {
    expect(includesJob(null, "a")).toBe(true);
    expect(includesJob(null, null)).toBe(true);
    expect(includesJob([], "a")).toBe(false);
    expect(includesJob([], null)).toBe(false);
    expect(includesJob(["a", "b"], "b")).toBe(true);
    expect(includesJob(["a", "b"], "c")).toBe(false);
    expect(includesJob(["a", "b"], null)).toBe(false);
    expect(includesJob([NO_JOB], null)).toBe(true);
  });
});

describe("custom report dates", () => {
  it("includes the full last calendar day and preserves local midnight", () => {
    const result = customTimeRange("2026-09-01", "2026-09-16");
    expect(result.error).toBeNull();
    if (result.error) throw new Error(result.error);
    expect(result.startIso).toBe(new Date(2026, 8, 1).toISOString());
    expect(result.endIso).toBe(new Date(2026, 8, 17).toISOString());
  });
  it("allows a single day and month/year boundaries", () => {
    const result = customTimeRange("2026-12-31", "2026-12-31");
    expect(result.error).toBeNull();
    if (result.error) throw new Error(result.error);
    expect(dateFieldValue(result.start)).toBe("2026-12-31");
    expect(result.endIso).toBe(new Date(2027, 0, 1).toISOString());
  });
  it.each([
    ["", "2026-09-16", "missing"], ["2026-09-16", "", "missing"],
    ["2026-09-17", "2026-09-16", "order"], ["2026-02-30", "2026-03-01", "invalid"],
    ["2026-02-29", "2026-03-01", "invalid"], ["2026-9-1", "2026-09-16", "invalid"],
  ])("rejects %s through %s without becoming all time", (from, through, error) => {
    expect(customTimeRange(from, through)).toEqual({ error });
  });
  it("accepts a leap day", () => {
    expect(customTimeRange("2028-02-29", "2028-02-29").error).toBeNull();
  });
  it("advances by a calendar day across both daylight-saving boundaries", () => {
    for (const [day, year, month, date] of [["2026-03-08", 2026, 2, 9], ["2026-11-01", 2026, 10, 2]] as const) {
      const result = customTimeRange(day, day);
      if (result.error) throw new Error(result.error);
      expect(result.endIso).toBe(new Date(year, month, date).toISOString());
      expect(new Date(result.endIso).getHours()).toBe(0);
    }
  });
});
