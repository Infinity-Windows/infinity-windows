// The K2.8 seams in the schedule data layer: a re-created row keeps the AI
// flag it was created with (the flag is permanent — CONTEXT.md: AI-proposed);
// the model's reason comes back from schedule_ai_reasons, the table with the
// supervisor-only read policy, never from the crew-visible `note` or the
// crew-readable audit event; the review card's Drop deletes only a row that is
// still the draft it showed; and a publish whose reply was lost is re-read
// before anything is claimed.
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

const { confirmPublished, createAssignment, dropDraftAssignment, listAiDraftReasons, publishAssignments } = await import("./api");
const { isUnconfirmedPublishError, outcomeFromReadback } = await import("./publishOutcome");

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
  it("reads schedule_ai_reasons for the given drafts — the walled table, never schedule_events or the note", async () => {
    respond = (table) => table === "schedule_ai_reasons"
      ? { data: [
          { assignment_id: "a", reason: " Lead with wet glazing " },
          { assignment_id: "b", reason: "   " },
          { assignment_id: null, reason: "orphan" },
        ], error: null }
      : { data: null, error: null };
    const reasons = await listAiDraftReasons(["a", "b", "c"]);
    expect([...reasons.entries()]).toEqual([["a", "Lead with wet glazing"]]);
    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual(["schedule_ai_reasons.select", "schedule_ai_reasons.in"]);
    expect(calls[0].args).toEqual(["assignment_id, reason"]);
    expect(calls[1].args).toEqual(["assignment_id", ["a", "b", "c"]]);
    expect(calls.some((c) => c.table === "schedule_events")).toBe(false);
  });
  it("a login the policy hides the rows from simply gets no reasons: zero rows is not an error", async () => {
    respond = (table) => table === "schedule_ai_reasons" ? { data: [], error: null } : { data: null, error: null };
    expect((await listAiDraftReasons(["a"])).size).toBe(0);
  });
  it("asks nothing for no drafts, and reads a missing table as no reasons", async () => {
    expect((await listAiDraftReasons([])).size).toBe(0);
    expect(calls).toEqual([]);
    respond = () => ({ data: null, error: { code: "42P01", message: 'relation "public.schedule_ai_reasons" does not exist' } });
    expect((await listAiDraftReasons(["a"])).size).toBe(0);
  });
  it("surfaces any other error so the card can say the reasons did not load", async () => {
    respond = () => ({ data: null, error: { code: "PGRST301", message: "JWT expired" } });
    await expect(listAiDraftReasons(["a"])).rejects.toMatchObject({ code: "PGRST301" });
  });
});

describe("dropDraftAssignment (the review card's Drop)", () => {
  const draft = { id: "a", updated_at: "2026-09-24T12:00:00.000000+00:00" };
  it("deletes only a row still in draft at the revision the card showed, then writes the audit row", async () => {
    respond = (table, ops) => table === "schedule_assignments" && ops.includes("delete") ? { data: [{ id: "a" }], error: null } : { data: null, error: null };
    expect(await dropDraftAssignment(draft)).toBe("dropped");
    const del = calls.filter((c) => c.table === "schedule_assignments");
    expect(del.map((c) => c.op)).toEqual(["delete", "eq", "eq", "eq", "select"]);
    expect(del[1].args).toEqual(["id", "a"]);
    expect(del[2].args).toEqual(["status", "draft"]);
    expect(del[3].args).toEqual(["updated_at", draft.updated_at]);
    expect(calls.find((c) => c.table === "schedule_events" && c.op === "insert")?.args[0]).toMatchObject({ assignment_id: "a", kind: "removed" });
  });
  it("two supervisors: the other one published first, so this stale Drop deletes nothing and says the draft changed", async () => {
    // Zero rows matched: the row is now status 'published' with a newer
    // updated_at, so neither filter lets the delete through. PostgREST
    // answers with an empty list, not an error.
    respond = (table, ops) => table === "schedule_assignments" && ops.includes("delete") ? { data: [], error: null } : { data: null, error: null };
    expect(await dropDraftAssignment(draft)).toBe("changed");
    expect(calls.some((c) => c.table === "schedule_events")).toBe(false);
  });
  it("a refusal is still an error, never a silent 'dropped' — even one whose wording names the table", async () => {
    respond = () => ({ data: null, error: { code: "42501", message: "permission denied for table schedule_assignments" } });
    await expect(dropDraftAssignment(draft)).rejects.toMatchObject({ code: "42501" });
    expect(calls.some((c) => c.table === "schedule_events")).toBe(false);
  });
});

describe("a publish whose reply was lost", () => {
  // supabase-js hands a fetch failure back as an error object, not a throw;
  // publishAssignments rethrows it. This is the shape it has.
  const LOST = { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" };
  it("server commit, then response loss: the re-read finds every row published and the outcome is success", async () => {
    respond = (table, ops) => {
      if (table === "schedule_assignments" && ops.includes("update")) return { data: null, error: LOST };
      if (table === "schedule_assignments") return { data: [{ id: "a", status: "published" }, { id: "b", status: "published" }], error: null };
      return { data: null, error: null };
    };
    let caught: unknown = null;
    await publishAssignments(["a", "b"]).catch((e) => { caught = e; });
    expect(caught).toEqual(LOST);
    expect(isUnconfirmedPublishError(caught)).toBe(true);
    const readback = await confirmPublished(["a", "b"]);
    expect(readback).toEqual({ published: ["a", "b"], drafts: [], missing: [] });
    expect(outcomeFromReadback(readback)).toEqual({ kind: "published", ids: ["a", "b"] });
    // The audit rows the lost reply never let publishAssignments write.
    expect(calls.filter((c) => c.table === "schedule_events" && c.op === "insert").map((c) => (c.args[0] as { assignment_id: string; kind: string }))).toEqual([
      { assignment_id: "a", actor: "me", kind: "published", payload: null },
      { assignment_id: "b", actor: "me", kind: "published", payload: null },
    ]);
  });
  it("a database refusal is confirmed: nothing to re-read — and it is never mistaken for a missing table and 'published' locally", async () => {
    // The refusal names the table, which isMissingTable's wording fallback
    // used to read as "not migrated yet" and hand to the browser-local store.
    const refused = { code: "42501", message: 'new row violates row-level security policy for table "schedule_assignments"' };
    respond = (table, ops) => table === "schedule_assignments" && ops.includes("update") ? { data: null, error: refused } : { data: null, error: null };
    let caught: unknown = null;
    await publishAssignments(["a"]).catch((e) => { caught = e; });
    expect(caught).toEqual(refused);
    expect(isUnconfirmedPublishError(caught)).toBe(false);
    expect(calls.some((c) => c.table === "schedule_events")).toBe(false);
  });
  it("a table that is genuinely not there yet still falls back to the browser-local store", async () => {
    respond = () => ({ data: null, error: { code: "42P01", message: 'relation "public.schedule_assignments" does not exist' } });
    await expect(publishAssignments(["a"])).resolves.toBeUndefined();
  });
  it("the re-read sorts rows into published, still draft and not readable", async () => {
    respond = (table) => table === "schedule_assignments" ? { data: [{ id: "a", status: "published" }, { id: "b", status: "draft" }], error: null } : { data: null, error: null };
    expect(await confirmPublished(["a", "b", "c"])).toEqual({ published: ["a"], drafts: ["b"], missing: ["c"] });
    expect(calls.filter((c) => c.table === "schedule_assignments").map((c) => c.op)).toEqual(["select", "in"]);
    expect(await confirmPublished([])).toEqual({ published: [], drafts: [], missing: [] });
  });
  it("a re-read that fails throws, so the caller knows it knows nothing", async () => {
    respond = () => ({ data: null, error: LOST });
    await expect(confirmPublished(["a"])).rejects.toEqual(LOST);
  });
});
