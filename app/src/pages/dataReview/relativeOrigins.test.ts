import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [] as unknown[][], invalid: false }));
vi.mock("../../lib/supabase", () => ({ supabase: { from: (table: string) => {
  let job = ""; const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "not", "order", "limit", "abortSignal"]) query[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); if (method === "eq" && (args[0] === "project_id" || args[0] === "opening.project_id")) job = String(args[1]); return query; };
  query.then = (resolve: (value: unknown) => void) => Promise.resolve({ data: [{ started_at: table === "unit_sessions" ? "2026-09-23T12:00:00Z" : "2026-10-01T12:00:00Z", ended_at: state.invalid ? "bad" : "2026-10-02T12:00:00Z", id: job }], error: null }).then(resolve);
  return query;
} } }));
import { firstUnitOrigins, relativeOriginWindows } from "./relativeOrigins";
import { midnight } from "./generalLabor";
beforeEach(() => { state.calls = []; state.invalid = false; });
it("finds first linked unit work across both sources without scanning history or applying display filters", async () => {
  const signal = new AbortController().signal;
  const origins = await firstUnitOrigins(["A", "B"], signal);
  expect(origins).toEqual([{ jobId: "A", startedAt: "2026-09-23T12:00:00Z" }, { jobId: "B", startedAt: "2026-09-23T12:00:00Z" }]);
  expect(state.calls.filter(call => call[1] === "limit")).toHaveLength(4);
  expect(state.calls.filter(call => call[1] === "limit").every(call => call[2] === 1)).toBe(true);
  expect(state.calls).toContainEqual(["custom_work_sessions", "eq", "unit.opening.project_id", "A"]);
  expect(state.calls).toContainEqual(["custom_work_sessions", "eq", "kind", "unit"]);
  expect(state.calls).toContainEqual(["unit_sessions", "eq", "opening.project_id", "B"]);
  expect(relativeOriginWindows(origins, 4)[0]).toEqual({ jobId: "A", from: midnight("2026-09-23"), until: midnight("2026-10-21") });
});
it("does not invent an origin from an invalid interval or an empty job selection", async () => {
  expect(await firstUnitOrigins([])).toEqual([]); expect(state.calls).toEqual([]);
  state.invalid = true; await expect(firstUnitOrigins(["A"])).rejects.toThrow("origin unavailable");
});
