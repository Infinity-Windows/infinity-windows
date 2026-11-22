import { describe, expect, it } from "vitest";
import { assignedDayTasks, assignmentUnit, nativeStartPayload, resolveWalkthroughProject } from "./nativeDay";
import type { CrewWorkRecord, WorkUnit, WorkSession } from "../customWork/model";
import type { ProjectOpening } from "../install/types";
const opening = { id: "opening", project_id: "zztest", opening_code: "12", window_types: { name: "Catalog configuration", width_in: 40, height_in: 60 } } as ProjectOpening;
const unit = { id: "unit", project_id: "zztest", opening_id: "opening", facts: {}, revision: 2 } as WorkUnit;
const record = { id: "assignment", project_id: "zztest", unit_id: "unit", stage: "Flashing", outcome: "assigned", work_date: "2026-11-03", people: [{ profile_id: "alex" }] } as CrewWorkRecord;
describe("native installer day", () => {
  it("resolves mixed-case project codes and named projects without coercing empty results", () => {
    const named = { id: "named", job_code: "AUTO123", name: "zztest" };
    const coded = { id: "coded", job_code: "zztest", name: "Test job" };
    expect(resolveWalkthroughProject([named, coded])).toBe(coded);
    expect(resolveWalkthroughProject([named])).toBe(named);
    expect(resolveWalkthroughProject([{ ...coded, job_code: "ZzTeSt" }]).id).toBe("coded");
    expect(() => resolveWalkthroughProject([])).toThrow("No accessible zztest project");
    expect(() => resolveWalkthroughProject([coded, { ...coded, id: "other" }])).toThrow("More than one zztest project");
  });
  it("resolves assigned person/date/unit/stage and collapses duplicate suggestions", () => {
    const tasks = assignedDayTasks([record, { ...record, id: "duplicate" }, { ...record, stage: "Hardware" }, { ...record, outcome: "finished" }], [unit], [opening], "alex", "2026-11-03");
    expect(tasks).toHaveLength(2); expect(tasks[0].opening?.id).toBe("opening"); expect(tasks[0].assignmentIds).toEqual(["assignment", "duplicate"]);
    expect(assignedDayTasks([{ ...record, people: [{ profile_id: "alex", voided_at: "yesterday" }] }], [unit], [opening], "alex", "2026-11-03")).toEqual([]);
    expect(assignedDayTasks([record], [unit], [opening], "sam", "2026-11-03")).toEqual([]);
    expect(assignedDayTasks([record], [unit], [opening], "alex", "2026-11-04")).toEqual([]);
  });
  it("does not silently remap stale openings or units from another project", () => {
    expect(assignedDayTasks([record], [unit], [], "alex", "2026-11-03")).toEqual([]);
    expect(assignedDayTasks([record], [{ ...unit, project_id: "real-job" }], [opening], "alex", "2026-11-03")).toEqual([]);
  });
  it("reuses linked units and never copies catalog dimensions into field measurements", () => {
    expect(assignmentUnit(opening, [unit], "new").id).toBe("unit");
    const draft = assignmentUnit(opening, [], "new");
    expect(draft.opening_id).toBe("opening"); expect(draft.facts).toEqual({}); expect(draft.label).toBe("12");
  });
  it("switches through the existing expected session for both general and unit work", () => {
    const active = { id: "running", profile_id: "alex", project_id: "zztest" } as WorkSession;
    const args = { projectId: "zztest", shiftId: "shift", actorId: "alex", active, id: "next", at: "2026-11-03T17:00:00Z" };
    expect(nativeStartPayload({ ...args, general: "Hauling" })).toMatchObject({ expected_session_id: "running", unit_id: null, stage: "Idle time", description: "Hauling" });
    const task = assignedDayTasks([record], [unit], [opening], "alex", "2026-11-03")[0];
    expect(nativeStartPayload({ ...args, task })).toMatchObject({ unit_id: "unit", stage: "Flashing", expected_session_id: "running", shift_id: "shift" });
    expect(() => nativeStartPayload({ ...args, general: "Setup", active: { ...active, project_id: "real-job" } })).toThrow();
    expect(() => nativeStartPayload({ ...args, task: { ...task, unit: { ...unit, project_id: "real-job" } } })).toThrow();
  });
});
