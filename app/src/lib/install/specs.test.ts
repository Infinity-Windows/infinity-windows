import { describe, expect, it } from "vitest";
import {
  decodeSizeCode,
  findSizeCode,
  formatFeetInches,
  formatInches,
  formatSize,
  hasAnySpec,
  mergeSpecsByMark,
  normalizeSpec,
} from "./specs";

describe("decodeSizeCode", () => {
  it("decodes 3060 → 3'0\" × 6'0\" = 36\" × 72\"", () => {
    expect(decodeSizeCode("3060")).toEqual({ widthIn: 36, heightIn: 72 });
  });

  it("decodes 2846 → 2'8\" × 4'6\" = 32\" × 54\"", () => {
    expect(decodeSizeCode("2846")).toEqual({ widthIn: 32, heightIn: 54 });
  });

  it("decodes 6080 → 6'0\" × 8'0\" = 72\" × 96\"", () => {
    expect(decodeSizeCode("6080")).toEqual({ widthIn: 72, heightIn: 96 });
  });

  it("trims surrounding whitespace", () => {
    expect(decodeSizeCode("  3060  ")).toEqual({ widthIn: 36, heightIn: 72 });
  });

  it("returns null for non-4-digit codes", () => {
    expect(decodeSizeCode("306")).toBeNull();
    expect(decodeSizeCode("30600")).toBeNull();
    expect(decodeSizeCode("30")).toBeNull();
  });

  it("returns null for non-numeric / dimension-style codes", () => {
    expect(decodeSizeCode("30x60")).toBeNull();
    expect(decodeSizeCode("3'0x6'0")).toBeNull();
    expect(decodeSizeCode("CAS3")).toBeNull();
    expect(decodeSizeCode("")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(decodeSizeCode(null)).toBeNull();
    expect(decodeSizeCode(undefined)).toBeNull();
  });
});

describe("formatFeetInches", () => {
  it("formats total inches as feet-inches", () => {
    expect(formatFeetInches(36)).toBe("3'0\"");
    expect(formatFeetInches(72)).toBe("6'0\"");
    expect(formatFeetInches(32)).toBe("2'8\"");
    expect(formatFeetInches(54)).toBe("4'6\"");
    expect(formatFeetInches(0)).toBe("0'0\"");
  });

  it("returns null for invalid values", () => {
    expect(formatFeetInches(null)).toBeNull();
    expect(formatFeetInches(undefined)).toBeNull();
    expect(formatFeetInches(-5)).toBeNull();
  });

  // Black Desert's shop drawings print genuine half inches. Rounding one away
  // used to give a crew a dimension that was half an inch wrong.
  it("keeps a half inch instead of rounding it away", () => {
    expect(formatFeetInches(35.5)).toBe("2'11½\"");
    expect(formatFeetInches(59.5)).toBe("4'11½\"");
    expect(formatFeetInches(71.5)).toBe("5'11½\"");
    expect(formatFeetInches(89.5)).toBe("7'5½\"");
    expect(formatFeetInches(119.5)).toBe("9'11½\"");
    expect(formatFeetInches(137.5)).toBe("11'5½\"");
    expect(formatFeetInches(143.5)).toBe("11'11½\"");
    expect(formatFeetInches(179.5)).toBe("14'11½\"");
  });

  it("shows the other tape-measure fractions", () => {
    expect(formatFeetInches(36.125)).toBe("3'0⅛\"");
    expect(formatFeetInches(36.25)).toBe("3'0¼\"");
    expect(formatFeetInches(36.375)).toBe("3'0⅜\"");
    expect(formatFeetInches(36.625)).toBe("3'0⅝\"");
    expect(formatFeetInches(36.75)).toBe("3'0¾\"");
    expect(formatFeetInches(36.875)).toBe("3'0⅞\"");
  });

  it("rounds a millimetre conversion to the nearest eighth, never a decimal", () => {
    // 901mm → 35.47", which is the sheet's own 35 1/2" the long way round.
    expect(formatFeetInches(35.47)).toBe("2'11½\"");
    // A hair under the next whole inch rolls the feet over cleanly.
    expect(formatFeetInches(35.97)).toBe("3'0\"");
  });
});

describe("formatInches", () => {
  it("leaves a whole inch clean — never 36.0\"", () => {
    expect(formatInches(36)).toBe('36"');
    expect(formatInches(72)).toBe('72"');
    expect(formatInches(0)).toBe('0"');
  });

  it("reads a fractional inch off a tape", () => {
    expect(formatInches(35.5)).toBe('35½"');
    expect(formatInches(59.5)).toBe('59½"');
    expect(formatInches(71.5)).toBe('71½"');
    expect(formatInches(89.5)).toBe('89½"');
    expect(formatInches(119.5)).toBe('119½"');
    expect(formatInches(137.5)).toBe('137½"');
    expect(formatInches(143.5)).toBe('143½"');
    expect(formatInches(179.5)).toBe('179½"');
    expect(formatInches(35.375)).toBe('35⅜"');
  });

  it("never prints a long decimal", () => {
    expect(formatInches(35.47244094488189)).toBe('35½"');
    expect(formatInches(71.49606299212599)).toBe('71½"');
  });

  it("returns null for invalid values", () => {
    expect(formatInches(null)).toBeNull();
    expect(formatInches(undefined)).toBeNull();
    expect(formatInches(-1)).toBeNull();
    expect(formatInches(Number.NaN)).toBeNull();
  });
});

describe("formatSize", () => {
  it("shows both feet-inches and total inches", () => {
    expect(
      formatSize({ width_in: 36, height_in: 72, size_code: "3060" }),
    ).toBe("3'0\" × 6'0\" (36\" × 72\")");
  });

  it("falls back to the raw size code when dims are missing", () => {
    expect(
      formatSize({ width_in: null, height_in: null, size_code: "ODD1" }),
    ).toBe("ODD1");
  });

  it("returns null when there's nothing to show", () => {
    expect(
      formatSize({ width_in: null, height_in: null, size_code: null }),
    ).toBeNull();
  });

  // Smith Residence's whole-inch behaviour is PINNED: 3060 must keep reading
  // exactly as it does on the crew's sheets today.
  it("keeps Smith's 3060 exactly as it reads today", () => {
    expect(
      formatSize({ width_in: 36, height_in: 72, size_code: "3060" }),
    ).toBe("3'0\" × 6'0\" (36\" × 72\")");
    expect(
      formatSize({ width_in: 32, height_in: 54, size_code: "2846" }),
    ).toBe("2'8\" × 4'6\" (32\" × 54\")");
  });

  it("shows Black Desert's half inches in both forms", () => {
    expect(
      formatSize({ width_in: 89.5, height_in: 119.5, size_code: null }),
    ).toBe("7'5½\" × 9'11½\" (89½\" × 119½\")");
    expect(
      formatSize({ width_in: 35.5, height_in: 71.5, size_code: null }),
    ).toBe("2'11½\" × 5'11½\" (35½\" × 71½\")");
    expect(
      formatSize({ width_in: 143.5, height_in: 179.5, size_code: null }),
    ).toBe("11'11½\" × 14'11½\" (143½\" × 179½\")");
  });

  it("never rounds a half inch up to the next whole inch", () => {
    const shown = formatSize({
      width_in: 35.5,
      height_in: 71.5,
      size_code: null,
    });
    expect(shown).not.toContain('36"');
    expect(shown).not.toContain('72"');
    expect(shown).not.toContain(".");
  });
});

describe("findSizeCode", () => {
  it("pulls a 4-digit code out of free text", () => {
    expect(findSizeCode("Fixed 3060 XO")).toBe("3060");
    expect(findSizeCode("3060")).toBe("3060");
  });
  it("returns null when no 4-digit run exists", () => {
    expect(findSizeCode("Casement")).toBeNull();
    expect(findSizeCode(null)).toBeNull();
  });
});

describe("normalizeSpec", () => {
  it("normalizes a rich AI object and derives dims from the size code", () => {
    const spec = normalizeSpec({
      mark: "#1",
      style: "Thermal Break Aluminum Fixed Window (Nail Fins)",
      glass: "5 (Low-E 366)+12A+5 (Low-E 366) Insulating tempered Low-E glass",
      color: "Black (Aluminum Profile Color)",
      size_code: "3060",
      operation: "Fixed",
      tempered: "yes",
      egress: false,
      u_factor: "0.28",
      shgc: 0.24,
      grids: null,
      screen: "Half screen",
      manufacturer: "Andersen 100",
      extra: { hardware: "white lock" },
    });
    expect(spec).not.toBeNull();
    expect(spec!.mark_code).toBe("1");
    expect(spec!.width_in).toBe(36);
    expect(spec!.height_in).toBe(72);
    expect(spec!.tempered).toBe(true);
    expect(spec!.egress).toBe(false);
    expect(spec!.u_factor).toBe(0.28);
    expect(spec!.shgc).toBe(0.24);
    expect(spec!.product_line).toBe("Andersen 100");
    expect(spec!.extra).toEqual({ hardware: "white lock" });
    expect(spec!.source).toBe("ai");
  });

  it("keeps the raw size code and leaves dims null when it can't decode", () => {
    const spec = normalizeSpec({ mark_code: "W3", size_code: "ODD" });
    expect(spec!.size_code).toBe("ODD");
    expect(spec!.width_in).toBeNull();
    expect(spec!.height_in).toBeNull();
  });

  it("respects explicit width/height over decode, filling only gaps", () => {
    const spec = normalizeSpec({
      mark: "2",
      size_code: "3060",
      width_in: 35,
    });
    expect(spec!.width_in).toBe(35); // explicit wins
    expect(spec!.height_in).toBe(72); // filled from decode
  });

  it("returns null when there's no usable mark", () => {
    expect(normalizeSpec({ style: "Casement" })).toBeNull();
    expect(normalizeSpec(null)).toBeNull();
    expect(normalizeSpec("nope")).toBeNull();
  });

  it("keeps a valid elevation-drawing page and box", () => {
    const spec = normalizeSpec({
      mark: "#1",
      style: "Fixed",
      image_page: 1,
      image_bbox: [0.217, 0.128, 0.3, 0.29],
    });
    expect(spec!.image_page).toBe(1);
    expect(spec!.image_bbox).toEqual([0.217, 0.128, 0.3, 0.29]);
  });

  it("accepts the vision extractor's `page` / `bbox` aliases", () => {
    const spec = normalizeSpec({
      mark: "2",
      style: "Sliding",
      page: 3,
      bbox: [0.635, 0.055, 0.758, 0.253],
    });
    expect(spec!.image_page).toBe(3);
    expect(spec!.image_bbox).toEqual([0.635, 0.055, 0.758, 0.253]);
  });

  it("drops an unusable box rather than the whole mark", () => {
    const spec = normalizeSpec({
      mark: "4A",
      style: "Casement",
      image_page: 1,
      image_bbox: [0.7, 0.5, 0.2, 0.6], // reversed
    });
    expect(spec!.mark_code).toBe("4A");
    expect(spec!.style).toBe("Casement");
    expect(spec!.image_bbox).toBeNull();
  });

  it("rejects a page number that isn't a positive whole page", () => {
    const bad = (page: unknown) =>
      normalizeSpec({ mark: "1", style: "x", image_page: page })!.image_page;
    expect(bad(0)).toBeNull();
    expect(bad(-2)).toBeNull();
    expect(bad(1.5)).toBeNull();
    expect(bad("page one")).toBeNull();
    expect(bad(undefined)).toBeNull();
    expect(bad("4")).toBe(4);
  });

  it("honors an explicit source and defaults otherwise", () => {
    expect(normalizeSpec({ mark: "1", style: "x", source: "manual" })!.source).toBe(
      "manual",
    );
    expect(
      normalizeSpec({ mark: "1", style: "x" }, "deterministic")!.source,
    ).toBe("deterministic");
  });
});

describe("hasAnySpec", () => {
  it("is false for an empty spec", () => {
    const empty = normalizeSpec({ mark: "1" });
    expect(empty).not.toBeNull();
    expect(hasAnySpec(empty!)).toBe(false);
  });
  it("is true once any field is set", () => {
    expect(hasAnySpec(normalizeSpec({ mark: "1", color: "Black" })!)).toBe(true);
  });
  it("is true for a mark we only located a drawing for", () => {
    const drawingOnly = normalizeSpec({
      mark: "1",
      image_page: 1,
      image_bbox: [0.217, 0.128, 0.3, 0.29],
    });
    expect(hasAnySpec(drawingOnly!)).toBe(true);
  });
});

describe("mergeSpecsByMark", () => {
  it("keys specs by base mark and drops instance suffixes", () => {
    const merged = mergeSpecsByMark([
      { mark: "1-1", style: "Fixed", size_code: "3060" },
      { mark: "2", style: "Casement", size_code: "2846" },
    ]);
    expect(merged.map((m) => m.mark_code)).toEqual(["1", "2"]);
    expect(merged[0].width_in).toBe(36);
    expect(merged[1].width_in).toBe(32);
  });

  // A page-at-a-time extraction upserts the whole row each page, so the runner
  // feeds the drafts merged so far back in as the base. Without that, page 2's
  // partial view of a mark would null out what page 1 found.
  it("reunites a mark split across pages when earlier drafts are the merge base", () => {
    const afterPage1 = mergeSpecsByMark([{ mark: "14", style: "Fixed", size_code: "3060" }]);
    const afterPage2 = mergeSpecsByMark([
      ...afterPage1,
      { mark: "14", color: "Bronze", glass: "Low-E" },
    ]);
    expect(afterPage2).toHaveLength(1);
    expect(afterPage2[0]).toMatchObject({
      mark_code: "14",
      style: "Fixed",
      size_code: "3060",
      color: "Bronze",
      glass: "Low-E",
    });
    expect(afterPage2[0].width_in).toBe(36);
  });

  it("reinforces (fills gaps) when the same mark appears twice", () => {
    const merged = mergeSpecsByMark([
      { mark: "1", style: "Fixed", color: null },
      { mark: "1", color: "Black", glass: "Low-E" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].style).toBe("Fixed");
    expect(merged[0].color).toBe("Black");
    expect(merged[0].glass).toBe("Low-E");
  });

  it("does not overwrite an existing field with a later value", () => {
    const merged = mergeSpecsByMark([
      { mark: "1", color: "Black" },
      { mark: "1", color: "White" },
    ]);
    expect(merged[0].color).toBe("Black");
  });

  it("merges extra JSON from both entries", () => {
    const merged = mergeSpecsByMark([
      { mark: "1", extra: { a: 1 } },
      { mark: "1", extra: { b: 2 } },
    ]);
    expect(merged[0].extra).toEqual({ a: 1, b: 2 });
  });

  it("takes a mark's drawing page and box together, never mixed", () => {
    // The mark is transcribed on page 1 (no drawing found) and again on page 2
    // (drawing found). The box must arrive with page 2, not pinned to page 1.
    const merged = mergeSpecsByMark([
      { mark: "1", style: "Fixed", image_page: 1 },
      { mark: "1", color: "Black", image_page: 2, image_bbox: [0.1, 0.1, 0.3, 0.4] },
    ]);
    expect(merged[0].image_page).toBe(2);
    expect(merged[0].image_bbox).toEqual([0.1, 0.1, 0.3, 0.4]);
  });

  it("keeps the first drawing it found when a later page has another", () => {
    const merged = mergeSpecsByMark([
      { mark: "1", style: "Fixed", image_page: 1, image_bbox: [0.1, 0.1, 0.3, 0.4] },
      { mark: "1", color: "Black", image_page: 2, image_bbox: [0.5, 0.5, 0.7, 0.8] },
    ]);
    expect(merged[0].image_page).toBe(1);
    expect(merged[0].image_bbox).toEqual([0.1, 0.1, 0.3, 0.4]);
  });

  it("skips entries with no mark or no usable data", () => {
    const merged = mergeSpecsByMark([
      { style: "no mark" },
      { mark: "3" }, // no fields
      { mark: "4", color: "Bronze" },
    ]);
    expect(merged.map((m) => m.mark_code)).toEqual(["4"]);
  });
});
