// The per-mark grouping behind the materials ledger's pool editor (ticket
// 23): pool packages keep their own id and bound date instead of collapsing
// into one summed number, because more than one truck can land pool glass
// against the same mark and each row has to be editable on its own.

import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import { groupPackagesByMark, truckLabel } from "./jobMaterials";

let seq = 0;
function pkg(over: Partial<StoragePackage> = {}): StoragePackage {
  seq += 1;
  return {
    id: `pkg-${seq}`,
    serial: `PKG-${String(seq).padStart(6, "0")}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    bound_at: "2026-08-25T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-25T12:00:00Z",
    package_marks: [{ mark_code: "16" }],
    ...over,
  };
}

describe("groupPackagesByMark", () => {
  it("counts boxed packages by stage under their mark", () => {
    const rows = groupPackagesByMark(
      [pkg({ status: "stored" }), pkg({ status: "stored" }), pkg({ status: "received" })],
      [],
    );
    expect(rows).toHaveLength(1);
    const [mark, row] = rows[0];
    expect(mark).toBe("16");
    expect(row.counts.stored).toBe(2);
    expect(row.counts.received).toBe(1);
    expect(row.total).toBe(3);
  });

  it("keeps each pool package as its own row, not summed into one number", () => {
    const rows = groupPackagesByMark(
      [],
      [
        pkg({ id: "pool-a", piece_count: 4, bound_at: "2026-08-20T00:00:00Z" }),
        pkg({ id: "pool-b", piece_count: 2, bound_at: "2026-08-25T00:00:00Z" }),
      ],
    );
    const [, row] = rows[0];
    expect(row.poolRows).toEqual([
      { id: "pool-a", pieceCount: 4, boundAt: "2026-08-20T00:00:00Z" },
      { id: "pool-b", pieceCount: 2, boundAt: "2026-08-25T00:00:00Z" },
    ]);
  });

  it("sorts marks numerically, not lexically (2 before 10)", () => {
    const rows = groupPackagesByMark(
      [pkg({ package_marks: [{ mark_code: "10" }] }), pkg({ package_marks: [{ mark_code: "2" }] })],
      [],
    );
    expect(rows.map(([mark]) => mark)).toEqual(["2", "10"]);
  });

  it("falls back to the maker's mark, then '?', when nothing is scheduled", () => {
    const rows = groupPackagesByMark(
      [pkg({ package_marks: [], mfr_mark: "A7" }), pkg({ package_marks: [], mfr_mark: null })],
      [],
    );
    expect(rows.map(([mark]) => mark).sort()).toEqual(["?", "A7"]);
  });
});

describe("truckLabel", () => {
  it("reads a bound date as a short 'from … truck' phrase", () => {
    expect(truckLabel("2026-08-25T12:00:00Z")).toMatch(/^from .+ truck$/);
  });

  it("is null with nothing to date it by", () => {
    expect(truckLabel(null)).toBeNull();
  });

  it("is null for an unparseable date rather than 'Invalid Date'", () => {
    expect(truckLabel("not-a-date")).toBeNull();
  });
});
