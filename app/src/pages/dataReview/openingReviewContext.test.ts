import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [] as unknown[][], missingKinds: false }));
vi.mock("../../lib/supabase", () => ({ supabase: { from: (table: string) => {
  state.calls.push(["from", table]); let columns = "";
  const query: Record<string, unknown> = {};
  for (const name of ["select", "in", "order", "range", "abortSignal"]) query[name] = (...args: unknown[]) => { state.calls.push([table, name, ...args]); if (name === "select") columns = String(args[0]); return query; };
  query.then = (resolve: (value: unknown) => void) => {
    if (table === "project_mark_specs" && state.missingKinds && columns.includes("unit_kind")) return Promise.resolve({ error: { code: "42703" }, data: null, count: null }).then(resolve);
    const data = table === "project_openings" ? [{ id: "o", project_id: "j", opening_code: "11-1", window_type_id: "t" }] : table === "project_mark_specs" ? [{ id: "s", project_id: "j", mark_code: "11", operation: "XO" }] : [{ id: "t", name: "Slider window", category: "slider" }];
    return Promise.resolve({ data, count: data.length, error: null }).then(resolve);
  };
  return query;
} } }));
import { readOpeningContexts } from "./openingReviewContext";
beforeEach(() => { state.calls = []; state.missingKinds = false; });
it("reads only requested openings, their projects' specs and explicitly linked catalog IDs", async () => {
  const signal = new AbortController().signal;
  const result = await readOpeningContexts(["o"], signal);
  expect(state.calls).toContainEqual(["project_openings", "in", "id", ["o"]]);
  expect(state.calls).toContainEqual(["project_mark_specs", "in", "project_id", ["j"]]);
  expect(state.calls).toContainEqual(["window_types", "in", "id", ["t"]]);
  expect(state.calls.filter(call => call[1] === "abortSignal")).toHaveLength(3);
  expect(result.get("o")?.catalogType?.id).toBe("t"); expect(result.get("o")?.spec?.operation).toBe("XO");
});
it("falls back to existing description fields if stored kind columns are unavailable", async () => {
  state.missingKinds = true;
  expect((await readOpeningContexts(["o"])).get("o")?.spec?.operation).toBe("XO");
  expect(state.calls.filter(call => call[0] === "project_mark_specs" && call[1] === "select")).toHaveLength(2);
});
it("makes no reads for an empty opening set", async () => { expect((await readOpeningContexts([])).size).toBe(0); expect(state.calls).toEqual([]); });
