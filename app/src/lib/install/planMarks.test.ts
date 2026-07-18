import { describe, expect, it } from "vitest";
import { calloutsToDraftOpenings } from "./extract";
import {
  countCalloutsByMark,
  parsePlanMarkAnnotation,
} from "./planMarks";

describe("parsePlanMarkAnnotation", () => {
  it("expands repeated mark callouts like the #6 row on the plan", () => {
    expect(parsePlanMarkAnnotation("6   6  6            6  6  6")).toEqual([
      "6",
      "6",
      "6",
      "6",
      "6",
      "6",
    ]);
    expect(parsePlanMarkAnnotation("6  6   6         6   6")).toEqual([
      "6",
      "6",
      "6",
      "6",
      "6",
    ]);
  });

  it("keeps distinct marks in one annotation", () => {
    expect(parsePlanMarkAnnotation("13A 13B")).toEqual(["13A", "13B"]);
    expect(parsePlanMarkAnnotation("4A")).toEqual(["4A"]);
    expect(parsePlanMarkAnnotation("#18B")).toEqual(["18B"]);
  });

  it("ignores notes that are not inventory callouts", () => {
    expect(
      parsePlanMarkAnnotation("\n#18A 1 of  2 not used (3060 C/R)..."),
    ).toBeNull();
    expect(parsePlanMarkAnnotation("see sheet A2")).toBeNull();
  });
});

describe("calloutsToDraftOpenings", () => {
  it("creates twelve #6 openings when the plan has twelve callouts", () => {
    const callouts = Array.from({ length: 12 }, (_, i) => ({
      mark: "6",
      pageNumber: 3,
      x: 0.1 + i * 0.05,
      y: 0.4,
    }));
    const drafts = calloutsToDraftOpenings(
      callouts,
      [
        {
          openingCode: "6",
          typeText: "3070",
          qty: 1,
          label: null,
          pageNumber: 2,
          widthIn: 36,
          heightIn: 84,
          color: null,
          kind: "window",
        },
      ],
      [],
    );

    expect(countCalloutsByMark(callouts).get("6")).toBe(12);
    expect(drafts).toHaveLength(12);
    expect(drafts.map((d) => d.opening_code)).toEqual([
      "6-1",
      "6-2",
      "6-3",
      "6-4",
      "6-5",
      "6-6",
      "6-7",
      "6-8",
      "6-9",
      "6-10",
      "6-11",
      "6-12",
    ]);
    expect(drafts.every((d) => d.mark_code === "6")).toBe(true);
    expect(drafts.every((d) => d.type_text === "3070")).toBe(true);
    expect(drafts[0].pin_x).toBeCloseTo(0.1);
    expect(drafts[11].pin_y).toBe(0.4);
  });
});
