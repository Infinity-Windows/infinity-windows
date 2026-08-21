// Pure logic behind the storage flows: manifest grouping, aging, and the
// job-mismatch guard that flags a PECAN crate leaving under BLACK22.

import { describe, expect, it } from "vitest";
import {
  agingDays,
  damagePhotoPath,
  daysInStorage,
  defaultDeliveryLabel,
  groupByJob,
  hasPartNumber,
  mismatchedPackages,
  movementToPackageEvent,
  normalizeMarks,
  partLabel,
  type PackageEvent,
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

describe("daysInStorage", () => {
  const now = new Date("2026-08-14T18:00:00Z");
  const ev = (event: PackageEvent["event"], created_at: string) => ({ event, created_at });

  it("counts from the most recent 'stored' movement, not the others", () => {
    const events = [
      ev("checked_out", "2026-08-13T00:00:00Z"),
      ev("stored", "2026-08-10T00:00:00Z"),
      ev("bound", "2026-08-01T00:00:00Z"),
    ];
    expect(daysInStorage(events, now)).toBe(4);
  });

  it("uses the LATEST store when a package has been stored more than once", () => {
    // Checked out, came back, stored again — the older 'stored' row must not
    // win just because it's still in the history.
    const events = [
      ev("stored", "2026-08-12T00:00:00Z"),
      ev("checked_out", "2026-08-05T00:00:00Z"),
      ev("stored", "2026-08-01T00:00:00Z"),
    ];
    expect(daysInStorage(events, now)).toBe(2);
  });

  it("doesn't assume the events arrive newest-first", () => {
    const events = [
      ev("stored", "2026-08-01T00:00:00Z"),
      ev("stored", "2026-08-12T00:00:00Z"),
    ];
    expect(daysInStorage(events, now)).toBe(2);
  });

  it("is null when the package has never been stored", () => {
    expect(daysInStorage([ev("bound", "2026-08-01T00:00:00Z")], now)).toBeNull();
    expect(daysInStorage([], now)).toBeNull();
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

describe("part labels", () => {
  it("reads the whole label — number and piece", () => {
    expect(partLabel({ part_index: 2, part_total: 3, part_type: "glass" })).toBe(
      "Part 2 of 3 · Glass",
    );
  });

  it("works with either half alone", () => {
    expect(partLabel({ part_index: 2, part_total: 3, part_type: null })).toBe("Part 2 of 3");
    expect(partLabel({ part_type: "threshold" })).toBe("Threshold");
  });

  it("returns null when the label said nothing — callers show the flag", () => {
    expect(partLabel({})).toBeNull();
    expect(partLabel({ part_index: null, part_total: null, part_type: null })).toBeNull();
  });

  it("hasPartNumber needs both halves — half a fraction is no fraction", () => {
    expect(hasPartNumber({ part_index: 2, part_total: 3 })).toBe(true);
    expect(hasPartNumber({ part_index: 2, part_total: null })).toBe(false);
    expect(hasPartNumber({})).toBe(false);
  });
});

describe("damagePhotoPath", () => {
  it("is deterministic for the same job, package and moment", () => {
    expect(damagePhotoPath("job-1", "pkg-1", 1000)).toBe("job-1/pkg-1-1000.jpg");
  });

  it("never collides two packages photographed in the same job at the same instant", () => {
    expect(damagePhotoPath("job-1", "pkg-1", 1000)).not.toBe(
      damagePhotoPath("job-1", "pkg-2", 1000),
    );
  });

  it("never collides two jobs' packages that happen to share an id and a moment", () => {
    expect(damagePhotoPath("job-1", "pkg-1", 1000)).not.toBe(
      damagePhotoPath("job-2", "pkg-1", 1000),
    );
  });
});

describe("movementToPackageEvent", () => {
  const base = {
    id: "m1",
    package_id: "p1",
    project_id: null,
    reason: null,
    actor: "ammon",
    created_at: "2026-08-17T00:00:00Z",
  };

  it("a store reads its destination", () => {
    const e = movementToPackageEvent({ ...base, event: "stored", to_container_id: "conex" });
    expect(e.container_id).toBe("conex");
    expect(e.event).toBe("stored");
  });

  it("a checkout reads the container it LEFT — same as the old log", () => {
    const e = movementToPackageEvent({
      ...base,
      event: "checked_out",
      from_container_id: "conex",
      project_id: "job",
      reason: "install day",
    });
    expect(e.container_id).toBe("conex");
    expect(e.reason).toBe("install day");
  });

  it("a ride-along move keeps naming the box it sat in", () => {
    const e = movementToPackageEvent({
      ...base,
      event: "moved",
      to_container_id: "crate",
      reason: "rode along — Crate 7 moved",
    });
    expect(e.container_id).toBe("crate");
  });

  it("no context at all maps to null, not undefined", () => {
    expect(movementToPackageEvent({ ...base, event: "bound" }).container_id).toBeNull();
  });
});
