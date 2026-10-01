import { describe, expect, it } from "vitest";
import { formatConflictClock } from "./conflictDisplay";

describe("conflict clock labels", () => {
  it("keeps seconds when they change the reported overlap", () => {
    expect(formatConflictClock("11:00:10", "en")).toMatch(/11:00:10\sAM/);
    expect(formatConflictClock("11:00:30", "en")).toMatch(/11:00:30\sAM/);
    expect(formatConflictClock("11:00:00", "en")).toMatch(/11:00\sAM/);
  });
  it("does not normalize invalid stored hours into plausible clock times", () => {
    for (const value of [null, "", "25:00", "07:99", "07:30:60", "bad", "7:00"]) {
      expect(formatConflictClock(value, "en")).toBeNull();
    }
  });
  it("uses Spanish clock formatting independently of the browser language", () => {
    expect(formatConflictClock("13:05", "es")).toBe("13:05");
    expect(formatConflictClock("13:05:30", "es")).toBe("13:05:30");
  });
});
