import { describe, expect, it } from "vitest";
import { sortClockCostCodes } from "./clockCostCodes";
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
