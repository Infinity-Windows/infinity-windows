import { describe, expect, it } from "vitest";
import { bidForMargin, toCsv, type JobCosting } from "./costing";

describe("bidForMargin", () => {
  it("prices up from cost to hit the target margin", () => {
    // $10k cost at 20% margin -> 12,500 (cost is 80% of price)
    expect(bidForMargin(10000, 20)).toBe(12500);
  });
  it("returns cost at 0% margin", () => {
    expect(bidForMargin(5000, 0)).toBe(5000);
  });
  it("clamps absurd margins", () => {
    expect(bidForMargin(1000, 150)).toBeGreaterThan(0);
  });
});

describe("toCsv", () => {
  it("emits a header + row per job", () => {
    const rows: JobCosting[] = [
      {
        projectId: "1", jobCode: "SMITH", name: "Smith, Bob", bid: 100, changeOrders: 10,
        revenue: 110, costs: 60, margin: 50, marginPct: 45.5, targetMarginPct: 40,
      },
    ];
    const csv = toCsv(rows);
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("SMITH");
    expect(csv).toContain('"Smith, Bob"');
  });
});
