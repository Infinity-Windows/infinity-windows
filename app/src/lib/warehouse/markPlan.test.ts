import { describe, expect, it } from "vitest";
import { bindLine, markPlanRow, suggestedPackageCount } from "./markPlan";
import type { StoragePackage } from "../storage";
import type { UnitConfig } from "../modelstudio/units";

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
      suggestedCount: null,
    });
  });

  it("no config resolved for the mark → suggestedCount stays null (today's behavior)", () => {
    const r = markPlanRow([], "job-1", "16", null);
    expect(r.suggestedCount).toBeNull();
  });

  it("a resolved config's suggestion rides along on the row", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [
        { widthMm: 900, mechanism: "fixed" },
        { widthMm: 900, mechanism: "slider", direction: "left" },
      ],
    };
    const r = markPlanRow([], "job-1", "16", cfg);
    expect(r.suggestedCount).toBe(suggestedPackageCount(cfg));
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

describe("suggestedPackageCount (a starting heuristic, not a rule)", () => {
  it("an all-fixed single panel: frame + 1 glass, no hardware piece", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 1800, mechanism: "fixed" }],
    };
    expect(suggestedPackageCount(cfg)).toBe(2); // 1 frame + 1 glass
  });

  it("any operable panel adds one hardware piece for the whole unit", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [
        { widthMm: 900, mechanism: "fixed" },
        { widthMm: 900, mechanism: "slider", direction: "left" },
      ],
    };
    // 1 frame + 2 glass + 1 hardware (one panel moves)
    expect(suggestedPackageCount(cfg)).toBe(4);
  });

  it("window 16's shape: five panels, one operable — 1 + 5 + 1", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 4559,
      panels: [768, 2248, 2286, 2229, 432].map((widthMm, i) => ({
        widthMm,
        mechanism: i === 0 ? ("slider" as const) : ("fixed" as const),
      })),
      cornerAfterPanel: 0,
    };
    expect(suggestedPackageCount(cfg)).toBe(7);
  });

  it("a hung or casement panel counts as operable too — not just sliders", () => {
    const hung: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "hung" }],
    };
    const casement: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "casement", direction: "left" }],
    };
    expect(suggestedPackageCount(hung)).toBe(3); // 1 frame + 1 glass + 1 hardware
    expect(suggestedPackageCount(casement)).toBe(3);
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
