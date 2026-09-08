import { describe, expect, it } from "vitest";
import { planChanges } from "./changes";
import type { PlanDraft } from "./api";
const draft = () => ({ assignments: [{ id: "work", start_date: "2026-09-07", end_date: "2026-09-10", start_time: "07:00:00", note: null, members: [{ profile_id: "a", role: "installer" }, { profile_id: "b", role: "installer" }] }], trips: [{ trip: { id: "trip", name: "Rotation A", start_date: "2026-09-05", end_date: "2026-09-11" }, crew: [{ profile_id: "a", role: "crew" }] }], vehicles: [] } as unknown as PlanDraft);
describe("reviewed changes", () => {
  it("ignores storage identities, crew order and equivalent time formats", () => {
    const before = draft(); const after = draft(); after.assignments[0].start_time = "07:00"; after.assignments[0].members.reverse(); after.assignments[0].updated_at = "new database timestamp";
    expect(planChanges(before, after, id => id)).toEqual([]);
  });
  it("names removed crew and keeps travel and work date changes separate", () => {
    const before = draft(); const after = draft(); after.assignments[0].start_date = "2026-09-08"; after.trips[0].trip.start_date = "2026-09-06"; after.trips[0].crew = [];
    const changes = planChanges(before, after, () => "Fixture installer");
    expect(changes).toEqual([
      { section: "work", field: "workflow.start", before: "2026-09-07", after: "2026-09-08" },
      { section: "trip", field: "workflow.travelStart", before: "2026-09-05", after: "2026-09-06" },
      { section: "trip", field: "workflow.crew", before: "Fixture installer (crew)", after: "" },
    ]);
  });
});
