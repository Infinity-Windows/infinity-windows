import { describe, expect, it } from "vitest";
import {
  compareIssues,
  URGENCY_MARK,
  URGENCY_RANK,
  type Issue,
} from "./issues";

function makeIssue(partial: Partial<Issue>): Issue {
  return {
    id: partial.id ?? "id",
    project_id: partial.project_id ?? "proj",
    opening_id: partial.opening_id ?? null,
    kind: partial.kind ?? "flag",
    urgency: partial.urgency ?? "normal",
    status: partial.status ?? "open",
    note: partial.note ?? null,
    created_by: partial.created_by ?? null,
    created_at: partial.created_at ?? "2026-01-01T00:00:00.000Z",
    resolved_by: partial.resolved_by ?? null,
    resolved_at: partial.resolved_at ?? null,
  };
}

describe("compareIssues tier sort", () => {
  it("orders emergency before urgent before normal", () => {
    const emergency = makeIssue({ id: "e", urgency: "emergency" });
    const urgent = makeIssue({ id: "u", urgency: "urgent" });
    const normal = makeIssue({ id: "n", urgency: "normal" });
    const sorted = [normal, emergency, urgent].sort(compareIssues);
    expect(sorted.map((i) => i.id)).toEqual(["e", "u", "n"]);
  });

  it("sorts oldest-first (chronological) within the same tier", () => {
    const older = makeIssue({
      id: "older",
      urgency: "urgent",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = makeIssue({
      id: "newer",
      urgency: "urgent",
      created_at: "2026-02-01T00:00:00.000Z",
    });
    const sorted = [newer, older].sort(compareIssues);
    expect(sorted.map((i) => i.id)).toEqual(["older", "newer"]);
  });

  it("keeps tier precedence over recency (a new normal never beats an old emergency)", () => {
    const oldEmergency = makeIssue({
      id: "oldE",
      urgency: "emergency",
      created_at: "2020-01-01T00:00:00.000Z",
    });
    const newNormal = makeIssue({
      id: "newN",
      urgency: "normal",
      created_at: "2030-01-01T00:00:00.000Z",
    });
    expect([newNormal, oldEmergency].sort(compareIssues).map((i) => i.id)).toEqual([
      "oldE",
      "newN",
    ]);
  });

  it("ranks and marks each tier as expected", () => {
    expect(URGENCY_RANK.emergency).toBeGreaterThan(URGENCY_RANK.urgent);
    expect(URGENCY_RANK.urgent).toBeGreaterThan(URGENCY_RANK.normal);
    expect(URGENCY_MARK.emergency).toBe("!!!");
    expect(URGENCY_MARK.urgent).toBe("!");
    expect(URGENCY_MARK.normal).toBe("");
  });
});
