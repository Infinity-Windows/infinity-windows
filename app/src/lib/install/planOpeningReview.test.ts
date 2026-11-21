import { describe, expect, it } from "vitest";
import { compareCadQuantities } from "./planOpeningReview";

describe("compareCadQuantities", () => {
  const drafts = [
    { key: "a", quantity: 3 }, { key: "b", quantity: 2 }, { key: "c", quantity: null }, { key: "d", quantity: 1 },
  ];
  it("counts the openings matched to each shop drawing that states a quantity", () => {
    const rows = compareCadQuantities(["a", "a", "a", "b", "b", "b", "c", undefined], drafts);
    expect(rows.map(row => [row.draft.key, row.expected, row.found])).toEqual([["a", 3, 3], ["b", 2, 3], ["d", 1, 0]]);
  });
  it("makes no claim for a drawing without a quantity", () => {
    expect(compareCadQuantities(["c"], [{ key: "c", quantity: null }, { key: "e", quantity: 0 }])).toEqual([]);
  });
});
