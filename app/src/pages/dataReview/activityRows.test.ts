import { describe, expect, it } from "vitest";
import type { WorkSession, WorkUnit } from "../../lib/customWork/model";
import { activityRows, groupActivities, unitLabor } from "./activityRows";
const session = (patch: Partial<WorkSession> = {}): WorkSession => ({ id: "a", profile_id: "p", shift_id: "s", project_id: "job", unit_id: "u", kind: "unit", participation: "install", stage: "Flashing", description: "", outcome: "partial", delay_reason: "", started_at: "2026-10-20T23:00:00Z", ended_at: "2026-10-21T01:00:00Z", end_reason: "partial", revision: 2, ...patch });
describe("recorded activity projection", () => {
  it("clips dates, counts participant hours and preserves original source bounds", () => {
    const result = activityRows([session(), session({ id: "b", profile_id: "helper" })], [], new Map(), Date.parse("2026-10-21T00:00:00Z"));
    expect(result.rows.reduce((n, r) => n + r.seconds, 0)).toBe(7200);
    expect(result.rows[0].started).toBe("2026-10-20T23:00:00Z");
    expect(groupActivities(result.rows, "activity")[0]).toMatchObject({ seconds: 7200, records: 2 });
  });
  it("never invents hours for running, reversed or voided records", () => {
    const result = activityRows([session({ ended_at: null }), session({ ended_at: "2026-10-20T22:00:00Z" }), session({ shift_status: "voided" })], [], new Map());
    expect(result.rows).toEqual([]); expect(result.excluded).toBe(3);
  });
  it("keeps general labor unallocated and uses recorded story for specific work", () => {
    const units = [{ id: "u", label: "7", facts: { story: "2" } }] as WorkUnit[];
    const result = activityRows([session(), session({ id: "b", kind: "idle", unit_id: null, description: "Hauling" })], units, new Map());
    expect(result.rows.map(r => r.floor)).toEqual(["2", "Not allocated"]);
  });
  it("does not merge units just because their labels match", () => {
    const units = [{ id: "u", label: "7", facts: {} }, { id: "u2", label: "7", facts: {} }] as WorkUnit[];
    const rows = activityRows([session(), session({ id: "b", unit_id: "u2" })], units, new Map()).rows;
    expect(groupActivities(rows, "unit")).toHaveLength(2);
    expect(groupActivities(rows, "floor").reduce((n, r) => n + r.seconds, 0)).toBe(rows.reduce((n, r) => n + r.seconds, 0));
  });
});

it("conserves scope totals and excludes general or unlinked work from unit effort", () => {
  const rows = activityRows([
    session(), session({ id: "helper", profile_id: "helper" }),
    session({ id: "general", kind: "idle", unit_id: null, description: "Hauling" }),
    session({ id: "unlinked", unit_id: null }),
  ], [], new Map()).rows;
  const scope = groupActivities(rows, "scope");
  expect(scope.find(g => g.key === "Missing attribution")).toMatchObject({ seconds: 21600, records: 3 });
  expect(scope.find(g => g.key === "Job-level work")).toMatchObject({ seconds: 7200, records: 1 });
  expect(scope.reduce((sum, g) => sum + g.seconds, 0)).toBe(rows.reduce((sum, r) => sum + r.seconds, 0));
  expect(unitLabor(rows)).toEqual([expect.objectContaining({ key: "u", seconds: 14400, records: 2 })]);
  expect(unitLabor(rows.filter(r => r.scope === "General"))).toEqual([]);
});

it("keeps jobs distinct even when their display labels match", () => {
  const rows = activityRows([session({ project_id: "job1" }), session({ id: "b", project_id: "job2", unit_id: "u2" })], [], new Map()).rows.map(r => ({ ...r, job: "Same name" }));
  const groups = groupActivities(rows, "job");
  expect(groups).toHaveLength(2);
  expect(new Set(groups.map(g => g.key))).toEqual(new Set(["job1", "job2"]));
  expect(groups.reduce((sum, g) => sum + g.seconds, 0)).toBe(14400);
});

it("keeps all filtered labor in a single total when grouping is none", () => {
  const rows = activityRows([session(), session({ id: "b", kind: "idle", unit_id: null })], [], new Map()).rows;
  expect(groupActivities(rows, "none")).toEqual([{ key: "Total", label: "Total", seconds: 14400, records: 2 }]);
  expect(groupActivities([], "none")).toEqual([]);
});
