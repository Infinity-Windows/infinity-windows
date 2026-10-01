// Bounded, true pagination for the cross-job Daily Logs page (independent
// review, 2026-10-01): pageSize is clamped under PostgREST's own row cap
// (a caller widening pageSize instead of paging would eventually hit that
// cap, which silently truncates — "no more rows" would then be a lie, not a
// fact), and a job filter is applied SERVER-SIDE so a job's older logs on an
// unloaded page are never read as "this job has no more history."
import { beforeEach, expect, it, vi } from "vitest";

function chain(rows: Record<string, unknown>[], count: number) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "gte", "lte", "eq", "order"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.range = (...args: unknown[]) => {
    calls.push({ method: "range", args });
    return Promise.resolve({ data: rows, error: null, count });
  };
  return { builder, calls };
}

const m = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from: m.from }, supabaseConfigured: true }));
const { listMyDailyLogs, DAILY_LOGS_PAGE_SIZE } = await import("./dailyLogs");

beforeEach(() => { m.from.mockReset(); });

it("filters by project server-side when given, not just on whatever page already loaded", async () => {
  const { builder, calls } = chain([], 0);
  m.from.mockReturnValue(builder);
  await listMyDailyLogs({ projectId: "job-1", offset: 0, pageSize: 50 });
  expect(calls.some((c) => c.method === "eq" && c.args[0] === "project_id" && c.args[1] === "job-1")).toBe(true);
});

it("omits the project filter entirely when no job is selected", async () => {
  const { builder, calls } = chain([], 0);
  m.from.mockReturnValue(builder);
  await listMyDailyLogs({ offset: 0, pageSize: 50 });
  expect(calls.some((c) => c.method === "eq")).toBe(false);
});

it("never asks for more than one bounded page, even if told to", async () => {
  const { builder, calls } = chain([], 0);
  m.from.mockReturnValue(builder);
  await listMyDailyLogs({ offset: 100, pageSize: 5000 });
  const range = calls.find((c) => c.method === "range")!;
  expect(range.args).toEqual([100, 100 + DAILY_LOGS_PAGE_SIZE]);
});

it("hasMore is read from the one extra row fetched, not assumed from a provider cap", async () => {
  const rows = Array.from({ length: DAILY_LOGS_PAGE_SIZE + 1 }, (_, i) => ({ id: `log-${i}`, log_date: "2026-10-01" }));
  const { builder } = chain(rows, rows.length);
  m.from.mockReturnValue(builder);
  const page = await listMyDailyLogs({ offset: 0 });
  expect(page.logs).toHaveLength(DAILY_LOGS_PAGE_SIZE);
  expect(page.hasMore).toBe(true);
});

it("hasMore is false when the page itself came back short", async () => {
  const rows = [{ id: "log-0", log_date: "2026-10-01" }];
  const { builder } = chain(rows, rows.length);
  m.from.mockReturnValue(builder);
  const page = await listMyDailyLogs({ offset: 0 });
  expect(page.hasMore).toBe(false);
});
