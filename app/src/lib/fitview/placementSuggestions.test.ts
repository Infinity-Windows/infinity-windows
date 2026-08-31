import { describe, expect, it } from "vitest";
import {
  confirmAllSummary,
  filterUnconfirmed,
  normalizedToPixel,
  pixelToNormalized,
  placementResultSummary,
  placementToastKind,
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
  // THE BUG (Mad Moose, wave V-A): apply_placement_suggestions can legitimately
  // write fewer rows than extract-placement found — the rescan law skips any
  // mark that already has a real pin, and a database that hasn't caught up to
  // this migration yet degrades applyPlacementSuggestions to a silent 0. The
  // old wording ("Placed N of M marks") had only one count in it, so a caller
  // that (by accident or by a stale deploy) fed it the VISION count instead of
  // the RPC's own applied-row count could read as full success while writing
  // nothing. `suggested` and `saved` are now two separate numbers so that
  // can't happen by construction — there is no single "placed" left to lie.
  it("full success: everything the plan named got saved", () => {
    expect(
      placementResultSummary({ suggested: 10, saved: 10, notFound: 0, unknown: 0 }),
    ).toBe("Suggested 10 — 10 saved.");
  });

  it("attributes a partial save to the rescan law, not to the vision read", () => {
    expect(
      placementResultSummary({ suggested: 10, saved: 7, notFound: 0, unknown: 0 }),
    ).toBe("Suggested 10 — only 7 saved — 3 already have real pins.");
  });

  // The exact Mad Moose numbers: vision matched all 10 known marks, but the
  // write saved none of them. The old single-number wording had no way to
  // say this — "Placed 10 of 10" and "found 10, saved 0" look identical once
  // collapsed into one count. This must never render as a clean success line.
  it("a total write failure reads as a failure, not as 10-for-10 success", () => {
    expect(
      placementResultSummary({ suggested: 10, saved: 0, notFound: 0, unknown: 3 }),
    ).toBe(
      "Suggested 10 — only 0 saved — 10 already have real pins — 3 callouts on the plan aren't in the schedule",
    );
  });

  it("pluralizes multiple unmatched callouts", () => {
    expect(
      placementResultSummary({ suggested: 10, saved: 10, notFound: 0, unknown: 3 }),
    ).toBe("Suggested 10 — 10 saved — 3 callouts on the plan aren't in the schedule");
  });

  it("reports not-found alongside a partial save", () => {
    expect(
      placementResultSummary({ suggested: 8, saved: 8, notFound: 2, unknown: 0 }),
    ).toBe("Suggested 8 — 8 saved — 2 not found");
  });

  it("reports the singular callout without an 's'", () => {
    expect(
      placementResultSummary({ suggested: 5, saved: 5, notFound: 0, unknown: 1 }),
    ).toBe("Suggested 5 — 5 saved — 1 callout on the plan isn't in the schedule");
  });

  // The ACTUAL Mad Moose mechanism: isMissingPlacementFunction's degrade-
  // instead-of-crash guard (install/api.ts) forces saved to 0 whenever
  // PostgREST answers apply_placement_suggestions as PGRST202 "not in the
  // schema cache" — which it does for a genuinely-missing migration AND,
  // just as easily, for a migration that landed in Postgres moments ago but
  // whose schema-reload notification hasn't reached PostgREST yet (this
  // project's own deploy history: "Deploy backend" has silently failed
  // before). Both look identical to the RPC call: no error is thrown, saved
  // is just 0. Without `unavailable`, that 0 would be blamed on the rescan
  // law ("10 already have real pins") — false, and actively misleading: it
  // tells a foreman the marks are handled when they still need saving, the
  // opposite of what to do next.
  it("blames the write path, not existing pins, when the RPC isn't live on this database yet", () => {
    expect(
      placementResultSummary({
        suggested: 10,
        saved: 0,
        notFound: 0,
        unknown: 3,
        unavailable: true,
      }),
    ).toBe(
      "Suggested 10 — 0 saved — placements aren't set up on this database yet — 3 callouts on the plan aren't in the schedule",
    );
  });
});

describe("placementToastKind — a zero-write must never read as success", () => {
  it("is success when everything suggested was saved", () => {
    expect(placementToastKind({ suggested: 10, saved: 10 })).toBe("success");
  });

  it("is still success on a partial save — some marks already had a real pin", () => {
    expect(placementToastKind({ suggested: 10, saved: 7 })).toBe("success");
  });

  it("is success when there was never anything to save", () => {
    expect(placementToastKind({ suggested: 0, saved: 0 })).toBe("success");
  });

  // THE BUG, reproduced directly: 10 marks were found and none were saved —
  // apply_placement_suggestions wrote nothing (missing migration, or every
  // row lost a race). MapsTrace.tsx used to call toastSuccess() unconditionally
  // here, so this exact shape painted a failed write green.
  it("is error when marks were found but the write saved none of them", () => {
    expect(placementToastKind({ suggested: 10, saved: 0 })).toBe("error");
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
