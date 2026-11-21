import { describe, expect, it } from "vitest";
import { planImportUnits, type ImportOpening } from "./unitImportFinish";

const win = { kind: "window" as const, label: "W1", sheet: 2, widthMm: 1016, heightMm: 1524, configuration: "Fixed", material: "Aluminum" };
const opening = (key: string, mark: string, floor: string | null, draft: ImportOpening["draft"] | null = win): ImportOpening =>
  ({ key, mark, floor, sheet: 4, draft: draft ?? undefined });

describe("planImportUnits", () => {
  it("numbers each opening of a mark and carries the CAD definition", () => {
    const { units, leftOut } = planImportUnits([opening("b", "6", "Level 2"), opening("a", "6", "Level 1"), opening("c", "#1", "Level 1")], []);
    expect(leftOut).toEqual([]);
    expect(units.map(unit => [unit.key, unit.code])).toEqual([["c", "1-1"], ["a", "6-1"], ["b", "6-2"]]);
    expect(units[1].details).toEqual({
      placeholder: false, kind: "window", floor: "1", width: 40, height: 60, basis: "drawing", configuration: "Fixed", material: "Aluminum",
    });
    expect(units[1].reason).toBe("Imported from drawings: plan mark 6, plan sheet 4; CAD sheet 2: W1");
  });

  it("continues after units of that mark already on the job", () => {
    const { units } = planImportUnits([opening("a", "6", "Level 1"), opening("b", "6", "Level 1")], ["6-1", " 6-3 ", "7-1"]);
    expect(units.map(unit => unit.code)).toEqual(["6-2", "6-4"]);
  });

  it("leaves out openings it cannot define, and says why", () => {
    const { units, leftOut } = planImportUnits([
      opening("a", "9", "Level 1", null),
      opening("b", "10", null, { ...win, kind: "" }),
      opening("c", "11", null),
    ], []);
    expect(leftOut).toEqual([
      { key: "a", mark: "9", floor: "Level 1", why: "no-definition" },
      { key: "b", mark: "10", floor: null, why: "type-unclear" },
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].details.floor).toBeUndefined();
  });
});
