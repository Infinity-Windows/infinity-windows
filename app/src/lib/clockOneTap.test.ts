
// One-tap clock buttons (K2.4): the tap uses the clock sheet's own path and
// refuses honestly when the button no longer fits the person's clock.
import { describe, expect, it } from "vitest";
import { oneTapFits, runOneTap, type OneTapDeps } from "./clockOneTap";
import type { ClockPunch } from "./clockPunch";
import type { TimeShift } from "./timeclock";

const shift = (over: Partial<TimeShift> = {}): TimeShift => ({
  id: "00000000-0000-4000-8000-000000000501", profile_id: "p1", project_id: "j1", cost_code_id: null,
  clock_in_at: "2026-09-23T13:00:00Z", clock_out_at: null, break_seconds: 0, break_started_at: null,
  injured: null, time_confirmed: null, status: "open", created_at: "2026-09-23T13:00:00Z", ...over,
});
const REAL = "00000000-0000-4000-8000-000000000501";
const LANDED = "00000000-0000-4000-8000-0000000007a1";
const offline = () => new TypeError("Failed to fetch");

function deps(over: Partial<OneTapDeps> = {}) {
  const calls: string[] = [];
  const punches: ClockPunch[] = [];
  let n = 0;
  const d: OneTapDeps = {
    startBreak: async (id, type, p) => { calls.push(`start:${id}:${type}:${p.clientId}`); },
    endBreak: async (id, p) => { calls.push(`end:${id}:${p.clientId}`); },
    queueBreakStart: async (id, type, p) => { calls.push(`queue-start:${id}:${type}:${p.clientId}`); },
    queueBreakStop: async (id, p) => { calls.push(`queue-end:${id}:${p.clientId}`); },
    shouldQueue: (e) => e instanceof TypeError,
    resolveShiftRef: () => null,
    mintPunch: () => {
      n += 1;
      const p = { clientId: `tap-${n}`, tappedAt: "2026-09-23T17:00:00.000Z", clockCheckedAt: null, clockSkewMs: null };
      punches.push(p);
      return p;
    },
    ...over,
  };
  return { d, calls, punches };
}

describe("does the button fit the clock?", () => {
  it("start break needs an open shift with no break; end break needs a running break", () => {
    expect(oneTapFits("start_break", null)).toEqual({ kind: "refused", reason: "not_clocked_in" });
    expect(oneTapFits("start_break", shift({ break_started_at: "2026-09-23T17:00:00Z" }))).toEqual({ kind: "refused", reason: "already_on_break" });
    expect(oneTapFits("start_break", shift())).toBeNull();
    expect(oneTapFits("end_break", shift())).toEqual({ kind: "refused", reason: "not_on_break" });
    expect(oneTapFits("end_break", shift({ break_started_at: "2026-09-23T17:00:00Z" }))).toBeNull();
    // A closed shift is no shift.
    expect(oneTapFits("start_break", shift({ clock_out_at: "2026-09-23T21:00:00Z", status: "submitted" }))).toEqual({ kind: "refused", reason: "not_clocked_in" });
  });
  it("clock in and clock out always open the job clock — its safety questions live there", () => {
    expect(oneTapFits("clock_out", shift())).toEqual({ kind: "open_clock", action: "clock_out" });
    expect(oneTapFits("clock_in", null)).toEqual({ kind: "open_clock", action: "clock_in" });
  });
});

describe("the tap", () => {
  it("starts the break through the RPC, with the type the person chose and the tap's punch", async () => {
    const { d, calls } = deps();
    expect(await runOneTap({ action: "start_break", break_type: null }, shift(), "lunch", d)).toEqual({ kind: "done", action: "start_break", queued: false });
    expect(calls).toEqual([`start:${REAL}:lunch:tap-1`]);
  });
  it("uses the type the AI heard when the person picked none, and 'other' when nobody said", async () => {
    const { d, calls } = deps();
    await runOneTap({ action: "start_break", break_type: "rest" }, shift(), null, d);
    await runOneTap({ action: "start_break", break_type: null }, shift(), null, d);
    expect(calls).toEqual([`start:${REAL}:rest:tap-1`, `start:${REAL}:other:tap-2`]);
  });
  it("queues the same write the clock sheet would when there is no signal", async () => {
    const { d, calls } = deps({ startBreak: async () => { throw offline(); }, endBreak: async () => { throw offline(); } });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d)).toEqual({ kind: "done", action: "start_break", queued: true });
    expect(await runOneTap({ action: "end_break", break_type: null }, shift({ break_started_at: "2026-09-23T17:00:00Z" }), null, d)).toEqual({ kind: "done", action: "end_break", queued: true });
    expect(calls).toEqual([`queue-start:${REAL}:lunch:tap-1`, `queue-end:${REAL}:tap-2`]);
  });
  it("a real refusal from the server is reported as nothing changed, never queued", async () => {
    const { d, calls } = deps({ startBreak: async () => { throw new Error("P0001: shift is not open"); } });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d)).toEqual({ kind: "refused", reason: "failed" });
    expect(calls).toEqual([]);
  });
  it("refuses before calling anything when the button does not fit", async () => {
    const { d, calls, punches } = deps();
    expect(await runOneTap({ action: "end_break", break_type: null }, shift(), null, d)).toEqual({ kind: "refused", reason: "not_on_break" });
    expect(calls).toEqual([]);
    expect(punches).toEqual([]);
  });
});

// Codex review of #641 (2026-09-25): the break button bound the pre-Release-0
// queue functions and minted nothing, so after #640 a lost reply would have
// been resent as a DIFFERENT tap. One punch per tap, minted before the first
// try, through both paths.
describe("one punch per tap, through the direct try and the queue", () => {
  it("mints the punch once, before the first try, and hands the very same punch to the queue", async () => {
    const seen: ClockPunch[] = [];
    const { d, punches } = deps({
      startBreak: async (_id, _t, p) => { seen.push(p); throw offline(); },
      queueBreakStart: async (_id, _t, p) => { seen.push(p); },
    });
    await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d);
    expect(punches).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(punches[0]);
    expect(seen[1]).toBe(punches[0]);
  });

  it("and the same for a break end", async () => {
    const seen: ClockPunch[] = [];
    const { d, punches } = deps({
      endBreak: async (_id, p) => { seen.push(p); throw offline(); },
      queueBreakStop: async (_id, p) => { seen.push(p); },
    });
    await runOneTap({ action: "end_break", break_type: null }, shift({ break_started_at: "2026-09-23T17:00:00Z" }), null, d);
    expect(punches).toHaveLength(1);
    expect(seen).toEqual([punches[0], punches[0]]);
  });

  it("a break the server saved whose reply was lost, then resent by the queue, is one break", async () => {
    // The server, keyed the way 20261028000000 keys it: a repeat of a client
    // id is answered with the original and changes nothing.
    const ledger = new Map<string, string>();
    let breaksStarted = 0;
    const serverStartBreak = (shiftId: string, p: ClockPunch) => {
      if (!ledger.has(p.clientId)) {
        ledger.set(p.clientId, shiftId);
        breaksStarted += 1;
      }
    };
    const queued: { shiftId: string; punch: ClockPunch }[] = [];
    const { d } = deps({
      // Saved on the server, and the reply never made it back.
      startBreak: async (id, _t, p) => { serverStartBreak(id, p); throw offline(); },
      queueBreakStart: async (id, _t, p) => { queued.push({ shiftId: id, punch: p }); },
    });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d)).toEqual({ kind: "done", action: "start_break", queued: true });
    // The signal comes back and the queue sends what it holds.
    for (const q of queued) serverStartBreak(q.shiftId, q.punch);
    expect(breaksStarted).toBe(1);
    expect(ledger.size).toBe(1);
  });
});

// #644: a pending shift ref is placed through the sender's own map, never
// refused and never sent to a uuid RPC.
describe("a clock-in still on the phone", () => {
  const pending = () => shift({ id: "pending:entry-1" });

  it("queues the break behind that clock-in, with the tap's punch, and sends nothing", async () => {
    const { d, calls } = deps();
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, pending(), null, d)).toEqual({ kind: "done", action: "start_break", queued: true });
    expect(calls).toEqual(["queue-start:pending:entry-1:lunch:tap-1"]);
  });

  it("and the break end behind it too", async () => {
    const { d, calls } = deps();
    const onBreak = shift({ id: "pending:entry-1", break_started_at: "2026-09-23T17:00:00Z" });
    expect(await runOneTap({ action: "end_break", break_type: null }, onBreak, null, d)).toEqual({ kind: "done", action: "end_break", queued: true });
    expect(calls).toEqual(["queue-end:pending:entry-1:tap-1"]);
  });

  it("once that clock-in has landed, the sender's map names its shift and the tap goes straight there", async () => {
    const asked: string[] = [];
    const { d, calls } = deps({ resolveShiftRef: (ref) => { asked.push(ref); return ref === "pending:entry-1" ? LANDED : null; } });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, pending(), null, d)).toEqual({ kind: "done", action: "start_break", queued: false });
    expect(asked).toEqual(["pending:entry-1"]);
    expect(calls).toEqual([`start:${LANDED}:lunch:tap-1`]);
  });

  it("a landed clock-in with no signal queues on that shift with the same punch", async () => {
    const { d, calls } = deps({ resolveShiftRef: () => LANDED, startBreak: async () => { throw offline(); } });
    await runOneTap({ action: "start_break", break_type: "lunch" }, pending(), null, d);
    expect(calls).toEqual([`queue-start:${LANDED}:lunch:tap-1`]);
  });

  it("never asks the map about a real shift id", async () => {
    const asked: string[] = [];
    const { d } = deps({ resolveShiftRef: (ref) => { asked.push(ref); return null; } });
    await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d);
    expect(asked).toEqual([]);
  });
});

describe("when the phone cannot keep the punch", () => {
  it("after a direct try lost on the network, it says it could not tell — not 'nothing changed'", async () => {
    const { d } = deps({
      startBreak: async () => { throw offline(); },
      queueBreakStart: async () => { throw new Error("Couldn't save this offline (storage may be full)"); },
    });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d)).toEqual({ kind: "refused", reason: "unconfirmed" });
  });

  it("with no direct try at all (a clock-in still on the phone), nothing reached Forge", async () => {
    const { d, calls } = deps({ queueBreakStart: async () => { throw new Error("Couldn't save this offline (storage may be full)"); } });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift({ id: "pending:entry-1" }), null, d)).toEqual({ kind: "refused", reason: "failed" });
    expect(calls).toEqual([]);
  });
});
