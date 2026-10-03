import { beforeEach, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { rpc } }));
const { fetchValuesOwnerReport, ValuesOwnerReportMalformedError } = await import("./api");

const response = () => ({
  periodStart: "2026-10-01", schedulerEnabled: false,
  people: [{ userId: "person", name: "Ana", mirror: {}, owedCount: 0, received: [],
    suspended: false, retired: false,
    asRater: { assigned: 0, accepted: 0, late: 0, pending: 0, canceled: 0, suspended: 0 },
    coverage: { expectedReceived: 2, actualReceived: 0, missingCoverage: true },
  }],
});
beforeEach(() => rpc.mockReset());

it("preserves legitimate zero activity and the actual two-review coverage shortfall", async () => {
  rpc.mockResolvedValue({ data: response(), error: null });
  const result = await fetchValuesOwnerReport();
  expect(result?.people[0]).toMatchObject({
    suspended: false, retired: false,
    asRater: { assigned: 0, accepted: 0, late: 0, pending: 0, canceled: 0, suspended: 0 },
    coverage: { expectedReceived: 2, actualReceived: 0, missingCoverage: true },
  });
});

it.each([
  ["missing asRater", (p: Record<string, unknown>) => { delete p.asRater; }],
  ["missing coverage", (p: Record<string, unknown>) => { delete p.coverage; }],
  ["missing suspended", (p: Record<string, unknown>) => { delete p.suspended; }],
  ["missing owed count", (p: Record<string, unknown>) => { delete p.owedCount; }],
  ["numeric false flag", (p: Record<string, unknown>) => { p.retired = 0; }],
  ["missing count", (p: Record<string, unknown>) => { delete (p.asRater as Record<string, unknown>).accepted; }],
  ["missing suspended reviews", (p: Record<string, unknown>) => { delete (p.asRater as Record<string, unknown>).suspended; }],
  ["negative suspended reviews", (p: Record<string, unknown>) => { (p.asRater as Record<string, unknown>).suspended = -1; }],
  ["fractional suspended reviews", (p: Record<string, unknown>) => { (p.asRater as Record<string, unknown>).suspended = 0.5; }],
  ["fractional count", (p: Record<string, unknown>) => { (p.asRater as Record<string, unknown>).pending = 0.5; }],
  ["negative count", (p: Record<string, unknown>) => { (p.asRater as Record<string, unknown>).canceled = -1; }],
  ["nonfinite count", (p: Record<string, unknown>) => { (p.coverage as Record<string, unknown>).actualReceived = Infinity; }],
  ["rater arithmetic", (p: Record<string, unknown>) => { (p.asRater as Record<string, unknown>).assigned = 1; }],
  ["late beyond accepted", (p: Record<string, unknown>) => { (p.asRater as Record<string, unknown>).late = 1; }],
  ["coverage contradiction", (p: Record<string, unknown>) => { (p.coverage as Record<string, unknown>).missingCoverage = false; }],
] as const)("rejects %s instead of fabricating zero", async (_label, change) => {
  const data = response();
  change(data.people[0] as unknown as Record<string, unknown>);
  rpc.mockResolvedValue({ data, error: null });
  await expect(fetchValuesOwnerReport()).rejects.toBeInstanceOf(ValuesOwnerReportMalformedError);
});

it("counts suspended reviews separately and requires them in assigned arithmetic", async () => {
  const data = response();
  data.people[0].asRater = { assigned: 3, accepted: 1, late: 0, pending: 1, canceled: 0, suspended: 1 };
  rpc.mockResolvedValue({ data, error: null });
  await expect(fetchValuesOwnerReport()).resolves.toMatchObject({ people: [{
    suspended: false,
    asRater: { assigned: 3, accepted: 1, pending: 1, canceled: 0, suspended: 1 },
  }] });
  data.people[0].asRater.assigned = 2;
  rpc.mockResolvedValue({ data, error: null });
  await expect(fetchValuesOwnerReport()).rejects.toBeInstanceOf(ValuesOwnerReportMalformedError);
});
