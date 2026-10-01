// The queued daily log, on its way back out.
//
// The old handler upserted `daily_logs` directly with columns that table has
// never had (profile_id, created_by, client_id), through a table that has no
// insert policy at all. It also had zero callers, so nothing ever proved it
// would fail. fileDailyLog now queues for real, so this pins the two things
// that matter: it goes through file_daily_log, and it does not overwrite a log
// another foreman filed while this one waited for signal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";

const rpc = vi.fn();
const tableFrom = vi.fn();

vi.mock("../supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => rpc(fn, args),
    from: (table: string) => tableFrom(table),
    storage: { from: () => ({ upload: vi.fn() }) },
  },
  supabaseConfigured: true,
}));

const getDailyLog = vi.fn();
vi.mock("../dailyLogs", () => ({
  getDailyLog: (projectId: string, logDate: string) => getDailyLog(projectId, logDate),
  isStaleDailyLogError: (e: { code?: string }) => e?.code === "40001",
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());

const QUEUED_AT = Date.parse("2026-09-05T16:00:00Z");

function entry(over: Record<string, unknown> = {}): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op: "daily_log",
    payload: {
      projectId: "black22",
      logDate: "2026-09-05",
      headline: null,
      notes: "Set four units on the south wall.",
      dayFlow: "smooth",
      reflection: null,
      weather: null,
      ...over,
    },
    createdAt: QUEUED_AT,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
  };
}

async function drain(over: Record<string, unknown> = {}): Promise<void> {
  const handler = handlers.daily_log;
  if (!handler) throw new Error("no daily_log handler is registered");
  await handler(entry(over), { getBlob: async () => null });
}

beforeEach(() => {
  rpc.mockReset();
  tableFrom.mockReset();
  getDailyLog.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  getDailyLog.mockResolvedValue(null);
});

describe("a daily log that waited for signal", () => {
  it("goes through file_daily_log, never a write to the table", async () => {
    await drain();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("file_daily_log");
    // daily_logs has no insert policy — the RPC is the only writer there is.
    expect(tableFrom).not.toHaveBeenCalled();
  });

  it("carries every field the dialog collected", async () => {
    await drain({ headline: "South wall", weather: "Hot", reflection: { went_well: "Delivery" } });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_project_id: "black22",
      p_log_date: "2026-09-05",
      p_headline: "South wall",
      p_notes: "Set four units on the south wall.",
      p_day_flow: "smooth",
      p_weather: "Hot",
      p_reflection: { went_well: "Delivery" },
    });
  });

  it("appends instead of clobbering when another foreman filed first", async () => {
    getDailyLog.mockResolvedValue({
      id: "log-1",
      project_id: "black22",
      log_date: "2026-09-05",
      headline: null,
      notes: "Glass showed up late.",
      day_flow: null,
      reflection: null,
      weather: null,
      customer_visible: false,
      customer_visible_at: null,
      filed_by: "someone-else",
      updated_by: null,
      created_at: "2026-09-05T17:00:00Z",
      updated_at: "2026-09-05T17:00:00Z",
      revision: 1,
    });

    await drain();
    const sent = rpc.mock.calls[0][1] as Record<string, string>;
    expect(sent.p_notes).toContain("Glass showed up late.");
    expect(sent.p_notes).toContain("Set four units on the south wall.");
    expect(sent.p_notes).toContain("— added later from a phone that was offline");
    // Never a name and never an email: a builder login reads these notes.
    expect(String(sent.p_notes)).not.toMatch(/@/);
  });

  it("keeps the entry queued without writing when the current row cannot be read", async () => {
    getDailyLog.mockRejectedValue(new Error("nope"));
    await expect(drain()).rejects.toThrow("nope");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refetches and recombines after another writer wins between read and Save", async () => {
    getDailyLog.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "log-1", project_id: "black22", log_date: "2026-09-05", revision: 1,
      headline: "Office", notes: "Office work", day_flow: null, reflection: null, weather: "Rain",
    });
    rpc.mockResolvedValueOnce({ error: { code: "40001", message: "changed" } })
      .mockResolvedValueOnce({ error: null });
    await drain();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_expected_revision: 0 });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_expected_revision: 1, p_weather: "Rain" });
    expect(rpc.mock.calls[1][1].p_notes).toContain("Office work");
  });

  it("does not overwrite newer optional fields when a legacy queued edit contains server notes", async () => {
    getDailyLog.mockResolvedValue({ id: "log-1", project_id: "black22", log_date: "2026-09-05",
      revision: 2, headline: "Office", notes: "Set four units on the south wall.",
      day_flow: "stuck", reflection: { went_well: "Delivery" }, weather: "Rain" });
    await drain({ notes: "Set four units on the south wall. Closed out.", weather: "Sun" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_expected_revision: 2, p_weather: "Rain", p_day_flow: "stuck" });
  });

  it("dead-letters a log with no job rather than retrying it eight times", async () => {
    const handler = handlers.daily_log!;
    await expect(
      handler(entry({ projectId: null }), { getBlob: async () => null }),
    ).rejects.toMatchObject({ permanent: true });
    expect(rpc).not.toHaveBeenCalled();
  });
});
