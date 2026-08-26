import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import { jobTallies, tallyLine } from "./jobTally";

let seq = 0;
const pkg = (over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage => {
  const { marks, ...rest } = over;
  seq += 1;
  return {
    id: `p${seq}`,
    serial: `PKG-${seq}`,
    short_code: null,
    status: "received",
    project_id: null,
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-26T00:00:00Z",
    package_marks: (marks ?? []).map((mark_code) => ({ mark_code })),
    ...rest,
  } as StoragePackage;
};

const jobs = new Map([["mm", "MADMOOSE"]]);

describe("jobTallies", () => {
  it("counts UNITS (distinct marks), not boxes — the owner's 20/22 example", () => {
    const rows = [
      // Window 1: two boxes, one arrived — logged.
      pkg({ project_id: "mm", marks: ["1"], status: "received" }),
      pkg({ project_id: "mm", marks: ["1"], status: "minted" }),
      // Window 2: only expected — remaining.
      pkg({ project_id: "mm", marks: ["2"], status: "minted" }),
      // Window 3: stored — logged.
      pkg({ project_id: "mm", marks: ["3"], status: "stored" }),
    ];
    const [t] = jobTallies(rows, jobs);
    expect(t).toMatchObject({
      label: "MADMOOSE",
      totalUnits: 3,
      loggedUnits: 2,
      remainingUnits: 1,
    });
    expect(tallyLine(t)).toBe("2/3 · 1 remaining");
  });

  it("a waiting job tallies by its typed name and manufacturer marks", () => {
    const rows = [
      pkg({ pending_job_name: "Don Timpson Res", mfr_mark: "1", status: "received" }),
      pkg({ pending_job_name: "Don Timpson Res", mfr_mark: "4", status: "minted" }),
    ];
    const [t] = jobTallies(rows, jobs);
    expect(t).toMatchObject({ projectId: null, label: "Don Timpson Res", totalUnits: 2, loggedUnits: 1 });
  });

  it("crate supplies (no mark) and blanks and Boneyard never count as units", () => {
    const rows = [
      pkg({ pending_job_name: "Don Timpson Res", mfr_mark: null, part_type: "caulk", piece_count: 6 }),
      pkg({ status: "blank" }),
      pkg({ mfr_mark: "9" }), // no job, no pending name: Boneyard
    ];
    expect(jobTallies(rows, jobs)).toEqual([]);
  });

  it("a finished list says so instead of counting to itself", () => {
    const rows = [pkg({ project_id: "mm", marks: ["1"], status: "stored" })];
    expect(tallyLine(jobTallies(rows, jobs)[0])).toBe("all 1 here");
  });
});
