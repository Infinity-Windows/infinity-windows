import { describe, expect, it } from "vitest";
import { planCostCodeSwap } from "./costCodeOrder";
import type { CostCode } from "./timeclock";

function code(id: string, sort_order: number): CostCode {
  return { id, code: id, label: id, active: true, sort_order };
}

const library = [code("a", 10), code("b", 20), code("c", 30)];

describe("planCostCodeSwap", () => {
  it("swaps sort_order with the previous code when moving up", () => {
    expect(planCostCodeSwap(library, "b", "up").updates).toEqual([
      { id: "b", sort_order: 10 },
      { id: "a", sort_order: 20 },
    ]);
  });

  it("swaps sort_order with the next code when moving down", () => {
    expect(planCostCodeSwap(library, "b", "down").updates).toEqual([
      { id: "b", sort_order: 30 },
      { id: "c", sort_order: 20 },
    ]);
  });

  it("no-ops at the top of the list", () => {
    expect(planCostCodeSwap(library, "a", "up").updates).toEqual([]);
  });

  it("no-ops at the bottom of the list", () => {
    expect(planCostCodeSwap(library, "c", "down").updates).toEqual([]);
  });

  it("no-ops for an unknown id", () => {
    expect(planCostCodeSwap(library, "zzz", "up").updates).toEqual([]);
  });

  it("falls back to positional order when sort_order is missing", () => {
    const noOrder = [
      { id: "x", code: "x", label: "x", active: true },
      { id: "y", code: "y", label: "y", active: true },
    ] as CostCode[];
    expect(planCostCodeSwap(noOrder, "y", "up").updates).toEqual([
      { id: "y", sort_order: 0 },
      { id: "x", sort_order: 10 },
    ]);
  });
});
