// The two K2.8 seams in the schedule data layer: a re-created row keeps the
// AI flag it was created with (the flag is permanent — CONTEXT.md:
// AI-proposed), and the model's reason comes back from the draft's own
// 'created' audit event, never from the crew-visible `note`.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call { table: string; op: string; args: unknown[] }
const calls: Call[] = [];
let respond: (table: string, ops: string[]) => unknown = () => ({ data: null, error: null });

/** A chainable, awaitable stand-in for one supabase query builder. */
function builder(table: string): unknown {
  const ops: string[] = [];
  const b: Record<string | symbol, unknown> = {};
  return new Proxy(b, {
    get(_t, prop) {
      if (prop === "then") {
        const result = respond(table, ops);
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      }
      return (...args: unknown[]) => {
        ops.push(String(prop));
        calls.push({ table, op: String(prop), args });
        return new Proxy(b, this as ProxyHandler<Record<string | symbol, unknown>>);
      };
    },
  });
}

vi.mock("../supabase", () => ({
  supabase: {
    from: (table: string) => builder(table),
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    rpc: async () => ({ data: null, error: null }),
  },
  supabaseConfigured: true,
}));

const { createAssignment, listAiDraftReasons } = await import("./api");

const RAW = {
  id: "new-id", project_id: "p", start_date: "2026-09-28", end_date: "2026-09-28", start_time: null, status: "draft",
  color: null, note: null, created_by: "me", created_via: "ai", published_at: null, created_at: "", updated_at: "",
  schedule_assignment_members: [], projects: null,
};

beforeEach(() => {
  calls.length = 0;
  respond = (table, ops) => {
    if (table === "schedule_assignments" && ops.includes("insert")) return { data: { id: "new-id" }, error: null };
    if (table === "schedule_assignments") return { data: [RAW], error: null };
    return { data: null, error: null };
  };
});

const insertPayload = (table: string) => calls.find((c) => c.table === table && c.op === "insert")?.args[0] as Record<string, unknown>;

describe("createAssignment and the AI flag", () => {
  it("puts the AI flag back on a row Undo re-creates", async () => {
    await createAssignment({ project_id: "p", start_date: "2026-09-28", end_date: "2026-09-28", members: [{ profile_id: "ana", role: "installer" }], created_via: "ai" });
    expect(insertPayload("schedule_assignments")).toMatchObject({ status: "draft", created_via: "ai" });
  });
  it("never invents the flag on a human's own new row", async () => {
    await createAssignment({ project_id: "p", start_date: "2026-09-28", end_date: "2026-09-28", members: [{ profile_id: "ana", role: "installer" }] });
    expect(insertPayload("schedule_assignments")).not.toHaveProperty("created_via");
    await createAssignment({ project_id: "p", start_date: "2026-09-28", end_date: "2026-09-28", members: [], created_via: null });
    expect(calls.filter((c) => c.table === "schedule_assignments" && c.op === "insert")[1].args[0]).not.toHaveProperty("created_via");
  });
});

describe("listAiDraftReasons", () => {
  it("reads the 'created' events of the given drafts and keeps only the AI's reasons", async () => {
    respond = (table) => table === "schedule_events"
      ? { data: [
          { assignment_id: "a", payload: { ai: true, reason: " Lead with wet glazing " } },
          { assignment_id: "b", payload: { ai: true } },
          { assignment_id: "c", payload: null },
          { assignment_id: "d", payload: { reason: "a human typed this" } },
        ], error: null }
      : { data: null, error: null };
    const reasons = await listAiDraftReasons(["a", "b", "c", "d"]);
    expect([...reasons.entries()]).toEqual([["a", "Lead with wet glazing"]]);
    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual(["schedule_events.select", "schedule_events.eq", "schedule_events.in"]);
    expect(calls[1].args).toEqual(["kind", "created"]);
    expect(calls[2].args).toEqual(["assignment_id", ["a", "b", "c", "d"]]);
  });
  it("asks nothing for no drafts, and reads a missing audit table as no reasons", async () => {
    expect((await listAiDraftReasons([])).size).toBe(0);
    expect(calls).toEqual([]);
    respond = () => ({ data: null, error: { code: "42P01", message: 'relation "public.schedule_events" does not exist' } });
    expect((await listAiDraftReasons(["a"])).size).toBe(0);
  });
  it("surfaces any other error so the card can say the reasons did not load", async () => {
    respond = () => ({ data: null, error: { code: "PGRST301", message: "JWT expired" } });
    await expect(listAiDraftReasons(["a"])).rejects.toMatchObject({ code: "PGRST301" });
  });
});
