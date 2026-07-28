import { describe, expect, it } from "vitest";
import {
  compareMarks,
  computeSpecCoverage,
  describeSpecCoverage,
  expectedMarksFromOpeningCodes,
  hasDrawing,
  hasMeaningfulSpec,
  isSpecCoverageComplete,
  type CoverageSpec,
} from "./specCoverage";

// The real mark set on Smith / "PV Townhomes Bldg 14": 24 distinct marks across
// a 6-page manufacturer specs planset. This is ground truth for the report.
const SMITH_MARKS = [
  "1",
  "2",
  "3",
  "4A",
  "4B",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13A",
  "13B",
  "14",
  "15",
  "16",
  "17",
  "18A",
  "18B",
  "19",
  "20",
  "21",
];

/** A complete spec row for `mark`, with a plausible page-1 style box. */
function spec(mark: string, over: Partial<CoverageSpec> = {}): CoverageSpec {
  return {
    mark_code: mark,
    style: "Thermal Break Aluminum Fixed Window (Nail Fins)",
    glass: "5 (Low-E 366)+12A+5 (Low-E 366) Insulating tempered (argon)",
    color: "Black (Aluminum Profile Color)",
    size_code: "3060",
    width_in: 36,
    height_in: 72,
    operation: "Fixed",
    image_bbox: [0.217, 0.128, 0.3, 0.29],
    ...over,
  };
}

const fullSmithSpecs = SMITH_MARKS.map((m) => spec(m));

describe("expectedMarksFromOpeningCodes", () => {
  it("reduces real Smith opening codes to their base marks", () => {
    expect(
      expectedMarksFromOpeningCodes(["14-18", "13A-1", "1-2", "18B-3"]),
    ).toEqual(["1", "13A", "14", "18B"]);
  });

  it("dedupes the many openings that share one mark", () => {
    const openings = ["1-1", "1-2", "1-3", "#1-4", " 1-5 ", "4A-1", "4A-2"];
    expect(expectedMarksFromOpeningCodes(openings)).toEqual(["1", "4A"]);
  });

  it("folds case and the '#' prefix together", () => {
    expect(expectedMarksFromOpeningCodes(["13a-1", "#13A-2", "13A"])).toEqual([
      "13A",
    ]);
  });

  it("sorts marks the way a human reads the list, not lexically", () => {
    expect(
      expectedMarksFromOpeningCodes(["21", "2", "10", "13B", "13A", "1"]),
    ).toEqual(["1", "2", "10", "13A", "13B", "21"]);
  });

  it("drops empty, blank, null and undefined codes", () => {
    expect(expectedMarksFromOpeningCodes(["", "  ", null, undefined, "7"])).toEqual(
      ["7"],
    );
  });
});

describe("compareMarks", () => {
  it("puts 2 before 10 and 13A before 13B", () => {
    expect(compareMarks("2", "10")).toBeLessThan(0);
    expect(compareMarks("13A", "13B")).toBeLessThan(0);
    expect(compareMarks("18B", "18A")).toBeGreaterThan(0);
  });
});

describe("hasMeaningfulSpec", () => {
  it("accepts a row with any single usable field", () => {
    const empty: CoverageSpec = { mark_code: "7" };
    expect(hasMeaningfulSpec({ ...empty, style: "Fixed window" })).toBe(true);
    expect(hasMeaningfulSpec({ ...empty, size_code: "3060" })).toBe(true);
    expect(hasMeaningfulSpec({ ...empty, width_in: 36 })).toBe(true);
    expect(hasMeaningfulSpec({ ...empty, glass: "Low-E 366" })).toBe(true);
  });

  it("rejects a row that exists but holds nothing", () => {
    expect(hasMeaningfulSpec({ mark_code: "7" })).toBe(false);
    expect(
      hasMeaningfulSpec({
        mark_code: "7",
        style: null,
        glass: null,
        color: null,
        size_code: null,
        operation: null,
        width_in: null,
        height_in: null,
      }),
    ).toBe(false);
  });

  it("treats whitespace-only text as nothing", () => {
    expect(hasMeaningfulSpec({ mark_code: "7", style: "   " })).toBe(false);
  });

  it("does not count a drawing box as spec content", () => {
    expect(
      hasMeaningfulSpec({ mark_code: "7", image_bbox: [0.1, 0.1, 0.2, 0.2] }),
    ).toBe(false);
  });
});

describe("hasDrawing", () => {
  it("accepts a four-number box", () => {
    expect(hasDrawing({ mark_code: "1", image_bbox: [0.2, 0.1, 0.3, 0.29] })).toBe(
      true,
    );
  });

  it("rejects null, undefined and malformed boxes", () => {
    expect(hasDrawing({ mark_code: "1" })).toBe(false);
    expect(hasDrawing({ mark_code: "1", image_bbox: null })).toBe(false);
    expect(hasDrawing({ mark_code: "1", image_bbox: [0.2, 0.1, 0.3] })).toBe(false);
    expect(hasDrawing({ mark_code: "1", image_bbox: "0.2,0.1,0.3,0.29" })).toBe(
      false,
    );
  });
});

describe("computeSpecCoverage — the real Smith job", () => {
  it("reports a fully extracted 24-mark job as complete", () => {
    const coverage = computeSpecCoverage(SMITH_MARKS, fullSmithSpecs);
    expect(coverage.total).toBe(24);
    expect(coverage.ok).toHaveLength(24);
    expect(coverage.missingSpec).toEqual([]);
    expect(coverage.missingDrawing).toEqual([]);
    expect(coverage.unexpected).toEqual([]);
    expect(isSpecCoverageComplete(coverage)).toBe(true);
    expect(describeSpecCoverage(coverage)).toBe("24 of 24 marks complete");
  });

  it("catches the 18B case: spec text extracted, bounding box silently lost", () => {
    const specs = fullSmithSpecs.map((s) =>
      s.mark_code === "18B" ? { ...s, image_bbox: null } : s,
    );
    const coverage = computeSpecCoverage(SMITH_MARKS, specs);
    expect(coverage.missingDrawing).toEqual(["18B"]);
    expect(coverage.missingSpec).toEqual([]);
    expect(coverage.ok).toHaveLength(23);
    expect(isSpecCoverageComplete(coverage)).toBe(false);
    expect(describeSpecCoverage(coverage)).toBe(
      "23 of 24 marks complete · 1 missing drawing (18B)",
    );
  });

  it("reports the 22-of-24 shape: one lost drawing and one lost spec", () => {
    const specs = fullSmithSpecs
      .map((s) => (s.mark_code === "18B" ? { ...s, image_bbox: null } : s))
      .filter((s) => s.mark_code !== "7");
    const coverage = computeSpecCoverage(SMITH_MARKS, specs);
    expect(coverage.total).toBe(24);
    expect(coverage.ok).toHaveLength(22);
    expect(coverage.missingDrawing).toEqual(["18B"]);
    expect(coverage.missingSpec).toEqual(["7"]);
    expect(describeSpecCoverage(coverage)).toBe(
      "22 of 24 marks complete · 1 missing drawing (18B) · 1 missing spec (7)",
    );
  });

  it("counts a whole failed page of marks as missing specs", () => {
    // A page-5 failure on this planset costs marks 18A–21 entirely.
    const lost = new Set(["18A", "18B", "19", "20", "21"]);
    const specs = fullSmithSpecs.filter((s) => !lost.has(s.mark_code));
    const coverage = computeSpecCoverage(SMITH_MARKS, specs);
    expect(coverage.missingSpec).toEqual(["18A", "18B", "19", "20", "21"]);
    expect(coverage.ok).toHaveLength(19);
  });

  it("treats a row that exists with no usable field as a missing spec, not a gap-free mark", () => {
    const specs = fullSmithSpecs.map((s) =>
      s.mark_code === "12"
        ? {
            mark_code: "12",
            style: null,
            glass: null,
            color: null,
            size_code: null,
            operation: null,
            width_in: null,
            height_in: null,
            image_bbox: null,
          }
        : s,
    );
    const coverage = computeSpecCoverage(SMITH_MARKS, specs);
    expect(coverage.missingSpec).toEqual(["12"]);
    expect(coverage.missingDrawing).toEqual([]);
  });

  it("flags an extracted mark no opening asks for without counting it against coverage", () => {
    const coverage = computeSpecCoverage(SMITH_MARKS, [
      ...fullSmithSpecs,
      spec("22B"),
    ]);
    expect(coverage.total).toBe(24);
    expect(coverage.ok).toHaveLength(24);
    expect(coverage.unexpected).toEqual(["22B"]);
    expect(describeSpecCoverage(coverage)).toBe(
      "24 of 24 marks complete · 1 unexpected (22B)",
    );
  });

  it("sorts several unexpected marks numerically", () => {
    const coverage = computeSpecCoverage(["1"], [
      spec("1"),
      spec("30"),
      spec("4C"),
      spec("2"),
    ]);
    expect(coverage.unexpected).toEqual(["2", "4C", "30"]);
  });

  it("matches marks case-insensitively and through the '#' prefix", () => {
    const specs = [spec("18b"), spec("#4a"), spec(" 13A ")];
    const coverage = computeSpecCoverage(["18B", "4A", "13a"], specs);
    expect(coverage.ok).toEqual(["4A", "13A", "18B"]);
    expect(coverage.missingSpec).toEqual([]);
    expect(coverage.unexpected).toEqual([]);
  });

  it("resolves expected marks from raw opening codes", () => {
    const openings = ["14-1", "14-18", "13A-1", "13A-2", "18B-1"];
    const coverage = computeSpecCoverage(openings, [
      spec("14"),
      spec("13A"),
      spec("18B", { image_bbox: null }),
    ]);
    expect(coverage.total).toBe(3);
    expect(coverage.ok).toEqual(["13A", "14"]);
    expect(coverage.missingDrawing).toEqual(["18B"]);
  });

  it("collapses duplicate spec rows for one mark, keeping the best of them", () => {
    const thin: CoverageSpec = { mark_code: "6", image_bbox: null };
    const coverage = computeSpecCoverage(["6"], [thin, spec("6")]);
    expect(coverage.ok).toEqual(["6"]);
    expect(coverage.missingSpec).toEqual([]);
    expect(coverage.missingDrawing).toEqual([]);
  });

  it("reunites a mark whose text and drawing arrived on separate rows", () => {
    const textOnly = spec("9", { image_bbox: null });
    const boxOnly: CoverageSpec = {
      mark_code: "9",
      image_bbox: [0.6, 0.4, 0.7, 0.6],
    };
    const coverage = computeSpecCoverage(["9"], [textOnly, boxOnly]);
    expect(coverage.ok).toEqual(["9"]);
  });

  it("keeps the buckets disjoint so ok + missing always equals total", () => {
    const specs = fullSmithSpecs
      .map((s) => (s.mark_code === "18B" ? { ...s, image_bbox: null } : s))
      .filter((s) => s.mark_code !== "7" && s.mark_code !== "20");
    const coverage = computeSpecCoverage([...SMITH_MARKS, "7", "7"], [
      ...specs,
      spec("99"),
    ]);
    expect(
      coverage.ok.length + coverage.missingSpec.length + coverage.missingDrawing.length,
    ).toBe(coverage.total);
    expect(coverage.total).toBe(24);
  });
});

describe("computeSpecCoverage — empty and degenerate inputs", () => {
  it("returns an empty report when the job has no openings yet", () => {
    const coverage = computeSpecCoverage([], []);
    expect(coverage).toEqual({
      total: 0,
      ok: [],
      missingSpec: [],
      missingDrawing: [],
      unexpected: [],
    });
    expect(describeSpecCoverage(coverage)).toBeNull();
    expect(isSpecCoverageComplete(coverage)).toBe(false);
  });

  it("reports every expected mark as missing when extraction returned nothing", () => {
    const coverage = computeSpecCoverage(SMITH_MARKS, []);
    expect(coverage.total).toBe(24);
    expect(coverage.missingSpec).toEqual(coverage.missingSpec.slice().sort(compareMarks));
    expect(coverage.missingSpec).toHaveLength(24);
    expect(coverage.ok).toEqual([]);
    expect(describeSpecCoverage(coverage)).toContain("0 of 24 marks complete");
  });

  it("reports specs with no openings as all unexpected", () => {
    const coverage = computeSpecCoverage([], fullSmithSpecs);
    expect(coverage.total).toBe(0);
    expect(coverage.unexpected).toHaveLength(24);
    // No openings means nothing is expected, so there is still nothing to say.
    expect(describeSpecCoverage(coverage)).toBeNull();
  });

  it("ignores spec rows with no usable mark instead of throwing", () => {
    const coverage = computeSpecCoverage(["1"], [
      { mark_code: "" },
      { mark_code: "   " },
      spec("1"),
    ]);
    expect(coverage.ok).toEqual(["1"]);
    expect(coverage.unexpected).toEqual([]);
  });
});
