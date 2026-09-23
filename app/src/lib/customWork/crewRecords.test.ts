import { describe, it, expect } from "vitest";
import { localWorkDate, previewCommands, unitSummary, type WorkUnit, type WorkSession } from "./model";
describe("foreman crew records", () => {
  it("previews a queued unit without creating a timer or measured labor", () => {
    const unit = { id: "unit", project_id: "job", label: "16", type_label: "Bifold", facts: { width_in: 72, height_in: 96 }, revision: 0 };
    const view = previewCommands([], [], [{ id: "record", userId: "foreman", action: "crew_record", data: { unit, people: ["worker", "helper"], work_date: "2026-09-18", stage: "Installing", outcome: "finished" } }]);
    expect(view.units).toHaveLength(1);
    expect(view.units[0].created_by).toBe("foreman");
    expect(view.units[0].revision).toBe(1);
    expect(view.sessions).toEqual([]);
    expect(unitSummary(view.units[0], [])).toMatchObject({labor: 0, ready: false, finished: false});
  });
  it("keeps an existing unit identity without creating a session", () => {
    const unit = { id: "unit", project_id: "job", label: "16", facts: {}, revision: 1 } as WorkUnit;
    const view = previewCommands([unit], [], [{id: "r", userId: "lead", action: "crew_record", data:{unit:{...unit,revision:1},people:["other"]}}]);
    expect(view.units).toHaveLength(1);
    expect(view.units[0].revision).toBe(2);
    expect(view.sessions).toEqual([]);
  });
  it("excludes completed units with untimed crew work from pricing samples", () => {
    const unit = {id:"u",project_id:"job",type_label:"Bifold",facts:{width_in:72,height_in:96,installation_complete:"Yes"},untimed_work_present:true} as WorkUnit;
    const timedVisit = { unit_id: "u", profile_id: "installer", started_at: "2026-09-18T12:00:00Z", ended_at: "2026-09-18T13:00:00Z", shift_status: "approved" } as WorkSession;
    expect(unitSummary({...unit, untimed_work_present: false}, [timedVisit]).ready).toBe(true);
    expect(unitSummary(unit, [timedVisit]).ready).toBe(false);
  });
  it("uses the selected local calendar day rather than slicing UTC", () => {
    const d = new Date(2026, 8, 18, 23, 59);
    expect(localWorkDate(d)).toBe("2026-09-18");
  });
});
