import { describe, expect, it } from "vitest";
import type { MarkSpecDraft } from "./specs";
import {
  deriveEgress,
  deriveTempered,
  normalizeMarkLabel,
  prepVisionSpec,
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
