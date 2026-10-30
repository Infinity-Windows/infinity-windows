import { expect, it, vi } from "vitest";
const trace = vi.hoisted(() => ({ calls: [] as unknown[][], reply: { data: [{ id: "o" }], count: 1, error: null } }));
vi.mock("../../lib/supabase", () => ({ supabase: { from: (table: string) => {
  trace.calls.push(["from", table]);
  const q: Record<string, unknown> = {};
  for (const name of ["select", "in", "is", "order", "range", "abortSignal"]) q[name] = (...args: unknown[]) => { trace.calls.push([name, ...args]); return q; };
  q.then = (resolve: (value: unknown) => void) => Promise.resolve(trace.reply).then(resolve);
  return q;
} } }));
import { readComparisonOpenings } from "./comparisonInventory";
it("requires selected jobs, excludes removed openings, and supports cancellation", async () => {
  expect(await readComparisonOpenings([])).toEqual([]);
  expect(trace.calls).toEqual([]);
  const signal = new AbortController().signal;
  expect(await readComparisonOpenings(["j"], signal)).toEqual([{ id: "o" }]);
  expect(trace.calls).toContainEqual(["in", "project_id", ["j"]]);
  expect(trace.calls).toContainEqual(["is", "removed_at", null]);
  expect(trace.calls).toContainEqual(["abortSignal", signal]);
});
