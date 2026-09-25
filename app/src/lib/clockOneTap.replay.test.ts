// The Ask break button against the real clock path (Codex review of #641,
// 2026-09-25): the real startBreak / endBreak, the real outbox and its real
// sender, with only the server stubbed — and stubbed the way 20261028000000
// behaves: a repeat of a client id is answered with the original and changes
// nothing. The case that matters is the one a phone on one bar meets: the
// server saves the tap, the reply is lost, the phone queues it, and the queue
// sends it again. That has to be ONE break, which it only is if the direct
// try and the queued resend carry the same punch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));
vi.mock("./signedIn", () => ({ signedInEmail: () => "e2e@example.test" }));
vi.mock("./offline/telemetry", () => ({ logOfflineEvent: () => {} }));

const outbox = await import("./offline/outbox");
const { runOneTap } = await import("./clockOneTap");
import type { TimeShift } from "./timeclock";

const SHIFT = "00000000-0000-4000-8000-000000000501";
const open = (over: Partial<TimeShift> = {}): TimeShift => ({
  id: SHIFT, profile_id: "p1", project_id: "j1", cost_code_id: null,
  clock_in_at: "2026-09-23T13:00:00Z", clock_out_at: null, break_seconds: 0, break_started_at: null,
  injured: null, time_confirmed: null, status: "open", created_at: "2026-09-23T13:00:00Z", ...over,
});

/** What supabase-js hands back when fetch itself failed: the reply is lost. */
const LOST_REPLY = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };

type Args = Record<string, unknown>;

/**
 * A keyed clock server. `loseFirstReply`: the first call is SAVED and then its
 * reply is lost on the way back to the phone.
 */
function keyedServer(opts: { loseFirstReply: boolean }) {
  const ledger = new Map<string, unknown>();
  const effects: string[] = [];
  const calls: { fn: string; args: Args }[] = [];
  rpc.mockImplementation(async (fn: string, args: Args) => {
    calls.push({ fn, args });
    const id = String(args.p_client_id ?? "");
    if (!id) return { data: null, error: { message: "missing client id", code: "P0001" } };
    if (!ledger.has(id)) {
      const row =
        fn === "start_break"
          ? open({ break_started_at: "2026-09-23T17:00:00Z", break_type: "lunch" })
          : { outcome: "ended", shift: open({ break_seconds: 1800 }) };
      ledger.set(id, row);
      effects.push(fn);
    }
    if (opts.loseFirstReply && calls.length === 1) return LOST_REPLY;
    return { data: ledger.get(id), error: null };
  });
  return { ledger, effects, calls };
}

beforeEach(async () => {
  rpc.mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await outbox.recoverAndDrain();
});
afterEach(() => {
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

async function queueSettled() {
  await vi.waitFor(() => expect(outbox.getClockQueueSnapshot().entries).toEqual([]), { timeout: 2000, interval: 10 });
}

describe("a break the server saved whose reply was lost", () => {
  it("is resent by the queue with the same punch, and counts once", async () => {
    const server = keyedServer({ loseFirstReply: true });
    const out = await runOneTap({ action: "start_break", break_type: "lunch" }, open(), null);
    // The phone could not know it was saved, so it says it kept it.
    expect(out).toEqual({ kind: "done", action: "start_break", queued: true });
    await outbox.drain();
    await queueSettled();

    expect(server.calls.map((c) => c.fn)).toEqual(["start_break", "start_break"]);
    const [first, resend] = server.calls.map((c) => c.args);
    expect(resend.p_client_id).toBe(first.p_client_id);
    expect(resend.p_tapped_at).toBe(first.p_tapped_at);
    expect(resend.p_shift_id).toBe(SHIFT);
    // One break on the server, one ledger row.
    expect(server.effects).toEqual(["start_break"]);
    expect(server.ledger.size).toBe(1);
  });

  it("and the same for a break end", async () => {
    const server = keyedServer({ loseFirstReply: true });
    const out = await runOneTap({ action: "end_break", break_type: null }, open({ break_started_at: "2026-09-23T17:00:00Z" }), null);
    expect(out).toEqual({ kind: "done", action: "end_break", queued: true });
    await outbox.drain();
    await queueSettled();

    expect(server.calls.map((c) => c.fn)).toEqual(["end_break", "end_break"]);
    expect(server.calls[1].args.p_client_id).toBe(server.calls[0].args.p_client_id);
    expect(server.effects).toEqual(["end_break"]);
  });

  it("a reply that arrives is one call and nothing queued", async () => {
    const server = keyedServer({ loseFirstReply: false });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, open(), null)).toEqual({ kind: "done", action: "start_break", queued: false });
    await outbox.drain();
    expect(server.calls).toHaveLength(1);
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
  });

  it("two taps are two punches — the id belongs to the tap, not to the button", async () => {
    const server = keyedServer({ loseFirstReply: false });
    await runOneTap({ action: "start_break", break_type: "lunch" }, open(), null);
    await runOneTap({ action: "end_break", break_type: null }, open({ break_started_at: "2026-09-23T17:00:00Z" }), null);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0].args.p_client_id).not.toBe(server.calls[1].args.p_client_id);
  });
});

describe("a break on a clock-in still on the phone", () => {
  it("waits behind that clock-in and lands on the shift it becomes, with the tap's punch", async () => {
    // No signal: the clock-in and the break both stay on the phone.
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const clockInId = await outbox.enqueueClockIn({
      projectId: "j1",
      costCodeId: null,
      punch: { clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77", tappedAt: "2026-09-23T13:00:00.000Z", clockCheckedAt: null, clockSkewMs: null },
    });
    const ref = outbox.pendingRefForShift(clockInId);
    const out = await runOneTap({ action: "start_break", break_type: "lunch" }, open({ id: ref }), null);
    expect(out).toEqual({ kind: "done", action: "start_break", queued: true });
    expect(rpc).not.toHaveBeenCalled();

    // Signal: the clock-in lands as shift SHIFT, then the break goes to it.
    const breaks: Args[] = [];
    rpc.mockImplementation(async (fn: string, args: Args) => {
      if (fn === "clock_in") return { data: open(), error: null };
      if (fn === "start_break") {
        breaks.push(args);
        return { data: open({ break_started_at: "2026-09-23T17:00:00Z" }), error: null };
      }
      return { data: null, error: { message: `unexpected ${fn}`, code: "P0001" } };
    });
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    await outbox.drain();
    await queueSettled();
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["clock_in", "start_break"]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].p_shift_id).toBe(SHIFT);
    expect(typeof breaks[0].p_client_id).toBe("string");
    expect(outbox.resolveShiftRef(ref)).toBe(SHIFT);
  });
});
