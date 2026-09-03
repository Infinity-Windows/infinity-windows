import { describe, expect, it } from "vitest";
import { resolveClockCostCodes, sortClockCostCodes } from "./clockCostCodes";
import type { CostCode } from "./timeclock";

function code(partial: Partial<CostCode> & { id: string; code: string }): CostCode {
  return {
    label: partial.code,
    active: true,
    sort_order: 100,
    is_general: false,
    ...partial,
  };
}

const general = code({ id: "g", code: "000", label: "General", sort_order: 5, is_general: true });
const windows = code({ id: "w", code: "100", label: "Install — windows", sort_order: 10 });
const service = code({ id: "s", code: "500", label: "Service call", sort_order: 70 });
const warranty = code({ id: "wa", code: "600", label: "Warranty", sort_order: 80 });
const allActive = [windows, service, warranty, general];

describe("sortClockCostCodes", () => {
  it("puts the general fallback first, then company sort_order", () => {
    const sorted = sortClockCostCodes([warranty, windows, general, service]);
    expect(sorted.map((c) => c.id)).toEqual(["g", "w", "s", "wa"]);
  });

  it("breaks a sort_order tie by code", () => {
    const a = code({ id: "a", code: "300", sort_order: 40 });
    const b = code({ id: "b", code: "200", sort_order: 40 });
    expect(sortClockCostCodes([a, b]).map((c) => c.code)).toEqual(["200", "300"]);
  });
});

describe("resolveClockCostCodes — the clock-in picker list", () => {
  it("with NO job subset, shows the full active library", () => {
    const list = resolveClockCostCodes([], allActive);
    // Everything, general first.
    expect(list.map((c) => c.id)).toEqual(["g", "w", "s", "wa"]);
  });

  it("with a job subset, shows THOSE plus the general fallback", () => {
    // A service job: only Service call + Warranty assigned.
    const list = resolveClockCostCodes([service, warranty], allActive);
    expect(list.map((c) => c.id)).toEqual(["g", "s", "wa"]);
    // The full-library-only codes never leak in.
    expect(list.some((c) => c.id === "w")).toBe(false);
  });

  it("never duplicates the general code when the subset already has it", () => {
    const list = resolveClockCostCodes([general, service], allActive);
    expect(list.filter((c) => c.id === "g")).toHaveLength(1);
    expect(list.map((c) => c.id)).toEqual(["g", "s"]);
  });

  it("still returns the subset when the library has no general code at all", () => {
    const noGeneral = [windows, service, warranty];
    const list = resolveClockCostCodes([service, warranty], noGeneral);
    expect(list.map((c) => c.id)).toEqual(["s", "wa"]);
  });
});
