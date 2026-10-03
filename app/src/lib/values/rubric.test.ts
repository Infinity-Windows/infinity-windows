import { describe, expect, it } from "vitest";
import fixture from "./rubric.fixture.json";
import { VALUE_RUBRICS, VALUE_SLUGS, anchorBandFor, rubricBySlug } from "./rubric";

/**
 * SOURCE-FIXTURE COMPARISON (brief: "English canonical text gets
 * source-fixture comparison"). `rubric.fixture.json` is an independently
 * captured copy of the same pinned Horizon text; if `rubric.ts` ever drifts
 * from it — a typo fixed in one file and not the other, a well-meaning
 * rewrite — this fails instead of silently shipping a rubric nobody approved.
 */
describe("the English rubric matches its pinned-source fixture exactly", () => {
  const fixtureValues = fixture.values as Record<
    string,
    { title: string; definition: string; briefing: string; criteria: string[]; anchors: { low: string; mid: string; high: string } }
  >;

  it("has the fixture's eight slugs, in the fixture's order", () => {
    expect(VALUE_SLUGS).toEqual(Object.keys(fixtureValues));
  });

  for (const slug of VALUE_SLUGS) {
    it(`${slug}: title, definition, briefing, criteria and anchors match byte-for-byte`, () => {
      const rubric = VALUE_RUBRICS[slug];
      const expected = fixtureValues[slug]!;
      expect(rubric.title).toBe(expected.title);
      expect(rubric.definition).toBe(expected.definition);
      expect(rubric.briefing).toBe(expected.briefing);
      expect([...rubric.criteria]).toEqual(expected.criteria);
      expect(rubric.anchors).toEqual(expected.anchors);
    });
  }
});

describe("VALUE_SLUGS", () => {
  it("has exactly eight entries, the set the database CHECK constraint pins", () => {
    expect(VALUE_SLUGS).toHaveLength(8);
    expect(new Set(VALUE_SLUGS).size).toBe(8);
  });

  it("is the canonical order every surface (ticker, sheet, rundown) agrees on", () => {
    expect(VALUE_SLUGS).toEqual([
      "fullsend", "ownership", "integrity", "sincerity", "tribe", "growth", "strategic", "safety",
    ]);
  });
});

describe("rubricBySlug", () => {
  it("finds every known slug and nothing unknown", () => {
    for (const slug of VALUE_SLUGS) expect(rubricBySlug(slug)?.slug).toBe(slug);
    expect(rubricBySlug("not-a-value")).toBeUndefined();
  });
});

describe("anchorBandFor", () => {
  it("is 1–3 low, 4–6 mid, 7–10 high — the exact pinned-source bands", () => {
    expect([1, 2, 3].map(anchorBandFor)).toEqual(["low", "low", "low"]);
    expect([4, 5, 6].map(anchorBandFor)).toEqual(["mid", "mid", "mid"]);
    expect([7, 8, 9, 10].map(anchorBandFor)).toEqual(["high", "high", "high", "high"]);
  });
});
