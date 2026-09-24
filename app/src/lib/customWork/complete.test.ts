// "Unit complete" is a stop marked finished followed by a unit save with the
// whole install marked Yes — never a start, which would reopen it (the bug of
// 2026-09-24: none of the crew's units had ever stayed complete).
import { describe, expect, it } from "vitest";
import { canEditUnit, finishedStop, isUnitComplete, markCompleteUnit } from "./complete";
import { previewCommands, type WorkSession, type WorkUnit } from "./model";

const unit: WorkUnit = {
  id: "u4", project_id: "job-1", opening_id: "op-9", created_by: "me", label: "4", type_label: "Bifold door",
  revision: 3, created_at: "2026-09-22T00:00:00Z", updated_at: "2026-09-22T00:00:00Z",
  facts: { width_in: 72, height_in: 96, story: "1", components: [{ label: "Door panel", quantity: 2 }] },
};
const session: WorkSession = {
  id: "s1", profile_id: "me", shift_id: "shift-1", project_id: "job-1", unit_id: "u4", kind: "unit",
  participation: "install", stage: "Installing", description: "Set the frame", outcome: null, delay_reason: "",
  started_at: "2026-09-24T14:00:00Z", ended_at: null, end_reason: null, revision: 1,
} as WorkSession;

describe("marking a unit complete", () => {
  it("stops the running session as finished, keeping the note", () => {
    expect(finishedStop(session, "2026-09-24T15:00:00Z", "", "")).toEqual({
      expected_session_id: "s1", at: "2026-09-24T15:00:00Z", outcome: "finished",
      finish_note: "Set the frame", delay_reason: "",
    });
    expect(finishedStop(session, "t", "Caulked and cleaned", "Late glass").finish_note).toBe("Caulked and cleaned");
  });

  it("saves the whole install as Yes without moving the job, map unit or other facts", () => {
    const save = markCompleteUnit(unit);
    expect(save).toMatchObject({
      id: "u4", revision: 3, project_id: "job-1", opening_id: "op-9", label: "4", type_label: "Bifold door", reason: "",
    });
    expect(save.facts).toEqual({ ...unit.facts, installation_complete: "Yes" });
  });

  it("stays complete after both commands — no start follows to reopen it", () => {
    const { units, sessions } = previewCommands([unit], [session], [
      { id: "c1", userId: "me", action: "stop", data: finishedStop(session, "2026-09-24T15:00:00Z", "", "") },
      { id: "c2", userId: "me", action: "unit", data: markCompleteUnit(unit) },
    ]);
    expect(isUnitComplete(units[0])).toBe(true);
    expect(sessions[0].ended_at).toBe("2026-09-24T15:00:00Z");
    expect(sessions[0].outcome).toBe("finished");
  });

  it("is reopened only by a deliberate new start (return visit)", () => {
    const done = { ...unit, facts: { ...unit.facts, installation_complete: "Yes" } };
    const { units } = previewCommands([done], [], [
      { id: "c3", userId: "me", action: "start", data: { id: "s2", shift_id: "shift-1", unit_id: "u4", at: "t" } },
    ]);
    expect(isUnitComplete(units[0])).toBe(false);
  });

  it("is offered to the unit's author and to foremen, as the server allows", () => {
    expect(canEditUnit(unit, "me", false)).toBe(true);
    expect(canEditUnit(unit, "someone-else", false)).toBe(false);
    expect(canEditUnit(unit, "someone-else", true)).toBe(true);
    expect(canEditUnit(unit, null, false)).toBe(false);
  });
});
