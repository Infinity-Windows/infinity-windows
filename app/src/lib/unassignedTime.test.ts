import { describe, expect, it } from "vitest";
import { unassignedTimeEntries } from "./unassignedTime";
import type { TimeShift } from "./timeclock";
const entry = (id: string, patch: Partial<TimeShift> = {}) => ({ id, project_id: null, status: "submitted",
  created_at: "2026-09-16T12:00:00Z", clock_in_at: "2026-09-15T12:00:00Z", ...patch } as TimeShift);

describe("unassigned time review", () => {
  it("retains every unassigned status but excludes assigned and removed punches, even with missing joins", () => {
    const rows = [entry("approved", { status: "approved" }), entry("submitted"), entry("open", { status: "open" }),
      entry("rejected", { status: "rejected" }), entry("unfinished", { status: "needs_finish" }),
      entry("removed", { status: "voided" }), entry("assigned", { project_id: "job", projects: null })];
    expect(unassignedTimeEntries(rows).map(s => s.id).sort()).toEqual(["approved", "open", "rejected", "submitted", "unfinished"]);
    expect(rows).toHaveLength(7);
  });
  it("sorts by the original entry timestamp, not work day, recent edits, or approval", () => {
    const older = entry("older", { created_at: "2026-09-14T14:00:00Z", edited_at: "2026-09-17T12:00:00Z" });
    const late = entry("backdated", { clock_in_at: "2026-08-01T12:00:00Z" });
    expect(unassignedTimeEntries([late, older, older]).map(s => s.id)).toEqual(["older", "backdated"]);
  });
  it("orders timestamp offsets correctly and breaks ties consistently without mutating its input", () => {
    const a = entry("a", { created_at: "2026-09-16T06:30:00-06:00" });
    const b = entry("b", { created_at: "2026-09-16T12:00:00Z" });
    const c = entry("c", { created_at: "", clock_in_at: "2026-09-16T12:00:00Z" });
    const input = [a, c, b];
    expect(unassignedTimeEntries(input).map(s => s.id)).toEqual(["b", "c", "a"]);
    expect(input.map(s => s.id)).toEqual(["a", "c", "b"]);
  });
});
