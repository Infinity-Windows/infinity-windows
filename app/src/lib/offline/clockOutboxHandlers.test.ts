// The queued half of Release 0's one-time ids (K0.2/K0.4/K0.5).
//
// A queued clock action is the retry path by definition — the outbox sends it
// until the server answers — so it is exactly where a resend became a double
// punch or a moved clock-out. Three things have to hold forever after this:
//   1. every queued clock action sends the id its tap was minted with, and the
//      tap time beside it, on every attempt;
//   2. an entry with no id is refused, never sent unkeyed;
//   3. a break end the server could not match is kept on /stuck in plain
//      words, not reported as "sent".

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableError, type OutboxEntry } from "./outbox-core";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");

const PUNCH = {
  clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77",
  tappedAt: "2026-09-23T13:02:11.000Z",
  clockCheckedAt: "2026-09-23T12:00:00.000Z",
  clockSkewMs: 1500,
};
const MISSING = { code: "PGRST202", message: "Could not find the function public.clock_in(...) in the schema cache" };

function entryFor(op: OutboxEntry["op"], payload: Record<string, unknown>): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op,
    payload,
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
  };
}

const resolver = createShiftResolver();
const handlers = createSupabaseHandlers(resolver);

async function send(op: OutboxEntry["op"], payload: Record<string, unknown>): Promise<void> {
  const handler = handlers[op];
  if (!handler) throw new Error(`no ${op} handler is registered`);
  await handler(entryFor(op, payload), { getBlob: async () => null });
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { id: "shift-1" }, error: null });
});

describe("the queued clock-in", () => {
  const base = { projectId: "job-1", costCodeId: "cc-1", lat: 1, lng: 2, note: "gate 4411", mode: "tracking" };

  it("sends the tap's id, its time, the last clock check, the mode and the note in one call", async () => {
    await send("clock_in", { ...base, ...PUNCH });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("clock_in", {
      p_project_id: "job-1",
      p_cost_code_id: "cc-1",
      p_photo: null,
      p_lat: 1,
      p_lng: 2,
      p_note: "gate 4411",
      p_mode: "tracking",
      p_client_id: PUNCH.clientId,
      p_tapped_at: PUNCH.tappedAt,
      p_clock_checked_at: PUNCH.clockCheckedAt,
      p_clock_skew_ms: 1500,
    });
  });

  it("uses the id from the tap, not the outbox entry's own id", async () => {
    // entry.id is born when the punch is QUEUED, one attempt too late: the live
    // try that may already have made the shift happened before it existed.
    await send("clock_in", { ...base, ...PUNCH });
    expect((rpc.mock.calls[0][1] as { p_client_id: string }).p_client_id).toBe(PUNCH.clientId);
    expect((rpc.mock.calls[0][1] as { p_client_id: string }).p_client_id).not.toBe("outbox-entry-1");
  });

  it("falls back to the older keyed overloads, keeping the id on every rung, and never to an unkeyed punch", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    rpc.mockResolvedValueOnce({ data: { id: "shift-1" }, error: null });
    await send("clock_in", { ...base, ...PUNCH });
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const call of rpc.mock.calls) {
      expect(call[1]).toHaveProperty("p_client_id", PUNCH.clientId);
    }
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_note: "gate 4411" });
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_mode");
    expect(rpc.mock.calls[2][1]).not.toHaveProperty("p_note");
  });

  it("refuses to send an entry with no id, permanently and in plain words", async () => {
    const err = await send("clock_in", base).catch((e: unknown) => e);
    expect(rpc).not.toHaveBeenCalled();
    expect(isRetryableError(err)).toBe(false);
    expect((err as Error).message).toContain("without its id");
    expect((err as Error).message).not.toMatch(/client_id|uuid|null value/);
  });

  it("stops on the first rung when every keyed overload is missing, in words a foreman can act on", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    const err = await send("clock_in", { ...base, ...PUNCH }).catch((e: unknown) => e);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(isRetryableError(err)).toBe(false);
    expect((err as Error).message).toContain("needs an app update");
  });

  it("records the shift for the punches queued behind it", async () => {
    await send("clock_in", { ...base, ...PUNCH });
    expect(resolver.resolve("pending:outbox-entry-1")).toBe("shift-1");
  });

  it("lets a real refusal through untouched, so the toolbox gate still dead-letters with its own words", async () => {
    const gate = { code: "P0001", message: "complete today's toolbox talk before clocking in" };
    rpc.mockResolvedValueOnce({ data: null, error: gate });
    await expect(send("clock_in", { ...base, ...PUNCH })).rejects.toBe(gate);
  });
});

describe("the queued clock-out", () => {
  const base = { shiftRef: "shift-1", injured: true, injuryNote: "cut hand", timeConfirmed: false, breakSeconds: 1800, lat: 1, lng: 2 };

  it("sends the id and the tap trio beside the punch's own fields", async () => {
    await send("clock_out", { ...base, ...PUNCH });
    expect(rpc).toHaveBeenCalledWith("clock_out", {
      p_shift_id: "shift-1",
      p_photo: null,
      p_injured: true,
      p_injury_note: "cut hand",
      p_time_confirmed: false,
      p_break_seconds: 1800,
      p_lat: 1,
      p_lng: 2,
      p_client_id: PUNCH.clientId,
      p_tapped_at: PUNCH.tappedAt,
      p_clock_checked_at: PUNCH.clockCheckedAt,
      p_clock_skew_ms: 1500,
    });
  });

  it("falls back to the legacy overload only when the keyed one is missing", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    rpc.mockResolvedValueOnce({ data: {}, error: null });
    await send("clock_out", { ...base, ...PUNCH });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_client_id");
  });

  it("refuses an entry with no id", async () => {
    const err = await send("clock_out", base).catch((e: unknown) => e);
    expect(rpc).not.toHaveBeenCalled();
    expect(isRetryableError(err)).toBe(false);
  });

  it("dead-letters the server's plain refusal of a second close instead of retrying it", async () => {
    const refusal = { code: "P0001", message: "This shift was already clocked out. Nothing was changed." };
    rpc.mockResolvedValueOnce({ data: null, error: refusal });
    const err = await send("clock_out", { ...base, ...PUNCH }).catch((e: unknown) => e);
    expect(err).toBe(refusal);
    expect(isRetryableError(err)).toBe(false);
  });

  it("waits for a pending clock-in rather than sending a made-up shift id", async () => {
    const fresh = createSupabaseHandlers(createShiftResolver());
    const err = await fresh
      .clock_out!(entryFor("clock_out", { ...base, ...PUNCH, shiftRef: "pending:never-synced" }), { getBlob: async () => null })
      .catch((e: unknown) => e);
    expect(rpc).not.toHaveBeenCalled();
    expect(isRetryableError(err)).toBe(true);
  });
});

describe("the queued break start", () => {
  it("sends the id, the tap trio and the break type", async () => {
    await send("break_start", { shiftRef: "shift-1", breakType: "lunch", ...PUNCH });
    expect(rpc).toHaveBeenCalledWith("start_break", {
      p_shift_id: "shift-1",
      p_break_type: "lunch",
      p_client_id: PUNCH.clientId,
      p_tapped_at: PUNCH.tappedAt,
      p_clock_checked_at: PUNCH.clockCheckedAt,
      p_clock_skew_ms: 1500,
    });
  });

  it("refuses an entry with no id", async () => {
    await expect(send("break_start", { shiftRef: "shift-1", breakType: "lunch" })).rejects.toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the queued break end (K0.4)", () => {
  it("sends the id and reads 'ended' as done", async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: "ended", shift: { id: "shift-1" } }, error: null });
    await send("break_stop", { shiftRef: "shift-1", ...PUNCH });
    expect(rpc).toHaveBeenCalledWith("end_break", {
      p_shift_id: "shift-1",
      p_client_id: PUNCH.clientId,
      p_tapped_at: PUNCH.tappedAt,
      p_clock_checked_at: PUNCH.clockCheckedAt,
      p_clock_skew_ms: 1500,
    });
  });

  it("keeps a break end the server could not match on /stuck, permanently, in the person's words", async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: "no_break_running", shift: { id: "shift-1" } }, error: null });
    const err = await send("break_stop", { shiftRef: "shift-1", ...PUNCH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isRetryableError(err)).toBe(false);
    expect((err as Error).message).toBe(
      "We couldn't find the start of that break, so it wasn't ended. Your foreman will check your breaks.",
    );
  });

  it("treats a shift clocked out meanwhile as nothing left to do", async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: "shift_closed", shift: { id: "shift-1" } }, error: null });
    await expect(send("break_stop", { shiftRef: "shift-1", ...PUNCH })).resolves.toBeUndefined();
  });

  it("falls back to the legacy end_break only when the keyed one is missing", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    rpc.mockResolvedValueOnce({ data: { id: "shift-1" }, error: null });
    await send("break_stop", { shiftRef: "shift-1", ...PUNCH });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toEqual({ p_shift_id: "shift-1" });
  });

  it("refuses an entry with no id", async () => {
    await expect(send("break_stop", { shiftRef: "shift-1" })).rejects.toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});
