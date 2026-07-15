import { describe, expect, it } from "vitest";
import {
  formatAssignMeta,
  rankAssignCandidates,
  type AssignCandidate,
} from "./assignRank";

function unit(
  partial: Partial<AssignCandidate> & Pick<AssignCandidate, "id" | "window_id" | "status">,
): AssignCandidate {
  return {
    window_type_id: "type-a",
    project_id: null,
    locations: null,
    ...partial,
  };
}

describe("rankAssignCandidates", () => {
  it("prefers staged then loaded over warehouse stock", () => {
    const ranked = rankAssignCandidates([
      unit({ id: "1", window_id: "W-A-1", status: "in_warehouse" }),
      unit({ id: "2", window_id: "W-A-2", status: "loaded" }),
      unit({ id: "3", window_id: "W-A-3", status: "staged" }),
    ]);
    expect(ranked.map((u) => u.window_id)).toEqual(["W-A-3", "W-A-2", "W-A-1"]);
  });

  it("prefers same-project units, then filters by type", () => {
    const ranked = rankAssignCandidates(
      [
        unit({
          id: "1",
          window_id: "W-OTHER",
          status: "staged",
          window_type_id: "type-b",
          project_id: "job-1",
        }),
        unit({
          id: "2",
          window_id: "W-MATCH",
          status: "in_warehouse",
          window_type_id: "type-a",
          project_id: "job-1",
        }),
        unit({
          id: "3",
          window_id: "W-STAGED",
          status: "staged",
          window_type_id: "type-a",
          project_id: null,
        }),
      ],
      { preferredTypeId: "type-a", projectId: "job-1" },
    );
    expect(ranked.map((u) => u.window_id)).toEqual(["W-MATCH", "W-STAGED"]);
  });

  it("formats slot + status for the assign list", () => {
    expect(
      formatAssignMeta(
        unit({
          id: "1",
          window_id: "W-1",
          status: "staged",
          locations: { address: "J-SMITH-A" },
        }),
      ),
    ).toBe("J-SMITH-A · staged");
  });
});
