import { describe, expect, it } from "vitest";
import { askClockEntryMode, askClockHandoff, askClockLabel, askClockPick } from "./askClockHandoff";
import type { FieldReceipt } from "./fieldAsk";
import type { TimeShift } from "./timeclock";

const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const draft = { job: { project_id: JOB, name: "Black Desert", location: null }, unit: null };
const waiting = (reason: "wrong_job" | "needs_clock", project_id: string | undefined = JOB): FieldReceipt => ({
  action_id: "a", action: "start_unit", status: "needs_choice", reason, project_id,
});
const shift = (project_id = OTHER, break_started_at: string | null = null): TimeShift => ({
  id: "shift-1", profile_id: "me", project_id, cost_code_id: null,
  clock_in_at: new Date(Date.now() - 60_000).toISOString(), clock_out_at: null,
  break_seconds: 0, break_started_at, break_type: break_started_at ? "lunch" : null,
  injured: null, time_confirmed: null, status: "open", created_at: new Date().toISOString(),
  projects: null, cost_codes: null,
});

describe("Ask guided clock handoff", () => {
  it("uses the receipt job ID and matches display text only to that ID", () => {
    const handoff = askClockHandoff(waiting("wrong_job"), draft)!;
    expect(handoff).toEqual({ reason: "wrong_job", projectId: JOB, jobName: "Black Desert" });
    expect(askClockLabel(handoff, false)).toBe("Switch to Black Desert");
    expect(askClockLabel(handoff, true)).toBe("Cambiar a Black Desert");
    expect(askClockPick(handoff)).toEqual({ projectId: JOB, costCodeId: null, note: null, mode: null, returnToAsk: true });
    expect(askClockHandoff(waiting("wrong_job"), { job: { ...draft.job!, project_id: OTHER }, unit: null })?.jobName).toBeNull();
  });

  it("opens the normal clock for an invalid or absent target and ignores finished receipts", () => {
    expect(askClockHandoff(waiting("needs_clock", "not-a-job"), draft)).toEqual({ reason: "needs_clock", projectId: null, jobName: null });
    expect(askClockHandoff({ ...waiting("wrong_job"), status: "done" }, draft)).toBeNull();
  });

  it("opens on the switch confirmation only for a safe different-job handoff", () => {
    const pick = askClockPick(askClockHandoff(waiting("wrong_job"), draft)!);
    expect(askClockEntryMode(shift(), pick)).toBe("switch");
    expect(askClockEntryMode(shift(JOB), pick)).toBe("main");
    expect(askClockEntryMode(shift(JOB.toUpperCase()), pick)).toBe("main");
    expect(askClockEntryMode(shift(OTHER, new Date().toISOString()), pick)).toBe("main");
    expect(askClockEntryMode(null, pick)).toBe("pick");
    expect(askClockEntryMode(shift(), null)).toBe("main");
  });
});
