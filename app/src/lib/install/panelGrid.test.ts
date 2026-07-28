import { describe, expect, it } from "vitest";
import { overlapFraction, panelForBbox, type Bbox } from "./panelGrid";

// A 2x2 sheet, the layout the Black Desert specs planset uses.
const PANELS: Bbox[] = [
  [0.02, 0.05, 0.49, 0.5],
  [0.51, 0.05, 0.98, 0.5],
  [0.02, 0.52, 0.49, 0.97],
  [0.51, 0.52, 0.98, 0.97],
];

describe("overlapFraction", () => {
  it("is 1 for a box fully inside a panel", () => {
    expect(overlapFraction([0.1, 0.1, 0.2, 0.2], PANELS[0])).toBeCloseTo(1);
  });

  it("is 0 for a box outside every panel", () => {
    expect(overlapFraction([0.0, 0.0, 0.01, 0.01], PANELS[3])).toBe(0);
  });
});

describe("panelForBbox", () => {
  it("finds the panel a sliver of a box sits in", () => {
    // mark #2's stored box: a narrow sliver, top-right of the page.
    expect(panelForBbox([0.79, 0.19, 0.87, 0.36], PANELS)).toEqual(PANELS[1]);
  });

  it("returns null when nothing overlaps", () => {
    expect(panelForBbox([0.499, 0.0, 0.51, 0.04], PANELS)).toBeNull();
  });
});
