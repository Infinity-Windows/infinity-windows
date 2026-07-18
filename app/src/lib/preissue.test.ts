import { describe, expect, it } from "vitest";
import {
  computePreissuePlan,
  totalExisting,
  totalPlanned,
  totalToIssue,
  unitsToIssueForType,
} from "./preissue";

describe("unitsToIssueForType", () => {
  it("issues the shortfall when fewer units exist than planned", () => {
    expect(unitsToIssueForType(5, 2)).toBe(3);
  });

  it("issues everything when none exist yet", () => {
    expect(unitsToIssueForType(4, 0)).toBe(4);
  });

  it("issues nothing when the plan is already fully met (idempotent)", () => {
    expect(unitsToIssueForType(3, 3)).toBe(0);
  });

  it("never goes negative when more units exist than planned", () => {
    expect(unitsToIssueForType(2, 5)).toBe(0);
  });
});

describe("computePreissuePlan", () => {
  const needs = [
    { window_type_id: "cas", quantity: 3 },
    { window_type_id: "dh", quantity: 2 },
    { window_type_id: "pic", quantity: 1 },
  ];

  it("counts existing units per type and computes the shortfall", () => {
    const units = [
      { window_type_id: "cas" },
      { window_type_id: "cas" },
      { window_type_id: "pic" },
    ];
    const plan = computePreissuePlan(needs, units);

    expect(plan).toEqual([
      { window_type_id: "cas", planned: 3, existing: 2, toIssue: 1 },
      { window_type_id: "dh", planned: 2, existing: 0, toIssue: 2 },
      { window_type_id: "pic", planned: 1, existing: 1, toIssue: 0 },
    ]);
  });

  it("is idempotent: a second run after issuing creates nothing new", () => {
    const first = computePreissuePlan(needs, []);
    expect(totalToIssue(first)).toBe(6);

    // Simulate the units created by the first run now existing.
    const afterFirst = [
      ...Array(3).fill({ window_type_id: "cas" }),
      ...Array(2).fill({ window_type_id: "dh" }),
      ...Array(1).fill({ window_type_id: "pic" }),
    ];
    const second = computePreissuePlan(needs, afterFirst);
    expect(totalToIssue(second)).toBe(0);
  });

  it("returns an empty plan and zero totals for a project with no planned needs", () => {
    const plan = computePreissuePlan([], [{ window_type_id: "cas" }]);
    expect(plan).toEqual([]);
    expect(totalToIssue(plan)).toBe(0);
  });

  it("rolls up planned, existing, and to-issue totals", () => {
    const units = [{ window_type_id: "cas" }, { window_type_id: "dh" }];
    const plan = computePreissuePlan(needs, units);
    expect(totalPlanned(plan)).toBe(6);
    expect(totalExisting(plan)).toBe(2);
    expect(totalToIssue(plan)).toBe(4);
  });
});
