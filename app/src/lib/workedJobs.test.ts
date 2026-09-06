import { beforeEach, describe, expect, it, vi } from "vitest";

// listMyWorkedJobs is one RPC call and one decision: what to do when the
// database has never heard of the function. Mocked the same indirected way
// photoTrash.test does, so the factory closes over the spy safely.
const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({}),
    storage: { from: () => ({}) },
  },
  supabaseConfigured: true,
}));

import { listMyWorkedJobs } from "./photos";

beforeEach(() => rpc.mockReset());

describe("listMyWorkedJobs", () => {
  it("asks the server for the same list the read policy uses", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await listMyWorkedJobs();
    expect(rpc).toHaveBeenCalledWith("list_my_worked_jobs");
  });

  it("maps the server's rows into the picker's shape", async () => {
    rpc.mockResolvedValue({
      data: [
        { id: "p1", job_code: "BLACK22", name: "Black Desert" },
        { id: "p2", job_code: "PECAN14", name: "Pecan Street" },
      ],
      error: null,
    });
    expect(await listMyWorkedJobs()).toEqual([
      { id: "p1", jobCode: "BLACK22", name: "Black Desert" },
      { id: "p2", jobCode: "PECAN14", name: "Pecan Street" },
    ]);
  });

  it("survives a row with no job code or name rather than rendering null", async () => {
    rpc.mockResolvedValue({ data: [{ id: "p1", job_code: null, name: null }], error: null });
    expect(await listMyWorkedJobs()).toEqual([{ id: "p1", jobCode: "", name: "" }]);
  });

  // The degrade path: a phone on today's bundle against a database that has
  // not had 20260993000000 applied yet. "We cannot tell" is not "you have
  // worked nothing" — the page shows the full jobs list for the first and an
  // empty picker for the second, so the two answers must be distinguishable.
  it("answers null — not an empty list — when the function is missing", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.list_my_worked_jobs" },
    });
    expect(await listMyWorkedJobs()).toBeNull();
  });

  it("answers null on Postgres' own undefined_function code too", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42883", message: "function list_my_worked_jobs() does not exist" },
    });
    expect(await listMyWorkedJobs()).toBeNull();
  });

  it("answers an empty list when the person has genuinely worked nothing", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await listMyWorkedJobs()).toEqual([]);
  });

  it("surfaces a real failure instead of quietly widening the picker", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    await expect(listMyWorkedJobs()).rejects.toMatchObject({
      message: expect.stringContaining("statement timeout"),
    });
  });
});
