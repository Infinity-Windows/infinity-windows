import { describe, expect, it } from "vitest";
import { bindLine, markPlanRow } from "./markPlan";
import type { StoragePackage } from "../storage";

let seq = 0;
const pkg = (over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage => {
  const { marks, ...rest } = over;
  seq += 1;
  return {
    id: `p${seq}`,
    serial: `PKG-${seq}`,
    short_code: null,
    status: "received",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "",
    package_marks: (marks ?? ["16"]).map((mark_code) => ({ mark_code })),
    ...rest,
  } as StoragePackage;
};

describe("the plan row", () => {
  it("an undeclared window has nothing on paper and says so", () => {
    const r = markPlanRow([], "job-1", "16");
    expect(r).toEqual({
      markCode: "16",
      declared: null,
      labeled: 0,
      here: 0,
      onTheWay: 0,
      totalsDisagree: false,
    });
  });

  it("declared 4, none arrived: four labeled, four on the way, none here", () => {
    const four = [1, 2, 3, 4].map((i) =>
      pkg({ status: "minted", part_index: i, part_total: 4 }),
    );
    const r = markPlanRow(four, "job-1", "16");
    expect(r.declared).toBe(4);
    expect(r.labeled).toBe(4);
    expect(r.here).toBe(0);
    expect(r.onTheWay).toBe(4);
  });

  it("a received part moves from on-the-way to here", () => {
    const rows = [
      pkg({ status: "received", part_index: 1, part_total: 2 }),
      pkg({ status: "minted", part_index: 2, part_total: 2 }),
    ];
    const r = markPlanRow(rows, "job-1", "16");
    expect(r.here).toBe(1);
    expect(r.onTheWay).toBe(1);
  });

  it("disagreeing labels block the plan rather than pick a side", () => {
    const rows = [
      pkg({ part_index: 1, part_total: 2 }),
      pkg({ part_index: 2, part_total: 3 }),
    ];
    expect(markPlanRow(rows, "job-1", "16").totalsDisagree).toBe(true);
  });
});

describe("the printed line", () => {
  it("carries job, window and part", () => {
    expect(bindLine("BLACK22", "16", 2, 4)).toBe("BLACK22 · W16 · 2 of 4");
  });
  it("stays honest with no part number", () => {
    expect(bindLine("BLACK22", "16", null, null)).toBe("BLACK22 · W16");
  });
});
