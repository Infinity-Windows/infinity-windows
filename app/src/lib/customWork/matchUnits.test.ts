import { describe, expect, it } from "vitest";
import type { WorkUnit } from "./model";
import { matchingUnits } from "./matchUnits";

function unit(label: string, project_id: string | null = "job", over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: `u-${label}-${project_id}`,
    project_id,
    opening_id: null,
    created_by: "me",
    label,
    type_label: "Slider",
    facts: {},
    revision: 1,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

describe("matchingUnits (F4: the duplicate check on New unit)", () => {
  const units = [unit("1"), unit("12"), unit("16"), unit("21"), unit("16", "other-job"), unit("A 3")];

  it("matches the same number on the same job, whatever the case or spacing", () => {
    expect(matchingUnits(units, "job", "16").map((u) => u.id)).toEqual(["u-16-job"]);
    expect(matchingUnits(units, "job", " a3 ".replace("a3", "a 3")).map((u) => u.label)).toEqual(["A 3"]);
  });

  it("a single character only matches exactly — never the whole list", () => {
    expect(matchingUnits(units, "job", "1").map((u) => u.label)).toEqual(["1"]);
  });

  it("two characters may match by containment", () => {
    expect(matchingUnits(units, "job", "12").map((u) => u.label)).toEqual(["12"]);
    expect(matchingUnits(units, "job", "21").map((u) => u.label)).toEqual(["21"]);
  });

  it("never matches across jobs, and treats unassigned units as their own job", () => {
    expect(matchingUnits(units, "other-job", "16").map((u) => u.id)).toEqual(["u-16-other-job"]);
    expect(matchingUnits([unit("7", null)], null, "7")).toHaveLength(1);
    expect(matchingUnits([unit("7", null)], "job", "7")).toHaveLength(0);
  });

  it("finished units still count — the point is that they exist", () => {
    const done = unit("16", "job", { facts: { installation_complete: "Yes" } });
    expect(matchingUnits([done], "job", "16")).toHaveLength(1);
  });

  it("nothing typed, nothing matched", () => {
    expect(matchingUnits(units, "job", "   ")).toEqual([]);
  });
});
