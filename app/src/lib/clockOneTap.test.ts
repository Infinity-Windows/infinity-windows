// One-tap clock buttons (K2.4): the tap uses the clock sheet's own path and
// refuses honestly when the button no longer fits the person's clock.
import { describe, expect, it } from "vitest";
import { oneTapFits, runOneTap, type OneTapDeps } from "./clockOneTap";
import type { TimeShift } from "./timeclock";

const shift = (over: Partial<TimeShift> = {}): TimeShift => ({
  id: "00000000-0000-4000-8000-000000000501", profile_id: "p1", project_id: "j1", cost_code_id: null,
  clock_in_at: "2026-09-23T13:00:00Z", clock_out_at: null, break_seconds: 0, break_started_at: null,
  injured: null, time_confirmed: null, status: "open", created_at: "2026-09-23T13:00:00Z", ...over,
});
function deps(over: Partial<OneTapDeps> = {}) {
  const calls: string[] = [];
  const d: OneTapDeps = {
    startBreak: async (id, type) => { calls.push(`start:${id}:${type}`); },
    endBreak: async (id) => { calls.push(`end:${id}`); },
    queueBreakStart: async (id, type) => { calls.push(`queue-start:${id}:${type}`); },
    queueBreakStop: async (id) => { calls.push(`queue-end:${id}`); },
    shouldQueue: (e) => e instanceof TypeError,
    ...over,
  };
  return { d, calls };
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
  it("starts the break through the RPC, with the type the person chose", async () => {
    const { d, calls } = deps();
    expect(await runOneTap({ action: "start_break", break_type: null }, shift(), "lunch", d)).toEqual({ kind: "done", action: "start_break", queued: false });
    expect(calls).toEqual(["start:00000000-0000-4000-8000-000000000501:lunch"]);
  });
  it("uses the type the AI heard when the person picked none, and 'other' when nobody said", async () => {
    const { d, calls } = deps();
    await runOneTap({ action: "start_break", break_type: "rest" }, shift(), null, d);
    await runOneTap({ action: "start_break", break_type: null }, shift(), null, d);
    expect(calls).toEqual(["start:00000000-0000-4000-8000-000000000501:rest", "start:00000000-0000-4000-8000-000000000501:other"]);
  });
  it("queues the same write the clock sheet would when there is no signal", async () => {
    const { d, calls } = deps({ startBreak: async () => { throw new TypeError("Failed to fetch"); }, endBreak: async () => { throw new TypeError("Failed to fetch"); } });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d)).toEqual({ kind: "done", action: "start_break", queued: true });
    expect(await runOneTap({ action: "end_break", break_type: null }, shift({ break_started_at: "2026-09-23T17:00:00Z" }), null, d)).toEqual({ kind: "done", action: "end_break", queued: true });
    expect(calls).toEqual(["queue-start:00000000-0000-4000-8000-000000000501:lunch", "queue-end:00000000-0000-4000-8000-000000000501"]);
  });
  it("a real refusal from the server is reported as nothing changed, never queued", async () => {
    const { d, calls } = deps({ startBreak: async () => { throw new Error("P0001: shift is not open"); } });
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift(), null, d)).toEqual({ kind: "refused", reason: "failed" });
    expect(calls).toEqual([]);
  });
  it("never sends a queued clock-in's pending id to a UUID RPC", async () => {
    const { d, calls } = deps();
    expect(await runOneTap({ action: "start_break", break_type: "lunch" }, shift({ id: "pending:abc" }), null, d)).toEqual({ kind: "refused", reason: "pending" });
    expect(calls).toEqual([]);
  });
  it("refuses before calling anything when the button does not fit", async () => {
    const { d, calls } = deps();
    expect(await runOneTap({ action: "end_break", break_type: null }, shift(), null, d)).toEqual({ kind: "refused", reason: "not_on_break" });
    expect(calls).toEqual([]);
  });
});
