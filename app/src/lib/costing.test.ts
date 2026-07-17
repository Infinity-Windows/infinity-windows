import { describe, expect, it } from "vitest";
import { bidForMargin, computeLabor, HOURLY_RATE, toCsv, type JobCosting } from "./costing";

describe("computeLabor", () => {
  it("sums hours x role rate per project, minus breaks", () => {
    const m = computeLabor([
      { project_id: "p1", clock_in_at: "2026-01-01T08:00:00Z", clock_out_at: "2026-01-01T16:00:00Z", break_seconds: 1800, role: "installer" }, // 7.5h
      { project_id: "p1", clock_in_at: "2026-01-01T08:00:00Z", clock_out_at: "2026-01-01T12:00:00Z", break_seconds: 0, role: "foreman" }, // 4h
    ]);
    const p1 = m.get("p1")!;
    expect(p1.hours).toBeCloseTo(11.5, 1);
    expect(p1.cost).toBeCloseTo(7.5 * HOURLY_RATE.installer + 4 * HOURLY_RATE.foreman, 1);
  });
  it("ignores open (not clocked-out) shifts and null projects", () => {
    const m = computeLabor([
      { project_id: "p1", clock_in_at: "2026-01-01T08:00:00Z", clock_out_at: null, break_seconds: 0, role: "installer" },
      { project_id: null, clock_in_at: "2026-01-01T08:00:00Z", clock_out_at: "2026-01-01T10:00:00Z", break_seconds: 0, role: "installer" },
    ]);
    expect(m.size).toBe(0);
  });
});

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
        revenue: 110, manualCosts: 20, laborHours: 2, laborCost: 40, costs: 60,
        margin: 50, marginPct: 45.5, targetMarginPct: 40,
      },
    ];
    const csv = toCsv(rows);
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("SMITH");
    expect(csv).toContain('"Smith, Bob"');
  });
});
