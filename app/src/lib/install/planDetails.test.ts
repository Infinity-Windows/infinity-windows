import { describe, expect, it } from "vitest";
import {
  extractCadDetailPages,
  findFloorPlanPages,
  mergeScheduleWithDetailRows,
  parseCadDetailScheduleRows,
} from "./planDetails";

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

  it("prefers the floor sheet that already has numbered opening callouts", () => {
    expect(
      findFloorPlanPages([
        {
          pageNumber: 2,
          text: "SHEET TITLE:\nFLOOR PLAN\nmostly empty rooms",
        },
        {
          pageNumber: 3,
          text: [
            "SHEET TITLE:",
            "FLOOR PLAN",
            "#4A #4B #13A #13B #18A #18B",
            "FLOOR PLAN A2.1",
          ].join("\n"),
        },
      ]),
    ).toEqual([3, 2]);
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

describe("parseCadDetailScheduleRows", () => {
  it("turns each #mark on a manufacturer sheet into a schedule row", () => {
    const rows = parseCadDetailScheduleRows([
      {
        pageNumber: 1,
        text: [
          "PV Townhomes Bldg 14-#4A",
          "6080 XO",
          "Egress Hinges",
          "PV Townhomes Bldg 14-#4B",
          "Fixed",
          "3060",
        ].join("\n"),
      },
      {
        pageNumber: 4,
        text: ["PV Townhomes Bldg 14-#13A", "8080 XO", "#13B", "3060 FIXED"].join(
          "\n",
        ),
      },
    ]);

    expect(rows.map((r) => r.openingCode)).toEqual(["4A", "4B", "13A", "13B"]);
    expect(rows.find((r) => r.openingCode === "4A")).toMatchObject({
      typeText: "6080 XO",
      kind: "door",
      widthIn: 72,
      heightIn: 96,
      pageNumber: 1,
    });
    expect(rows.find((r) => r.openingCode === "4B")).toMatchObject({
      typeText: "3060",
      kind: "window",
      widthIn: 36,
      heightIn: 72,
    });
    expect(rows.find((r) => r.openingCode === "13A")?.kind).toBe("door");
  });
});

describe("mergeScheduleWithDetailRows", () => {
  it("keeps schedule rows and fills missing detail marks", () => {
    const merged = mergeScheduleWithDetailRows(
      [
        {
          openingCode: "W1",
          typeText: "CAS3050",
          qty: 2,
          label: "LIVING",
          pageNumber: 1,
          widthIn: 36,
          heightIn: 60,
          color: null,
          kind: "window",
        },
      ],
      [
        {
          openingCode: "4A",
          typeText: "6080 XO",
          qty: 1,
          label: null,
          pageNumber: 2,
          widthIn: 72,
          heightIn: 96,
          color: null,
          kind: "door",
        },
        {
          openingCode: "W1",
          typeText: "IGNORED",
          qty: 1,
          label: null,
          pageNumber: 2,
          widthIn: null,
          heightIn: null,
          color: null,
          kind: "window",
        },
      ],
    );
    expect(merged.map((r) => r.openingCode)).toEqual(["4A", "W1"]);
    expect(merged.find((r) => r.openingCode === "W1")?.qty).toBe(2);
  });
});
