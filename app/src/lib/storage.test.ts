// Pure logic behind the storage flows: manifest grouping, aging, and the
// job-mismatch guard that flags a PECAN crate leaving under BLACK22.

import { describe, expect, it } from "vitest";
import {
  agingDays,
  defaultDeliveryLabel,
  groupByJob,
  mismatchedPackages,
  normalizeMarks,
} from "./storage";

const pkg = (project_id: string | null) => ({ project_id });

describe("groupByJob", () => {
  it("groups by job, biggest first, unbound last", () => {
    const groups = groupByJob([
      pkg("black"), pkg("pecan"), pkg("black"), pkg(null), pkg("black"),
    ]);
    expect(groups.map((g) => g.projectId)).toEqual(["black", "pecan", null]);
    expect(groups[0].packages).toHaveLength(3);
  });

  it("handles empty input", () => {
    expect(groupByJob([])).toEqual([]);
  });
});

describe("agingDays", () => {
  const now = new Date("2026-08-14T18:00:00Z");
  it("counts whole days since binding", () => {
    expect(agingDays("2026-08-01T12:00:00Z", now)).toBe(13);
    expect(agingDays("2026-08-14T06:00:00Z", now)).toBe(0);
  });
  it("returns null for unbound or garbage", () => {
    expect(agingDays(null, now)).toBeNull();
    expect(agingDays("not-a-date", now)).toBeNull();
  });
  it("never goes negative on clock skew", () => {
    expect(agingDays("2026-08-15T00:00:00Z", now)).toBe(0);
  });
});

describe("mismatchedPackages", () => {
  it("flags only packages bound to a DIFFERENT job", () => {
    const flagged = mismatchedPackages(
      [pkg("black"), pkg("pecan"), pkg(null), pkg("black")],
      "black",
    );
    expect(flagged).toEqual([pkg("pecan")]);
  });
});

describe("defaultDeliveryLabel", () => {
  it("names today's truck the way a crew would", () => {
    expect(defaultDeliveryLabel(new Date(2026, 7, 14))).toBe("Delivery Aug 14");
  });
});

describe("normalizeMarks", () => {
  it("reads the new shape — codes joined through project_marks", () => {
    expect(
      normalizeMarks([{ mark: { mark_code: "16" } }, { mark: { mark_code: "13A" } }]),
    ).toEqual([{ mark_code: "16" }, { mark_code: "13A" }]);
  });

  it("reads the legacy shape — bare codes from before the migration", () => {
    expect(normalizeMarks([{ mark_code: "16" }])).toEqual([{ mark_code: "16" }]);
  });

  it("drops rows with no code at all rather than inventing blanks", () => {
    expect(
      normalizeMarks([{ mark: null }, { mark_code: null }, { mark: { mark_code: "4A" } }]),
    ).toEqual([{ mark_code: "4A" }]);
  });

  it("treats a missing join as an empty list, not a crash", () => {
    expect(normalizeMarks(null)).toEqual([]);
    expect(normalizeMarks(undefined)).toEqual([]);
  });
});
