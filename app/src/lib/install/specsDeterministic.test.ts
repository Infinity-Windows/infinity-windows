import { describe, expect, it } from "vitest";
import type { MarkSpecDraft } from "./specs";
import { mergeSpecsByMark } from "./specs";
import {
  collectDimensionsInInches,
  extractSpecsDeterministic,
  interpretOperation,
  parseSplitFractionInches,
} from "./specsDeterministic";

// REAL text (verbatim from pypdf) of the 6 CAD pages of the STRATA Windows &
// Doors shop-drawing PDF for PV Townhomes Bldg 14. The text layer is sparse and
// scrambled — this is the ground truth the deterministic parser must handle.
const PAGES: { pageNumber: number; text: string }[] = [
  {
    pageNumber: 1,
    text: `Project Name STRATA WINDOWS & DOORS
Construction Organization 
PV Townhomes Bldg 14 Cads -1
2024-12-22
PV Townhomes Bldg 14
STG WINDOWS
901(35 
1
2")
1816(71 
1
2") F
901(35 
1
2")901(35 
1
2")
1802(71")
F
1219(48")
Both side straight handle (Black)
Lock interior and with key exterior
Fixed
2425(95 
1
2")
Outside View
1816(71 
1
2")
Egress Hinges
PV Townhomes Bldg 14-#4APV Townhomes Bldg 14-#4B
6080 OX3060
6080 XO 3060`,
  },
  {
    pageNumber: 2,
    text: `908(35 3 4")908(35 3 4")
1816(71 1 2")
901(35 1 2")
2120(83 1 2") F
1206(47 1 2")1206(47 1 2")
2412(95")
F
1219(48")
Both side straight handle (Black)
Lock interior and with key exterior
Fixed
2425(95 1 2")
Egress Hinges
8080 XO8080 OX
3070 6060`,
  },
  {
    pageNumber: 3,
    text: `1816(71 1 2")
596(23 1 2") F
1511(59 1 2")
2120(83 1 2") F
901(35 1 2")901(35 1 2")
1802(71")
Fixed
2425(95 1 2")
Frosted glass
6020 FROSTED5070
6080 OX 6080 XO`,
  },
  {
    pageNumber: 4,
    text: `Egress Hinges
901(35 1 2")
1816(71 1 2")
2120(83 1 2") F
1206(47 1 2")
2412(95")
Fixed
2425(95 1 2")
PV Townhomes Bldg 14-#13APV Townhomes Bldg 14-#13B
8080 XO8080 OX
3070 3060`,
  },
  {
    pageNumber: 5,
    text: `2120(83 1 2") F
1816(71 1 2")
Egress Hinges
596(23 1 2") F
2412(95")
Fixed
Frosted glass
PV Townhomes Bldg 14-#18APV Townhomes Bldg 14-#18B
8080 XO 6020 FROSTED
30703060`,
  },
  {
    pageNumber: 6,
    text: `1206(47 1 2") 1206(47 1 2")
2412(95")
Both side straight handle (Black)
Lock interior and with key exterior
Fixed
2425(95 1 2")
Sliding door track(3 Track)(Sacle:20:1)
8080 OX`,
  },
];

function byMark(specs: MarkSpecDraft[]): Map<string, MarkSpecDraft> {
  return new Map(specs.map((s) => [s.mark_code, s]));
}

describe("interpretOperation", () => {
  it("maps XO/OX to a slider, preserving which side operates", () => {
    expect(interpretOperation("XO")).toEqual({ operation: "XO", frosted: false });
    expect(interpretOperation("OX")).toEqual({ operation: "OX", frosted: false });
    expect(interpretOperation("ox")).toEqual({ operation: "OX", frosted: false });
  });

  it("maps F / Fixed to a fixed lite", () => {
    expect(interpretOperation("F")).toEqual({ operation: "Fixed", frosted: false });
    expect(interpretOperation("Fixed")).toEqual({
      operation: "Fixed",
      frosted: false,
    });
  });

  it("maps FROSTED to a frosted-glass note (no operation)", () => {
    expect(interpretOperation("FROSTED")).toEqual({
      operation: null,
      frosted: true,
    });
  });

  it("returns nothing for an absent/unknown token", () => {
    expect(interpretOperation(null)).toEqual({ operation: null, frosted: false });
    expect(interpretOperation("")).toEqual({ operation: null, frosted: false });
  });
});

describe("parseSplitFractionInches", () => {
  it("parses a whole-plus-fraction split across whitespace", () => {
    expect(parseSplitFractionInches("35 1 2")).toBe(35.5);
    expect(parseSplitFractionInches("35 3 4")).toBe(35.75);
    expect(parseSplitFractionInches("71 1 2")).toBe(71.5);
    expect(parseSplitFractionInches("95 1 2")).toBe(95.5);
    expect(parseSplitFractionInches("23 1 2")).toBe(23.5);
  });

  it("parses the split fraction even when broken across newlines", () => {
    expect(parseSplitFractionInches("35\n1\n2")).toBe(35.5);
  });

  it("parses a bare whole number and the parenthesised inch form", () => {
    expect(parseSplitFractionInches("71")).toBe(71);
    expect(parseSplitFractionInches('(48")')).toBe(48);
    expect(parseSplitFractionInches('(35 1 2")')).toBe(35.5);
  });

  it("returns null when there is no number", () => {
    expect(parseSplitFractionInches(null)).toBeNull();
    expect(parseSplitFractionInches("")).toBeNull();
    expect(parseSplitFractionInches('"')).toBeNull();
  });
});

describe("collectDimensionsInInches", () => {
  it("reads the parenthesised inch dimensions off a scrambled page", () => {
    const dims = collectDimensionsInInches(PAGES[0].text);
    expect(dims).toContain(35.5);
    expect(dims).toContain(71.5);
    expect(dims).toContain(71); // 1802(71")
    expect(dims).toContain(48); // 1219(48")
    expect(dims).toContain(95.5); // 2425(95 1 2")
  });

  it("handles the inline 3/4 fraction on page 2", () => {
    expect(collectDimensionsInInches(PAGES[1].text)).toContain(35.75);
  });
});

describe("extractSpecsDeterministic (STRATA shop drawing)", () => {
  const specs = extractSpecsDeterministic(PAGES);
  const map = byMark(specs);

  it("finds every size code present across the six pages", () => {
    const marks = new Set(specs.map((s) => s.mark_code));
    expect(marks).toEqual(
      new Set([
        "6080 OX",
        "6080 XO",
        "3060",
        "8080 XO",
        "8080 OX",
        "3070",
        "6060",
        "6020 FROSTED",
        "5070",
      ]),
    );
  });

  it("decodes each size code to the validated width/height in inches", () => {
    // 3060 = 3'0" x 6'0" (real unit ~35½" x 71½")
    expect(map.get("3060")).toMatchObject({ width_in: 36, height_in: 72 });
    // 6080 = 6'0" x 8'0"
    expect(map.get("6080 OX")).toMatchObject({ width_in: 72, height_in: 96 });
    expect(map.get("6080 XO")).toMatchObject({ width_in: 72, height_in: 96 });
    // 8080 = 8'0" x 8'0"
    expect(map.get("8080 OX")).toMatchObject({ width_in: 96, height_in: 96 });
    // 6060 = 6'0" x 6'0"
    expect(map.get("6060")).toMatchObject({ width_in: 72, height_in: 72 });
    // 3070 = 3'0" x 7'0"
    expect(map.get("3070")).toMatchObject({ width_in: 36, height_in: 84 });
    // 5070 = 5'0" x 7'0"
    expect(map.get("5070")).toMatchObject({ width_in: 60, height_in: 84 });
    // 6020 = 6'0" x 2'0" (real unit ~23½" tall)
    expect(map.get("6020 FROSTED")).toMatchObject({ width_in: 72, height_in: 24 });
  });

  it("captures the slider operation and preserves which side operates", () => {
    expect(map.get("6080 OX")!.operation).toBe("OX");
    expect(map.get("6080 XO")!.operation).toBe("XO");
    expect(map.get("8080 OX")!.operation).toBe("OX");
    expect(map.get("8080 XO")!.operation).toBe("XO");
  });

  it("flags FROSTED as a frosted/tempered-glass note (not a glass makeup)", () => {
    const frosted = map.get("6020 FROSTED")!;
    expect(frosted.tempered).toBe(true);
    expect(frosted.extra?.glass_note).toMatch(/frosted/i);
  });

  it("flags egress on the hinged (non-slider) units on egress-hinge sheets", () => {
    expect(map.get("3060")!.egress).toBe(true);
    expect(map.get("3070")!.egress).toBe(true);
    expect(map.get("6060")!.egress).toBe(true);
  });

  it("does not flag egress on sliders, frosted lites, or non-egress sheets", () => {
    expect(map.get("6080 OX")!.egress).not.toBe(true);
    expect(map.get("8080 OX")!.egress).not.toBe(true);
    expect(map.get("6020 FROSTED")!.egress).not.toBe(true);
    // 5070 only appears on page 3, which has no "Egress Hinges".
    expect(map.get("5070")!.egress).not.toBe(true);
  });

  it("attaches hardware notes to the operable sliding units", () => {
    const slider = map.get("6080 OX")!;
    expect(slider.extra?.handle).toMatch(/straight handle/i);
    expect(slider.extra?.lock).toMatch(/key exterior/i);
    // The 8080 OX sliding door (page 6) is a 3-track unit.
    expect(map.get("8080 OX")!.extra?.track).toMatch(/3-track/i);
  });

  it("marks every produced row as a deterministic, unconfirmed draft", () => {
    for (const s of specs) {
      expect(s.source).toBe("deterministic");
      expect(s.size_code).toBeTruthy();
    }
  });

  it("leaves glass makeup, color and energy blank — never invents them", () => {
    for (const s of specs) {
      expect(s.glass).toBeNull();
      expect(s.color).toBeNull();
      expect(s.u_factor).toBeNull();
      expect(s.shgc).toBeNull();
      expect(s.product_line).toBeNull();
      expect(s.style).toBeNull();
    }
  });

  it("returns nothing for planset text with no size codes", () => {
    expect(
      extractSpecsDeterministic([
        { pageNumber: 1, text: "General notes. See sheet A-1. Dated 2024-12-22." },
      ]),
    ).toEqual([]);
  });
});

describe("merging deterministic specs with AI results (complement, not replace)", () => {
  it("keeps AI's rich mark and adds the deterministic size codes it missed", () => {
    // Simulate an AI result that recognised one rich mark ("4A") but returned
    // no size/operation for the scrambled shop drawing.
    const aiLike = {
      mark_code: "4A",
      style: "Thermal Break Aluminum Slider",
      color: "Black (Aluminum Profile)",
      source: "ai",
    };
    const deterministic = extractSpecsDeterministic(PAGES);
    const merged = mergeSpecsByMark([aiLike, ...deterministic], "deterministic");
    const map = byMark(merged);

    // AI's rich mark survives with its color/style intact…
    expect(map.get("4A")).toMatchObject({
      color: "Black (Aluminum Profile)",
      source: "ai",
    });
    // …and the deterministic size codes are surfaced alongside it.
    expect(map.get("6080 OX")).toMatchObject({ width_in: 72, operation: "OX" });
    expect(map.get("6020 FROSTED")!.tempered).toBe(true);
  });
});
