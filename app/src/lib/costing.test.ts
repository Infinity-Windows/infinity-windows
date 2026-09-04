import { describe, expect, it } from "vitest";
import { bidForMargin, computeLabor, HOURLY_RATE, toCsv, type JobCosting } from "./costing";
import { indexPayRates, type PayRate } from "./payRates";

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

// Wave Z, Z3: real pay rates. The role table above becomes the FALLBACK, and a
// line priced off it says so instead of passing a guess off as a cost.
describe("computeLabor with real pay rates", () => {
  function payRate(profileId: string, hourlyCents: number, effectiveFrom: string): PayRate {
    return {
      id: `${profileId}-${effectiveFrom}`,
      profileId,
      hourlyCents,
      effectiveFrom,
      setBy: null,
      createdAt: `${effectiveFrom}T09:00:00.000Z`,
    };
  }

  // A local 8am–4pm day, built from local parts so the shift's own calendar day
  // is unambiguous wherever the suite runs.
  function shiftOn(year: number, monthIndex: number, day: number) {
    return {
      clock_in_at: new Date(year, monthIndex, day, 8, 0, 0).toISOString(),
      clock_out_at: new Date(year, monthIndex, day, 16, 0, 0).toISOString(),
    };
  }

  it("prices a shift at what that person earned on the day they worked it", () => {
    const rates = indexPayRates([
      payRate("maria", 2800, "2026-01-01"),
      payRate("maria", 3250, "2026-06-01"),
    ]);
    const may = computeLabor(
      [
        {
          project_id: "p1",
          ...shiftOn(2026, 4, 20),
          break_seconds: 0,
          role: "installer",
          profile_id: "maria",
          profile_name: "Maria",
        },
      ],
      rates,
    ).get("p1")!;
    // 8 hours at the January rate, NOT June's — a raise must not reprice May.
    expect(may.cost).toBeCloseTo(8 * 28, 2);
    expect(may.estimated).toBe(false);

    const july = computeLabor(
      [
        {
          project_id: "p1",
          ...shiftOn(2026, 6, 20),
          break_seconds: 0,
          role: "installer",
          profile_id: "maria",
          profile_name: "Maria",
        },
      ],
      rates,
    ).get("p1")!;
    expect(july.cost).toBeCloseTo(8 * 32.5, 2);
  });

  it("falls back to the role table and marks the person's line estimated", () => {
    const totals = computeLabor(
      [
        {
          project_id: "p1",
          ...shiftOn(2026, 6, 20),
          break_seconds: 0,
          role: "foreman",
          profile_id: "sam",
          profile_name: "Sam",
        },
      ],
      indexPayRates([]),
    ).get("p1")!;
    expect(totals.cost).toBeCloseTo(8 * HOURLY_RATE.foreman, 2);
    expect(totals.estimated).toBe(true);
    expect(totals.people).toEqual([
      { profileId: "sam", name: "Sam", hours: 8, cost: 8 * HOURLY_RATE.foreman, estimated: true },
    ]);
  });

  it("marks the job estimated when only ONE of two people has a rate", () => {
    const rates = indexPayRates([payRate("maria", 3000, "2026-01-01")]);
    const totals = computeLabor(
      [
        { project_id: "p1", ...shiftOn(2026, 6, 20), break_seconds: 0, role: "installer", profile_id: "maria", profile_name: "Maria" },
        { project_id: "p1", ...shiftOn(2026, 6, 20), break_seconds: 0, role: "installer", profile_id: "sam", profile_name: "Sam" },
      ],
      rates,
    ).get("p1")!;
    expect(totals.estimated).toBe(true);
    const maria = totals.people.find((p) => p.profileId === "maria")!;
    const sam = totals.people.find((p) => p.profileId === "sam")!;
    expect(maria.estimated).toBe(false);
    expect(sam.estimated).toBe(true);
  });

  it("prices exactly as before when no rates are passed at all", () => {
    const before = computeLabor([
      { project_id: "p1", ...shiftOn(2026, 6, 20), break_seconds: 0, role: "supervisor" },
    ]).get("p1")!;
    expect(before.cost).toBeCloseTo(8 * HOURLY_RATE.supervisor, 2);
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
