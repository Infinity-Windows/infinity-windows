import { describe, expect, it } from "vitest";
import { extractCadDetailPages, findFloorPlanPages } from "./planDetails";

describe("findFloorPlanPages", () => {
  it("ignores a cover-sheet index and selects drawing sheets", () => {
    expect(
      findFloorPlanPages([
        { pageNumber: 1, text: "CONTENTS A2 FLOOR PLAN" },
        { pageNumber: 2, text: "SHEET TITLE: EXTERIOR ELEVATIONS" },
        { pageNumber: 3, text: "rooms and walls\nSHEET TITLE:\nFLOOR PLAN\nA2.1" },
        { pageNumber: 4, text: "FLOOR PLAN\nrooms\nFLOOR PLAN A2.2" },
      ]),
    ).toEqual([3, 4]);
  });
});

describe("extractCadDetailPages", () => {
  it("indexes marks, products, and stated hardware without inventing geometry", () => {
    const details = extractCadDetailPages([
      {
        pageNumber: 1,
        text: [
          "PV Townhomes Bldg 14-#4A",
          "6080 XO",
          "PV Townhomes Bldg 14-#4B",
          "Fixed",
          "3060",
          "Egress Hinges",
          "Lock interior and with key exterior",
          "Both side straight handle (Black)",
        ].join("\n"),
      },
    ]);

    expect(details).toEqual([
      {
        pageNumber: 1,
        marks: ["4A", "4B"],
        productCodes: ["6080 XO", "3060"],
        notes: [
          "Egress hinges",
          "Interior lock with keyed exterior",
          "Black straight handles",
        ],
      },
    ]);
  });
});
