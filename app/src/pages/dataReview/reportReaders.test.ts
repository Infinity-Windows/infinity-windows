import { beforeEach, expect, it, vi } from "vitest";
const trace = vi.hoisted(() => ({ calls: [] as unknown[][], reply: { data: [] as { id: string }[], count: 0, error: null } }));
vi.mock("../../lib/supabase", () => ({
  supabaseConfigured: true,
  supabase: { from: (table: string) => {
    trace.calls.push(["from", table]);
    const query: Record<string, unknown> = {};
    for (const name of ["select", "in", "is", "not", "eq", "neq", "gt", "lt", "gte", "order", "range", "limit", "abortSignal"]) {
      query[name] = (...args: unknown[]) => { trace.calls.push([name, ...args]); return query; };
    }
    query.then = (resolve: (value: unknown) => void) => Promise.resolve(trace.reply).then(resolve);
    return query;
  } },
}));
import { listWorkSessions } from "../../lib/customWork/api";
import { listFirstFinishedShifts, listTeamShifts } from "../../lib/timeclock";
import { readHistoricalLabor } from "./historicalLabor";

beforeEach(() => { trace.calls = []; trace.reply = { data: [], count: 0, error: null }; });

it("sends selected jobs and clock-in bounds to the shift reader, including cancellation", async () => {
  const signal = new AbortController().signal;
  await listTeamShifts("2026-10-01", "2026-11-01", undefined, { projectIds: ["a", "b"], signal });
  expect(trace.calls).toContainEqual(["in", "project_id", ["a", "b"]]);
  expect(trace.calls).toContainEqual(["gte", "clock_in_at", "2026-10-01"]);
  expect(trace.calls).toContainEqual(["lt", "clock_in_at", "2026-11-01"]);
  expect(trace.calls).toContainEqual(["abortSignal", signal]);
});

it("queries overlapping activity intervals so work crossing a date boundary is retained", async () => {
  const from = Date.parse("2026-10-01T06:00:00Z"), until = Date.parse("2026-11-01T06:00:00Z");
  const signal = new AbortController().signal;
  await listWorkSessions(undefined, undefined, { projectIds: ["a"], from, until, signal });
  expect(trace.calls).toContainEqual(["in", "project_id", ["a"]]);
  expect(trace.calls).toContainEqual(["gt", "ended_at", new Date(from).toISOString()]);
  expect(trace.calls).toContainEqual(["lt", "started_at", new Date(until).toISOString()]);
  expect(trace.calls).toContainEqual(["abortSignal", signal]);
  trace.calls = [];
  await readHistoricalLabor(["a"], from, until, signal);
  expect(trace.calls).toContainEqual(["in", "opening.project_id", ["a"]]);
  expect(trace.calls).toContainEqual(["gt", "ended_at", new Date(from).toISOString()]);
  expect(trace.calls).toContainEqual(["lt", "started_at", new Date(until).toISOString()]);
  expect(trace.calls).toContainEqual(["abortSignal", signal]);
});

it("does not read any source when no jobs are selected", async () => {
  expect(await listTeamShifts(null, null, undefined, { projectIds: [] })).toEqual([]);
  expect(await listWorkSessions(undefined, undefined, { projectIds: [] })).toEqual([]);
  expect(await readHistoricalLabor([], -Infinity, Infinity)).toEqual([]);
  expect(trace.calls).toEqual([]);
});

it("fetches one first finished shift per job without a date bound, including unassigned labor", async () => {
  await listFirstFinishedShifts(["a", ""]);
  expect(trace.calls.filter(call => call[0] === "limit")).toEqual([["limit", 1], ["limit", 1]]);
  expect(trace.calls).toContainEqual(["eq", "project_id", "a"]);
  expect(trace.calls).toContainEqual(["is", "project_id", null]);
  expect(trace.calls).toContainEqual(["not", "clock_out_at", "is", null]);
  expect(trace.calls.some(call => call[0] === "gte" || call[0] === "lt")).toBe(false);
});
