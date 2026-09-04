import { beforeEach, describe, expect, it, vi } from "vitest";

// Every table this module reads, and which of them it actually asked for. The
// second is the point of the Wave Z test at the bottom: a reader with no pay
// grant must not even ask for pay_rates.
const tables: Record<string, unknown[]> = {};
const asked: string[] = [];

vi.mock("./supabase", () => ({
  supabase: {
    from: (table: string) => {
      asked.push(table);
      const builder = {
        select: () => builder,
        order: () => builder,
        eq: () => builder,
        then: (
          resolve: (v: { data: unknown[]; error: null }) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject),
      };
      return builder;
    },
  },
}));

import {
  bidForMargin,
  computeLabor,
  getCompanyCosting,
  HOURLY_RATE,
  toCsv,
  type JobCosting,
} from "./costing";
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

// Wave Z review fix: "Sees costs" and "Sees pay rates" are separate grants on
// purpose, so a bookkeeper who books job costs but may not read wages is the
// ORDINARY case. RLS hands them no pay_rates rows, every line falls back to the
// role table, and the screen used to tell them "estimated — no rate on file"
// about people whose rate is very much on file. Two people with "Sees costs"
// read two different margins; only one of them was told why.
describe("getCompanyCosting and the pay grant", () => {
  const SHIFT = {
    project_id: "p1",
    profile_id: "u1",
    clock_in_at: "2026-03-02T15:00:00Z",
    clock_out_at: "2026-03-02T23:00:00Z",
    break_seconds: 0,
    profiles: { role: "installer", display_name: "Dan" },
  };

  beforeEach(() => {
    asked.length = 0;
    for (const key of Object.keys(tables)) delete tables[key];
    tables.projects = [{ id: "p1", job_code: "SMITH", name: "Smith" }];
    tables.project_financials = [
      { project_id: "p1", bid_amount: 10000, target_margin_pct: 20 },
    ];
    tables.job_costs = [];
    tables.change_orders = [];
    tables.time_shifts = [SHIFT];
    // Dan earns $60/h, and it IS on file — the question is who may read it.
    tables.pay_rates = [
      {
        id: "r1",
        profile_id: "u1",
        hourly_cents: 6000,
        effective_from: "2026-01-01",
        set_by: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
  });

  it("prices off the real rate, and says nothing is estimated, for a reader with the pay grant", async () => {
    const [row] = await getCompanyCosting({ canSeePay: true });
    expect(asked).toContain("pay_rates");
    expect(row.laborRatesVisible).toBe(true);
    expect(row.laborEstimated).toBe(false);
    expect(row.laborCost).toBe(8 * 60);
    expect(row.laborPeople?.[0]?.estimated).toBe(false);
  });

  it("does not even ask for pay rates without the grant, and says the estimate is the READER's, not a missing rate", async () => {
    const [row] = await getCompanyCosting({ canSeePay: false });
    expect(asked).not.toContain("pay_rates");
    // The flag the screen reads to pick its sentence. False means "you cannot
    // see rates", which is a different sentence from "this person has none".
    expect(row.laborRatesVisible).toBe(false);
    expect(row.laborEstimated).toBe(true);
    expect(row.laborCost).toBe(8 * HOURLY_RATE.installer);
  });

  it("still marks a genuinely rate-less person estimated for a reader who CAN see rates", async () => {
    tables.pay_rates = [];
    const [row] = await getCompanyCosting({ canSeePay: true });
    expect(row.laborRatesVisible).toBe(true);
    expect(row.laborEstimated).toBe(true);
    expect(row.laborPeople?.[0]?.estimated).toBe(true);
  });

  it("defaults to reading rates when the caller says nothing, so no caller silently loses them", async () => {
    const [row] = await getCompanyCosting();
    expect(asked).toContain("pay_rates");
    expect(row.laborRatesVisible).toBe(true);
    expect(row.laborCost).toBe(8 * 60);
  });
});
