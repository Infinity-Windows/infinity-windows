import { expect, it, vi } from "vitest";
vi.mock("../../lib/supabase", () => ({ supabase: { from: vi.fn() } }));
import { supabase } from "../../lib/supabase";
import { historicalRows, readHistoricalLabor, reconcileHistorical, type HistoricalSession } from "./historicalLabor";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
const visit = { id: "s", opening_id: "o", profile_id: "p", role: "install", started_at: "2026-10-01T06:00:00Z", ended_at: "2026-10-01T08:00:00Z", end_reason: "finish", opening: { id: "o", project_id: "j", opening_code: "11-1", label: null } } as HistoricalSession;
it("projects historic opening identity without inventing facts or detailed stages", () => {
  const rows = historicalRows([visit], [], new Map([["p", "Sam"]]), Date.parse("2026-10-01T07:00:00Z"), Infinity);
  expect(rows[0]).toMatchObject({ id: "unit_sessions:s", openingId: "o", unitId: "opening:o", activity: "Install", seconds: 3600, floor: "Unknown", category: null, subtype: null });
  const unit = { id: "u", project_id: "j", opening_id: "o", label: "11-1", facts: { story: "2" } } as WorkUnit;
  expect(historicalRows([visit], [unit], new Map(), -Infinity, Infinity)[0]).toMatchObject({ unitId: "u", floor: "2", unitRecord: unit });
});
it("holds out same-person cross-source overlaps without conflating separate visits", () => {
  const historical = historicalRows([visit], [], new Map(), -Infinity, Infinity);
  const custom = { ...historical[0], id: "custom", sourceTable: "custom_work_sessions", started: "2026-10-01T07:00:00Z", ended: "2026-10-01T09:00:00Z" } as ActivityRow;
  expect(reconcileHistorical([custom], historical).held).toHaveLength(1);
  expect(reconcileHistorical([{ ...custom, personId: "someone-else" }], historical).rows).toHaveLength(2);
  expect(reconcileHistorical([{ ...custom, started: visit.ended_at }], historical).held).toHaveLength(0);
});
it("requests all selected jobs and overlapping closed intervals with checked pagination", async () => {
  const query = { select: vi.fn(), in: vi.fn(), is: vi.fn(), not: vi.fn(), order: vi.fn(), range: vi.fn(), gt: vi.fn(), lt: vi.fn(), then: vi.fn() };
  for (const key of ["select", "in", "is", "not", "order", "range", "gt", "lt"] as const) query[key].mockReturnValue(query);
  query.then.mockImplementation((resolve: (value: unknown) => void) => resolve({ data: [visit], count: 1, error: null }));
  vi.mocked(supabase.from).mockReturnValue(query as never);
  expect(await readHistoricalLabor(["j"], Date.parse(visit.started_at), Date.parse(visit.ended_at))).toEqual([visit]);
  expect(query.in).toHaveBeenCalledWith("opening.project_id", ["j"]);
  expect(query.gt).toHaveBeenCalledWith("ended_at", "2026-10-01T06:00:00.000Z");
  expect(query.lt).toHaveBeenCalledWith("started_at", "2026-10-01T08:00:00.000Z");
  query.then.mockImplementation((resolve: (value: unknown) => void) => resolve({ data: [], count: 1, error: null }));
  await expect(readHistoricalLabor(["j"], -Infinity, Infinity)).rejects.toThrow("completely");
});
