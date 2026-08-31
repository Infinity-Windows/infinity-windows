import { describe, expect, it } from "vitest";
import {
  confirmAllSummary,
  filterUnconfirmed,
  normalizedToPixel,
  pixelToNormalized,
  placementResultSummary,
  resolvePlacements,
  type RawPlacementRow,
  type UnplacedMark,
} from "./placementSuggestions";

describe("resolvePlacements", () => {
  const unplaced: UnplacedMark[] = [
    { id: "op-1", code: "12" },
    { id: "op-2", code: "13-1" },
    { id: "op-3", code: "13-2" },
  ];

  it("resolves a raw placement to the matching opening by normalized mark code", () => {
    const raw: RawPlacementRow[] = [
      { mark: "12", x: 0.4, y: 0.5, page: 2, confidence: 0.9 },
    ];
    const { suggestions, notFoundMarks } = resolvePlacements(unplaced, raw);
    expect(suggestions).toEqual([
      { openingId: "op-1", markCode: "12", x: 0.4, y: 0.5, page: 2, confidence: 0.9 },
    ]);
    expect(notFoundMarks.sort()).toEqual(["13-1", "13-2"]);
  });

  it("matches survey-format suffixes against the dashed extraction spelling", () => {
    // adapter.ts's normalizeMarkCode equates "13A" with "13-1" — the same
    // physical opening, two label dialects.
    const raw: RawPlacementRow[] = [
      { mark: "13A", x: 0.1, y: 0.2, page: 1, confidence: 0.7 },
    ];
    const { suggestions, notFoundMarks } = resolvePlacements(unplaced, raw);
    expect(suggestions).toEqual([
      { openingId: "op-2", markCode: "13-1", x: 0.1, y: 0.2, page: 1, confidence: 0.7 },
    ]);
    expect(notFoundMarks.sort()).toEqual(["12", "13-2"]);
  });

  it("never invents an opening for a mark that isn't in the known list (CAD-WINS)", () => {
    const raw: RawPlacementRow[] = [
      { mark: "99", x: 0.3, y: 0.3, page: 1, confidence: 0.6 },
    ];
    const { suggestions, notFoundMarks } = resolvePlacements(unplaced, raw);
    expect(suggestions).toEqual([]);
    expect(notFoundMarks).toHaveLength(3);
  });

  it("reports every known mark as not-found when nothing came back", () => {
    const { suggestions, notFoundMarks } = resolvePlacements(unplaced, []);
    expect(suggestions).toEqual([]);
    expect(notFoundMarks.sort()).toEqual(["12", "13-1", "13-2"]);
  });

  it("is a no-op with nothing unplaced", () => {
    expect(resolvePlacements([], [{ mark: "1", x: 0, y: 0, page: 1, confidence: 1 }])).toEqual({
      suggestions: [],
      notFoundMarks: [],
    });
  });
});

describe("filterUnconfirmed — the rescan law, client-side mirror", () => {
  it("drops a suggestion for an opening that already has a real pin", () => {
    const pinned = new Set(["op-1"]);
    const suggestions = [
      { openingId: "op-1", markCode: "1" },
      { openingId: "op-2", markCode: "2" },
    ];
    expect(filterUnconfirmed(pinned, suggestions)).toEqual([
      { openingId: "op-2", markCode: "2" },
    ]);
  });

  it("keeps everything when nothing is pinned yet", () => {
    const suggestions = [{ openingId: "op-1", markCode: "1" }];
    expect(filterUnconfirmed(new Set(), suggestions)).toEqual(suggestions);
  });

  it("drops everything when every mark is already pinned", () => {
    const pinned = new Set(["op-1", "op-2"]);
    const suggestions = [
      { openingId: "op-1", markCode: "1" },
      { openingId: "op-2", markCode: "2" },
    ];
    expect(filterUnconfirmed(pinned, suggestions)).toEqual([]);
  });
});

describe("normalizedToPixel / pixelToNormalized — the round trip a drag-confirm needs", () => {
  it("converts a normalized pin to plan-image pixels", () => {
    expect(normalizedToPixel({ x: 0.25, y: 0.5 }, 2000, 1000)).toEqual({
      x: 500,
      y: 500,
    });
  });

  it("converts a dragged pixel spot back to a normalized pin", () => {
    expect(pixelToNormalized({ x: 500, y: 500 }, 2000, 1000)).toEqual({
      x: 0.25,
      y: 0.5,
    });
  });

  it("round-trips within rounding tolerance", () => {
    const norm = { x: 0.3333, y: 0.6667 };
    const px = normalizedToPixel(norm, 1600, 1200);
    const back = pixelToNormalized(px, 1600, 1200);
    expect(back.x).toBeCloseTo(norm.x, 2);
    expect(back.y).toBeCloseTo(norm.y, 2);
  });

  it("clamps a drag that lands outside the rendered image", () => {
    expect(pixelToNormalized({ x: -50, y: 5000 }, 1000, 1000)).toEqual({
      x: 0,
      y: 1,
    });
  });

  it("never divides by zero when the image has no measured size yet", () => {
    expect(pixelToNormalized({ x: 10, y: 10 }, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("placementResultSummary — the plain result line", () => {
  it("matches the spec's exact example", () => {
    expect(
      placementResultSummary({ placed: 34, totalKnown: 40, notFound: 6, unknown: 1 }),
    ).toBe("Placed 34 of 40 marks — 6 not found; 1 callout on the plan isn't in the schedule");
  });

  it("pluralizes multiple unmatched callouts", () => {
    expect(
      placementResultSummary({ placed: 10, totalKnown: 10, notFound: 0, unknown: 3 }),
    ).toBe("Placed 10 of 10 marks — 3 callouts on the plan aren't in the schedule");
  });

  it("reads as a clean sentence when everything was found and nothing unknown", () => {
    expect(
      placementResultSummary({ placed: 12, totalKnown: 12, notFound: 0, unknown: 0 }),
    ).toBe("Placed 12 of 12 marks.");
  });

  it("reports not-found alone when there are no unknown callouts", () => {
    expect(
      placementResultSummary({ placed: 8, totalKnown: 10, notFound: 2, unknown: 0 }),
    ).toBe("Placed 8 of 10 marks — 2 not found");
  });
});

describe("confirmAllSummary", () => {
  it("singularizes one", () => {
    expect(confirmAllSummary(1)).toBe("1 placement confirmed");
  });

  it("pluralizes more than one", () => {
    expect(confirmAllSummary(34)).toBe("34 placements confirmed");
  });

  it("still reads sensibly at zero", () => {
    expect(confirmAllSummary(0)).toBe("0 placements confirmed");
  });
});
