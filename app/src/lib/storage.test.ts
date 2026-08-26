// Pure logic behind the storage flows: manifest grouping, aging, and the
// job-mismatch guard that flags a PECAN crate leaving under BLACK22.

import { describe, expect, it } from "vitest";
import {
  agingDays,
  containerHue,
  damagePhotoPath,
  daysInStorage,
  defaultDeliveryLabel,
  groupByJob,
  hasPartNumber,
  mismatchedPackages,
  movementToPackageEvent,
  jobLabel,
  normalizeMarks,
  packagePhotoPath,
  packageTitle,
  partLabel,
  posterAutoOpenPath,
  type PackageEvent,
  type StoragePackage,
} from "./storage";

const pkg = (project_id: string | null) => ({ project_id });

// The one-voice name (owner, 2026-08-26): the sheet's H1 rule, shared with
// every list row. These pin the exact strings the crew reads.
describe("packageTitle", () => {
  const jobs = new Map([["j1", "BLACK22"]]);
  const base = {
    project_id: null,
    pending_job_name: null,
    mfr_mark: null,
    part_index: null,
    part_total: null,
    part_type: null,
    piece_count: null,
    serial: "PKG-000311",
  } as Pick<
    StoragePackage,
    | "project_id"
    | "pending_job_name"
    | "mfr_mark"
    | "part_index"
    | "part_total"
    | "part_type"
    | "piece_count"
    | "serial"
  > & { package_marks?: { mark_code: string }[] };

  it("bound job + bound mark + fraction", () => {
    expect(
      packageTitle(
        {
          ...base,
          project_id: "j1",
          package_marks: [{ mark_code: "16" }],
          part_index: 1,
          part_total: 4,
        },
        jobs,
      ),
    ).toBe("BLACK22 #16: 1/4");
  });

  it("waiting job + manufacturer mark — the screenshot case", () => {
    expect(
      packageTitle(
        {
          ...base,
          pending_job_name: "Hyer Res_Old Mill Estates Lot 47",
          mfr_mark: "33",
          part_index: 1,
          part_total: 1,
        },
        jobs,
      ),
    ).toBe("Hyer Res_Old Mill Estates Lot 47 #33: 1/1");
  });

  it("crate pool speaks in pieces", () => {
    expect(
      packageTitle(
        { ...base, pending_job_name: "Mad Moose", mfr_mark: "CRATE 1", piece_count: 5 },
        jobs,
      ),
    ).toBe("Mad Moose #CRATE 1: 5 pc glass");
  });

  it("no mark: the waiting-job name alone beats the serial", () => {
    expect(packageTitle({ ...base, pending_job_name: "Mad Moose" }, jobs)).toBe("Mad Moose");
  });

  it("true boneyard with no mark falls back to the serial", () => {
    expect(packageTitle(base, jobs)).toBe("PKG-000311");
  });
});

describe("jobLabel", () => {
  const jobs = new Map([["j1", "BLACK22"]]);
  const jp = (over: Partial<Parameters<typeof jobLabel>[0]>) =>
    jobLabel(
      { project_id: null, status: "stored", pending_job_name: null, ...over },
      jobs,
    );

  it("waiting material is not Boneyard", () => {
    expect(jp({ pending_job_name: "Mad Moose" })).toBe("waiting on job");
  });

  it("unbound with no waiting name stays Boneyard", () => {
    expect(jp({})).toBe("Boneyard");
  });

  it("bound reads its job code; blank says nothing", () => {
    expect(jp({ project_id: "j1" })).toBe("BLACK22");
    expect(jp({ status: "blank" })).toBe("");
  });
});

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

describe("packagePhotoPath", () => {
  it("is deterministic for the same package, moment and suffix", () => {
    expect(packagePhotoPath("pkg-1", 1000, "ab12cd")).toBe(
      "packages/pkg-1/1000-ab12cd.jpg",
    );
  });

  it("never collides two photos of the same package in the same instant", () => {
    // Unlike damagePhotoPath (one report, one photo), "Add a photo" can queue
    // several shots at once — the random suffix is what keeps them apart.
    expect(packagePhotoPath("pkg-1", 1000, "aaaaaa")).not.toBe(
      packagePhotoPath("pkg-1", 1000, "bbbbbb"),
    );
  });

  it("never collides two packages photographed in the same instant", () => {
    expect(packagePhotoPath("pkg-1", 1000, "ab12cd")).not.toBe(
      packagePhotoPath("pkg-2", 1000, "ab12cd"),
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

/**
 * Pick 31: a poster scan should skip straight to the living 3D shell when
 * one exists, and otherwise leave the visit alone — reaching ContainerDetail
 * any other way (the grid, Find, a package's own link back to its
 * container) means the manifest is what was actually asked for.
 */
describe("posterAutoOpenPath", () => {
  it("routes into the 3D shell when the poster landed here and one exists", () => {
    expect(
      posterAutoOpenPath({ id: "ctr-1", studio_project_id: "studio-1" }, "poster"),
    ).toBe("/warehouse/3d/ctr-1");
  });

  it("stays put when there is no shell yet, even from a poster", () => {
    expect(
      posterAutoOpenPath({ id: "ctr-1", studio_project_id: null }, "poster"),
    ).toBeNull();
  });

  it("stays put for an ordinary visit, even with a shell", () => {
    expect(
      posterAutoOpenPath({ id: "ctr-1", studio_project_id: "studio-1" }, null),
    ).toBeNull();
  });

  it("stays put while the container hasn't loaded yet", () => {
    expect(posterAutoOpenPath(null, "poster")).toBeNull();
  });
});

/**
 * Pick 5, W2: a container's badge color is derived from its serial, never
 * stored — the same serial has to land on the same one of 6 hues every time,
 * everywhere it's shown, and the 6 buckets have to actually get used rather
 * than collapsing onto one or two.
 */
describe("containerHue", () => {
  it("is stable for the same serial", () => {
    expect(containerHue("CTR-000007")).toBe(containerHue("CTR-000007"));
  });

  it("gives two different-looking serials no guaranteed relationship, but is still a pure function of the string", () => {
    const a = containerHue("CTR-000001");
    const b = containerHue("CTR-000001");
    const c = containerHue("Main warehouse");
    expect(a).toBe(b);
    expect(typeof c).toBe("number");
  });

  it("only ever returns one of the 6 evenly spaced hues", () => {
    const allowed = new Set([0, 60, 120, 180, 240, 300]);
    for (let i = 0; i < 60; i++) {
      expect(allowed.has(containerHue(`CTR-${String(i).padStart(6, "0")}`))).toBe(true);
    }
  });

  it("spreads a batch of ordinary container serials across all 6 buckets", () => {
    const hues = new Set(
      Array.from({ length: 60 }, (_, i) =>
        containerHue(`CTR-${String(i).padStart(6, "0")}`),
      ),
    );
    expect(hues.size).toBe(6);
  });

  // A container row from a database that predates the serial column, or a
  // test fixture that never set one, must still render a badge, not crash
  // the page it's decorating (caught live: an e2e fixture with no `serial`
  // took the whole DeliveryDetail screen down before this guard existed).
  it("never throws on a missing or non-string serial", () => {
    expect(() => containerHue(undefined as unknown as string)).not.toThrow();
    expect(() => containerHue(null as unknown as string)).not.toThrow();
    expect(typeof containerHue(undefined as unknown as string)).toBe("number");
  });
});
