import { describe, expect, it } from "vitest";
import { detectPageStories, parseSheetTitle } from "./storyDetect";

describe("parseSheetTitle — the research's catalogue of real phrasings", () => {
  it("reads explicit ordinals and levels", () => {
    expect(parseSheetTitle("FIRST FLOOR PLAN")?.story).toBe(1);
    expect(parseSheetTitle("2nd Floor Plan")?.story).toBe(2);
    expect(parseSheetTitle("THIRD  FLOOR  PLAN")?.story).toBe(3);
    expect(parseSheetTitle("LEVEL 2 FLOOR PLAN")?.story).toBe(2);
    expect(parseSheetTitle("PLAN - LEVEL 3")?.story).toBe(3);
    expect(parseSheetTitle("LEVEL 7")?.story).toBe(7);
  });

  it("reads relative words as pending resolution", () => {
    expect(parseSheetTitle("MAIN FLOOR PLAN")?.relative).toBe("main");
    expect(parseSheetTitle("MAIN FLR FLOOR PLAN")?.relative).toBe("main");
    expect(parseSheetTitle("UPPER LEVEL PLAN")?.relative).toBe("upper");
    expect(parseSheetTitle("LOWER LEVEL PLAN")?.relative).toBe("lower");
    expect(parseSheetTitle("BASEMENT FLOOR PLAN")?.relative).toBe("basement");
    expect(parseSheetTitle("GROUND FLOOR PLAN")?.story).toBe(1);
  });

  it("reads typical-floor ranges", () => {
    expect(parseSheetTitle("FLOOR PLAN — LEVELS 2-6")?.range).toEqual([2, 6]);
    expect(parseSheetTitle("LEVELS 2 THRU 5 PLAN")?.range).toEqual([2, 5]);
  });

  it("rejects the sheets that repeat a story name but carry no windows", () => {
    expect(parseSheetTitle("SECOND FLOOR DEMOLITION PLAN")).toBeNull();
    expect(parseSheetTitle("EXISTING FIRST FLOOR PLAN")).toBeNull();
    expect(parseSheetTitle("SECOND FLOOR REFLECTED CEILING PLAN")).toBeNull();
    expect(parseSheetTitle("SECOND FLOOR FRAMING PLAN")).toBeNull();
    expect(parseSheetTitle("FOUNDATION PLAN")).toBeNull();
    expect(parseSheetTitle("ROOF PLAN")).toBeNull();
    expect(parseSheetTitle("FIRST FLOOR ELECTRICAL PLAN")).toBeNull();
  });

  it("ignores lines that aren't plan titles at all", () => {
    expect(parseSheetTitle("EXTERIOR ELEVATIONS")).toBeNull();
    expect(parseSheetTitle("WINDOW SCHEDULE")).toBeNull();
    expect(parseSheetTitle("THE BLACK DAHLIA")).toBeNull();
    expect(parseSheetTitle("")).toBeNull();
  });
});

describe("detectPageStories — resolution against the whole set", () => {
  const page = (pageNumber: number, ...lines: string[]) => ({ pageNumber, lines });

  it("MAIN + UPPER resolves to 1 + 2; everything stays probable", () => {
    const d = detectPageStories([
      page(1, "COVER SHEET"),
      page(2, "THE BLACK DAHLIA", "MAIN FLR FLOOR PLAN"),
      page(3, "UPPER FLOOR PLAN"),
    ]);
    expect(d.pages).toEqual([
      expect.objectContaining({ pageNumber: 2, story: 1, confidence: "probable" }),
      expect.objectContaining({ pageNumber: 3, story: 2, confidence: "probable" }),
    ]);
    expect(d.stories.map((s) => s.n)).toEqual([1, 2]);
    expect(d.pages[0].evidence).toContain("MAIN FLR");
  });

  it("a LOWER in the set makes every relative word a human's call", () => {
    const d = detectPageStories([
      page(1, "LOWER LEVEL PLAN"),
      page(2, "MAIN LEVEL PLAN"),
      page(3, "UPPER LEVEL PLAN"),
    ]);
    expect(d.pages).toHaveLength(0);
    expect(d.unresolved).toHaveLength(3);
    expect(d.unresolved[0].reason).toContain("split-level");
  });

  it("explicit levels don't need resolution, and ranges land in unresolved", () => {
    const d = detectPageStories([
      page(1, "LEVEL 1 FLOOR PLAN"),
      page(2, "FLOOR PLAN — LEVELS 2-6"),
      page(3, "LEVEL 7 FLOOR PLAN"),
    ]);
    expect(d.pages.map((p) => p.story)).toEqual([1, 7]);
    expect(d.unresolved).toHaveLength(1);
    expect(d.unresolved[0].reason).toContain("typical-floor range");
  });

  it("first story-bearing title wins per page; rejects never mask real titles", () => {
    const d = detectPageStories([
      page(1, "SECOND FLOOR FRAMING PLAN", "SECOND FLOOR PLAN"),
    ]);
    expect(d.pages[0]?.story).toBe(2);
  });
});
