import { describe, expect, it } from "vitest";
import type { MarkSpecDraft } from "./specs";
import {
  deriveEgress,
  deriveTempered,
  normalizeMarkLabel,
  prepVisionSpec,
  splitCombinedMark,
  splitSizeCodeOperation,
  visionMarksToDrafts,
  type RawVisionMark,
} from "./specsVision";

// Proven Claude VISION transcription of page 1 of the STRATA Windows & Doors
// shop drawing for PV Townhomes Bldg 14 — ground truth for the pipeline. The
// rich style/glass/color are drawn into the PDF as an image; only vision can
// read them. The edge function returns these verbatim as `mode: "vision"`.
const PAGE_1_MARKS: RawVisionMark[] = [
  {
    mark: "#1",
    style: "Thermal Break Aluminum Fixed Window(Nail Fins)",
    glass:
      "5(Low-E 366)+12A+5(Low-E 366) insulating tempered Low-E glass (argon filled)(Black IG Spacers)",
    color: "Black(Aluminum profile Color)",
    size_code: "3060",
    operation: "Fixed",
    qty: "2",
  },
  {
    mark: "PV Townhomes Bldg 14-#2",
    style:
      "3 Track 2 Panel Thermal break Aluminum Sliding Door with Removable magnetic screen(Nail Fins)",
    glass:
      "5(Low-E 366)+12A+5(Low-E 366) insulating tempered Low-E glass (argon filled)(Black IG Spacers)",
    color: "Black(Aluminum profile Color); Black(hardware Color)",
    size_code: "6080 XO",
    operation: "Sliding",
    qty: "1",
  },
  {
    mark: "PV Townhomes Bldg 14-#3",
    style:
      "3 Track 2 Panel Thermal break Aluminum Sliding Door with Removable magnetic screen(Nail Fins)",
    glass:
      "5(Low-E 366)+12A+5(Low-E 366) insulating tempered Low-E glass (argon filled)(Black IG Spacers)",
    color: "Black(Aluminum profile Color); Black(hardware Color)",
    size_code: "6080 OX",
    operation: "Sliding",
    qty: "1",
  },
  {
    mark: "PV Townhomes Bldg 14-#4A",
    style:
      "Thermal Break Aluminum Crank Casement window with Removable magnetic screen (Outward Open)(Nail Fins)",
    glass:
      "5(Low-E 366)+12A+5(Low-E 366) insulating tempered Low-E glass (argon filled)(Black IG Spacers)",
    color: null,
    size_code: "3060",
    operation: "Crank Casement, Outward Open",
    qty: "1&1",
  },
  {
    mark: "PV Townhomes Bldg 14-#4B",
    style:
      "Thermal Break Aluminum Crank Casement window with Removable magnetic screen (Outward Open)(Nail Fins)",
    glass:
      "5(Low-E 366)+12A+5(Low-E 366) insulating tempered Low-E glass (argon filled)(Black IG Spacers)",
    color: null,
    size_code: "3060",
    operation: "Crank Casement, Outward Open",
    qty: "1&1",
  },
];

function byMark(specs: MarkSpecDraft[]): Map<string, MarkSpecDraft> {
  return new Map(specs.map((s) => [s.mark_code, s]));
}

describe("normalizeMarkLabel", () => {
  it("strips the project prefix and leading '#'", () => {
    expect(normalizeMarkLabel("PV Townhomes Bldg 14-#4A")).toBe("4A");
    expect(normalizeMarkLabel("PV Townhomes Bldg 14-#13B")).toBe("13B");
    expect(normalizeMarkLabel("#1")).toBe("1");
    expect(normalizeMarkLabel("1")).toBe("1");
  });

  it("drops a prefix even without a '#'", () => {
    expect(normalizeMarkLabel("PV Townhomes Bldg 14-4A")).toBe("4A");
  });

  it("does not mangle a plain code with no prefix", () => {
    expect(normalizeMarkLabel("A-101")).toBe("A-101");
    expect(normalizeMarkLabel("W3")).toBe("W3");
  });

  it("returns null for empty input", () => {
    expect(normalizeMarkLabel(null)).toBeNull();
    expect(normalizeMarkLabel("")).toBeNull();
  });
});

describe("splitSizeCodeOperation", () => {
  it("splits a trailing operation token off the size code", () => {
    expect(splitSizeCodeOperation("6080 XO", null)).toEqual({
      size_code: "6080",
      operation: "XO",
    });
    expect(splitSizeCodeOperation("6080 OX", null)).toEqual({
      size_code: "6080",
      operation: "OX",
    });
  });

  it("keeps an explicit operation over the trailing token", () => {
    expect(splitSizeCodeOperation("6080 XO", "Sliding")).toEqual({
      size_code: "6080",
      operation: "Sliding",
    });
  });

  it("handles a bare size code with a separate operation", () => {
    expect(splitSizeCodeOperation("3060", "Fixed")).toEqual({
      size_code: "3060",
      operation: "Fixed",
    });
  });

  it("keeps an undecodable size verbatim", () => {
    expect(splitSizeCodeOperation("ODD", null)).toEqual({
      size_code: "ODD",
      operation: null,
    });
  });
});

describe("deriveTempered / deriveEgress", () => {
  it("reads tempered from the glass makeup text", () => {
    expect(deriveTempered("… insulating tempered Low-E glass …")).toBe(true);
    expect(deriveTempered("clear annealed")).toBeNull();
    expect(deriveTempered(null)).toBeNull();
  });

  it("only flags egress when the text literally says egress", () => {
    expect(deriveEgress("Egress casement window", "Casement")).toBe(true);
    expect(deriveEgress(null, "Egress, Outward Open")).toBe(true);
    // A plain casement is NOT assumed to be egress.
    expect(deriveEgress("Crank Casement window", "Crank Casement")).toBeNull();
  });
});

describe("prepVisionSpec", () => {
  it("shapes a verbatim vision mark for normalizeSpec", () => {
    const prepped = prepVisionSpec(PAGE_1_MARKS[1]); // #2 sliding door
    expect(prepped).toMatchObject({
      mark_code: "2",
      size_code: "6080",
      operation: "Sliding",
      tempered: true,
      egress: null,
      source: "ai",
      extra: { qty: "1" },
    });
    expect(prepped.glass).toMatch(/Low-E 366/);
  });
});

describe("visionMarksToDrafts (proven page-1 output)", () => {
  const drafts = visionMarksToDrafts(PAGE_1_MARKS);
  const map = byMark(drafts);

  it("normalizes every mark label", () => {
    expect(new Set(drafts.map((d) => d.mark_code))).toEqual(
      new Set(["1", "2", "3", "4A", "4B"]),
    );
  });

  it("keeps the rich style / glass / color that only vision can read", () => {
    const one = map.get("1")!;
    expect(one.style).toMatch(/Fixed Window/);
    expect(one.glass).toMatch(/Low-E 366/);
    expect(one.color).toMatch(/Black/);
  });

  it("decodes size codes after splitting the operation token", () => {
    // #1 Fixed 3060 → 3'0" x 6'0"
    expect(map.get("1")).toMatchObject({
      size_code: "3060",
      operation: "Fixed",
      width_in: 36,
      height_in: 72,
    });
    // #2 sliding 6080 XO → code 6080 (72x96), explicit "Sliding" wins
    expect(map.get("2")).toMatchObject({
      size_code: "6080",
      operation: "Sliding",
      width_in: 72,
      height_in: 96,
    });
    // #3 mirror slider 6080 OX
    expect(map.get("3")).toMatchObject({ size_code: "6080", width_in: 72 });
  });

  it("derives tempered from the glass makeup on every mark", () => {
    for (const d of drafts) expect(d.tempered).toBe(true);
  });

  it("does not invent egress on a plain casement", () => {
    expect(map.get("4A")!.egress).toBeNull();
    expect(map.get("4A")).toMatchObject({
      size_code: "3060",
      operation: "Crank Casement, Outward Open",
    });
  });

  it("preserves qty in extra and marks rows as unconfirmed AI drafts", () => {
    expect(map.get("1")!.extra).toMatchObject({ qty: "2" });
    for (const d of drafts) expect(d.source).toBe("ai");
  });
});

describe("splitCombinedMark", () => {
  it("splits a fully-prefixed combined mark and its a&b qty", () => {
    const pieces = splitCombinedMark({
      mark: "PV Townhomes Bldg 14-#4A& PV Townhomes Bldg 14-#4B",
      qty: "1&1",
    });
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => normalizeMarkLabel(p.mark))).toEqual(["4A", "4B"]);
    expect(pieces.map((p) => p.qty)).toEqual(["1", "1"]);
  });

  it("splits an uneven a&b qty across the two marks", () => {
    const pieces = splitCombinedMark({
      mark: "PV Townhomes Bldg 14-#13A& PV Townhomes Bldg 14-#13B",
      qty: "3&2",
    });
    expect(pieces.map((p) => normalizeMarkLabel(p.mark))).toEqual([
      "13A",
      "13B",
    ]);
    expect(pieces.map((p) => p.qty)).toEqual(["3", "2"]);
  });

  it("handles bare '#a & #b' and 'a&b' forms and '/' and 'and'", () => {
    expect(
      splitCombinedMark({ mark: "#4A & #4B" }).map((p) =>
        normalizeMarkLabel(p.mark),
      ),
    ).toEqual(["4A", "4B"]);
    expect(
      splitCombinedMark({ mark: "4A&4B" }).map((p) =>
        normalizeMarkLabel(p.mark),
      ),
    ).toEqual(["4A", "4B"]);
    expect(
      splitCombinedMark({ mark: "4A / 4B" }).map((p) =>
        normalizeMarkLabel(p.mark),
      ),
    ).toEqual(["4A", "4B"]);
    expect(
      splitCombinedMark({ mark: "18A and 18B" }).map((p) =>
        normalizeMarkLabel(p.mark),
      ),
    ).toEqual(["18A", "18B"]);
  });

  it("copies the shared spec fields onto every split piece", () => {
    const combined: RawVisionMark = {
      mark: "PV Townhomes Bldg 14-#18A& PV Townhomes Bldg 14-#18B",
      style: "Thermal Break Aluminum Crank Casement window",
      glass: "insulating tempered Low-E glass",
      color: "Black",
      size_code: "3060",
      operation: "Crank Casement, Outward Open",
      qty: "2&2",
    };
    const pieces = splitCombinedMark(combined);
    for (const p of pieces) {
      expect(p).toMatchObject({
        style: combined.style,
        glass: combined.glass,
        color: combined.color,
        size_code: combined.size_code,
        operation: combined.operation,
      });
    }
  });

  it("leaves qty untouched on both pieces when it isn't in a&b form", () => {
    const pieces = splitCombinedMark({ mark: "4A&4B", qty: "5" });
    expect(pieces.map((p) => p.qty)).toEqual(["5", "5"]);
  });

  it("gives both halves the same drawing when only one box came back", () => {
    const pieces = splitCombinedMark({
      mark: "#4A & #4B",
      image_page: 1,
      bbox: [0.59, 0.462, 0.672, 0.622],
    });
    expect(pieces.map((p) => p.bbox)).toEqual([
      [0.59, 0.462, 0.672, 0.622],
      [0.59, 0.462, 0.672, 0.622],
    ]);
    expect(pieces.map((p) => p.image_page)).toEqual([1, 1]);
  });

  it("hands out one box per half when the model located both", () => {
    // #4A and #4B are drawn side by side; keeping their own boxes means each
    // card shows its own elevation rather than a shared one.
    const pieces = splitCombinedMark({
      mark: "#4A & #4B",
      image_page: 1,
      bboxes: [
        [0.59, 0.462, 0.672, 0.622],
        [0.805, 0.462, 0.89, 0.622],
      ],
    });
    expect(pieces.map((p) => p.bbox)).toEqual([
      [0.59, 0.462, 0.672, 0.622],
      [0.805, 0.462, 0.89, 0.622],
    ]);
    expect(pieces.every((p) => p.bboxes === undefined)).toBe(true);
  });

  it("does not mistake a 4-number box for four per-piece boxes", () => {
    const pieces = splitCombinedMark({
      mark: "4A & 4B & 4C & 4D",
      bbox: [0.1, 0.1, 0.3, 0.4],
    });
    expect(pieces).toHaveLength(4);
    for (const p of pieces) expect(p.bbox).toEqual([0.1, 0.1, 0.3, 0.4]);
  });

  it("does NOT split a legitimate single mark", () => {
    // No separator at all.
    expect(splitCombinedMark({ mark: "PV Townhomes Bldg 14-#4A" })).toHaveLength(
      1,
    );
    // Contains '&' but the pieces are not plausible bare mark codes.
    const notCodes = splitCombinedMark({
      mark: "Tempered glass & argon fill",
    });
    expect(notCodes).toHaveLength(1);
    expect(notCodes[0].mark).toBe("Tempered glass & argon fill");
  });
});

describe("visionMarksToDrafts (elevation drawing location)", () => {
  it("carries the page and box through to the draft", () => {
    const drafts = visionMarksToDrafts([
      {
        mark: "#1",
        style: "Thermal Break Aluminum Fixed Window",
        image_page: 1,
        bbox: [0.217, 0.128, 0.3, 0.29],
      },
    ]);
    expect(drafts[0]).toMatchObject({
      mark_code: "1",
      image_page: 1,
      image_bbox: [0.217, 0.128, 0.3, 0.29],
    });
  });

  it("keeps the spec text when the box is unusable", () => {
    const drafts = visionMarksToDrafts([
      {
        mark: "#1",
        style: "Thermal Break Aluminum Fixed Window",
        image_page: 1,
        bbox: [0, 0, 1, 1], // the whole sheet — not a drawing
      },
    ]);
    expect(drafts[0].style).toMatch(/Fixed Window/);
    expect(drafts[0].image_bbox).toBeNull();
  });

  it("gives each split half of a combined mark its own drawing", () => {
    const drafts = visionMarksToDrafts([
      {
        mark: "PV Townhomes Bldg 14-#4A& PV Townhomes Bldg 14-#4B",
        style: "Thermal Break Aluminum Crank Casement window",
        size_code: "3060",
        qty: "1&1",
        image_page: 1,
        bboxes: [
          [0.59, 0.462, 0.672, 0.622],
          [0.805, 0.462, 0.89, 0.622],
        ],
      },
    ]);
    const map = byMark(drafts);
    expect(map.get("4A")!.image_bbox).toEqual([0.59, 0.462, 0.672, 0.622]);
    expect(map.get("4B")!.image_bbox).toEqual([0.805, 0.462, 0.89, 0.622]);
    expect(map.get("4A")!.image_page).toBe(1);
    expect(map.get("4B")!.image_page).toBe(1);
  });
});

describe("visionMarksToDrafts (combined A/B marks from vision)", () => {
  // Real live output: Claude vision sometimes merges two adjacent paired marks
  // into ONE object on the Smith / PV Townhomes sheet.
  const COMBINED: RawVisionMark[] = [
    {
      mark: "PV Townhomes Bldg 14-#4A& PV Townhomes Bldg 14-#4B",
      style: "Thermal Break Aluminum Crank Casement window (Outward Open)",
      glass: "insulating tempered Low-E glass",
      color: "Black",
      size_code: "3060",
      operation: "Crank Casement, Outward Open",
      qty: "1&1",
    },
    {
      mark: "PV Townhomes Bldg 14-#13A& PV Townhomes Bldg 14-#13B",
      style: "Thermal Break Aluminum Fixed Window",
      glass: "insulating tempered Low-E glass",
      color: "Black",
      size_code: "6080 XO",
      operation: "Sliding",
      qty: "3&2",
    },
    {
      mark: "PV Townhomes Bldg 14-#18A& PV Townhomes Bldg 14-#18B",
      style: "Thermal Break Aluminum Crank Casement window",
      glass: "insulating tempered Low-E glass",
      color: "Black",
      size_code: "3060",
      operation: "Crank Casement",
      qty: "2&2",
    },
  ];

  const drafts = visionMarksToDrafts(COMBINED);
  const map = byMark(drafts);

  it("expands each combined entry into its two separate marks", () => {
    expect(new Set(drafts.map((d) => d.mark_code))).toEqual(
      new Set(["4A", "4B", "13A", "13B", "18A", "18B"]),
    );
  });

  it("shares identical spec fields across a split pair", () => {
    const fields = (m: string) => {
      const s = map.get(m)!;
      return {
        style: s.style,
        glass: s.glass,
        color: s.color,
        size_code: s.size_code,
        operation: s.operation,
        width_in: s.width_in,
        height_in: s.height_in,
        tempered: s.tempered,
      };
    };
    expect(fields("4A")).toEqual(fields("4B"));
    expect(fields("13A")).toEqual(fields("13B"));
    expect(fields("18A")).toEqual(fields("18B"));
    // ...and the shared values decoded/derived as expected.
    expect(map.get("13A")).toMatchObject({
      size_code: "6080",
      operation: "Sliding",
      width_in: 72,
      height_in: 96,
      tempered: true,
    });
  });

  it("splits qty when it's in a&b form", () => {
    expect(map.get("4A")!.extra).toMatchObject({ qty: "1" });
    expect(map.get("4B")!.extra).toMatchObject({ qty: "1" });
    expect(map.get("13A")!.extra).toMatchObject({ qty: "3" });
    expect(map.get("13B")!.extra).toMatchObject({ qty: "2" });
    expect(map.get("18A")!.extra).toMatchObject({ qty: "2" });
    expect(map.get("18B")!.extra).toMatchObject({ qty: "2" });
  });
});

// The call size is decoded as feet+inches, which is this supplier's convention
// and not a universal one. These sheets print the real dimensions next to each
// elevation, so we transcribe those too and check the decode against them —
// and when they disagree, the printed dimensions are what the crew is shown.
describe("visionMarksToDrafts (printed dimensions cross-check)", () => {
  /** Smith mark #1 as transcribed, dimensions and all. */
  const SMITH_MARK_1: RawVisionMark = {
    ...PAGE_1_MARKS[0],
    printed_width: '901(35 1/2")',
    printed_height: '1816(71 1/2")',
  };

  /**
   * The failure this feature exists for: a supplier whose 4-digit codes are
   * INCHES. "3672" means 36" x 72"; decoded as feet+inches it silently becomes
   * 42" x 86" — a wrong size on an installer's sheet with nothing to flag it.
   */
  const INCH_CONVENTION_MARK: RawVisionMark = {
    mark: "#7",
    style: "Thermal Break Aluminum Fixed Window(Nail Fins)",
    glass: "5(Low-E 366)+12A+5(Low-E 366) insulating tempered Low-E glass",
    color: "Black(Aluminum profile Color)",
    size_code: "3672",
    operation: "Fixed",
    qty: "1",
    printed_width: '36"',
    printed_height: '72"',
  };

  it("keeps the nominal decoded size when the sheet agrees (real mark 1)", () => {
    const [draft] = visionMarksToDrafts([SMITH_MARK_1]);
    // 3060 → 36 x 72 nominal against a printed 35.5 x 71.5 frame: half an inch
    // of deliberate slack, not a disagreement.
    expect(draft).toMatchObject({
      mark_code: "1",
      size_code: "3060",
      width_in: 36,
      height_in: 72,
    });
    expect(draft.extra).toMatchObject({
      qty: "2",
      printed_width: '901(35 1/2")',
      printed_height: '1816(71 1/2")',
      printed_width_in: 35.5,
      printed_height_in: 71.5,
    });
    expect(draft.extra).not.toHaveProperty("size_mismatch");
  });

  it("prefers the printed dimensions when the code disagrees", () => {
    const [draft] = visionMarksToDrafts([INCH_CONVENTION_MARK]);
    expect(draft).toMatchObject({
      mark_code: "7",
      // The raw code is still kept verbatim — we report the conflict, we don't
      // rewrite what the sheet said.
      size_code: "3672",
      width_in: 36,
      height_in: 72,
    });
    expect(draft.extra).toMatchObject({
      size_mismatch: {
        size_code: "3672",
        decoded_width_in: 42,
        decoded_height_in: 86,
        printed_width_in: 36,
        printed_height_in: 72,
        delta_width_in: 6,
        delta_height_in: 14,
      },
    });
  });

  it("behaves exactly as before when no dimensions are printed", () => {
    const [draft] = visionMarksToDrafts([PAGE_1_MARKS[0]]);
    expect(draft).toMatchObject({
      mark_code: "1",
      size_code: "3060",
      width_in: 36,
      height_in: 72,
      extra: { qty: "2" },
    });
    expect(Object.keys(draft.extra ?? {})).toEqual(["qty"]);
  });

  it("ignores a dimension it cannot read rather than guessing", () => {
    const [draft] = visionMarksToDrafts([
      { ...SMITH_MARK_1, printed_width: "see detail", printed_height: null },
    ]);
    expect(draft).toMatchObject({ width_in: 36, height_in: 72 });
    expect(draft.extra).toMatchObject({ printed_width: "see detail" });
    expect(draft.extra).not.toHaveProperty("printed_width_in");
    expect(draft.extra).not.toHaveProperty("size_mismatch");
  });

  it("fills the size from the drawing when the code cannot be decoded", () => {
    const [draft] = visionMarksToDrafts([
      {
        ...SMITH_MARK_1,
        size_code: "900x1800",
        printed_width: '901(35 1/2")',
        printed_height: '1816(71 1/2")',
      },
    ]);
    expect(draft.width_in).toBe(35.5);
    expect(draft.height_in).toBe(71.5);
  });
});
