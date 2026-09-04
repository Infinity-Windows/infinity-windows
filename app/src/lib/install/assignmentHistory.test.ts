import { describe, expect, it } from "vitest";
import {
  assignmentText,
  assignmentTimelineRows,
  type OpeningAssignmentEvent,
} from "./assignmentHistory";

const NAMES: Record<string, string> = { sam: "Sam", jed: "Jed", maria: "Maria" };
const nameOf = (id: string) => NAMES[id] ?? null;

function ev(over: Partial<OpeningAssignmentEvent> = {}): OpeningAssignmentEvent {
  return {
    id: "e1",
    opening_id: "o1",
    project_id: "p1",
    from_profile: null,
    to_profile: "sam",
    changed_by: "jed",
    changed_at: "2026-09-01T13:40:00Z",
    via: "dispatch",
    ...over,
  };
}

describe("assignmentText", () => {
  it("says who a unit was given to and who gave it", () => {
    expect(assignmentText(ev(), nameOf)).toBe("Assigned to Sam by Jed");
  });

  it("says both people when a unit moves from one list to another", () => {
    expect(
      assignmentText(ev({ from_profile: "sam", to_profile: "maria" }), nameOf),
    ).toBe("Moved from Sam to Maria by Jed");
  });

  it("says whose list a unit came off", () => {
    expect(
      assignmentText(ev({ from_profile: "sam", to_profile: null }), nameOf),
    ).toBe("Taken off Sam's list by Jed");
  });

  it("falls back to Crew for somebody the roster cannot name", () => {
    expect(assignmentText(ev({ to_profile: "left-in-2024" }), nameOf)).toBe(
      "Assigned to Crew by Jed",
    );
  });

  it("drops the 'by' half rather than inventing an actor", () => {
    // changed_by is auth.uid(), which is null for anything the server itself
    // did. "by nobody" would be a worse answer than saying nothing.
    expect(assignmentText(ev({ changed_by: null }), nameOf)).toBe("Assigned to Sam");
  });

  it("still says something when both ends are empty", () => {
    expect(
      assignmentText({ from_profile: null, to_profile: null, changed_by: "jed" }, nameOf),
    ).toBe("Assignment cleared by Jed");
  });
});

describe("assignmentTimelineRows", () => {
  it("carries the change time so the Record can merge and sort it", () => {
    const rows = assignmentTimelineRows(
      [ev(), ev({ id: "e2", from_profile: "sam", to_profile: null, changed_at: "2026-09-02T09:00:00Z" })],
      nameOf,
    );
    expect(rows).toEqual([
      { at: "2026-09-01T13:40:00Z", text: "Assigned to Sam by Jed", kind: "assign" },
      { at: "2026-09-02T09:00:00Z", text: "Taken off Sam's list by Jed", kind: "assign" },
    ]);
  });

  it("is empty for a unit nobody ever handed out", () => {
    expect(assignmentTimelineRows([], nameOf)).toEqual([]);
  });
});
