import { describe, expect, it } from "vitest";
import { rowsToDraftOpenings } from "./extract";
import {
  extractCadDetailPages,
  findFloorPlanPages,
  mergeScheduleWithDetailRows,
  parseCadDetailScheduleRows,
  parseDetailQty,
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

  // Black Desert's plan carries all 96 of its marks as FreeText annotations,
  // which getTextContent never returns. Scoring on page text alone reported
  // "1 numbered floor drawing" for a four-page marked-up plan.
  it("counts marks that live in annotations, not just page text", () => {
    const pages = [
      { pageNumber: 1, text: "FLOOR PLAN\nrooms\nFLOOR PLAN" },
      { pageNumber: 2, text: "elevation details" },
      { pageNumber: 3, text: "elevation details" },
    ];
    // Mirrors Black Desert: every page is marked, page 1 also says FLOOR PLAN.
    const callouts = [
      ...Array.from({ length: 42 }, () => ({ pageNumber: 1 })),
      ...Array.from({ length: 28 }, () => ({ pageNumber: 2 })),
      ...Array.from({ length: 22 }, () => ({ pageNumber: 3 })),
    ];
    expect(findFloorPlanPages(pages)).toEqual([1]);
    expect(findFloorPlanPages(pages, callouts)).toEqual([1, 2, 3]);
  });

  it("leaves a text-marked plan's page order alone", () => {
    const pages = [
      { pageNumber: 3, text: "SHEET TITLE:\nFLOOR PLAN\n#4A #4B\nFLOOR PLAN A2.1" },
      { pageNumber: 4, text: "FLOOR PLAN\nrooms\nFLOOR PLAN A2.2" },
    ];
    expect(findFloorPlanPages(pages)).toEqual([3, 4]);
    expect(findFloorPlanPages(pages, [{ pageNumber: 4 }])).toEqual([3, 4]);
  });

  it("ignores callouts on pages that were not supplied", () => {
    expect(
      findFloorPlanPages([{ pageNumber: 1, text: "FLOOR PLAN\nFLOOR PLAN" }], [
        { pageNumber: 9 },
      ]),
    ).toEqual([1]);
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

describe("parseDetailQty", () => {
  it("reads labeled QTY from manufacturer detail tables", () => {
    expect(parseDetailQty("\nQTY: 12\nstyle: Fixed Window")).toBe(12);
    expect(parseDetailQty("QUANTITY 8\nGlass: Low-E")).toBe(8);
    expect(parseDetailQty("QTY\n12\nstyle: Fixed")).toBe(12);
    expect(parseDetailQty("3070\nFixed")).toBe(1);
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

  it("uses detail-sheet QTY so #6 with quantity 12 becomes twelve openings", () => {
    const rows = parseCadDetailScheduleRows([
      {
        pageNumber: 2,
        text: [
          "NO: PV Townhomes Bldg 14-#6",
          "QTY: 12",
          "style: Thermal Break Aluminum Fixed Window(Nail Fins)",
          "3070",
          "Glass: 5(Low-E 366)+12A+5(Low-E 366)",
          "color: Black(Aluminum profile Color)",
        ].join("\n"),
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      openingCode: "6",
      typeText: "3070",
      qty: 12,
      kind: "window",
    });

    const drafts = rowsToDraftOpenings(rows, []);
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

  it("keeps the larger quantity when schedule and detail disagree", () => {
    const merged = mergeScheduleWithDetailRows(
      [
        {
          openingCode: "6",
          typeText: "3070",
          qty: 1,
          label: null,
          pageNumber: 1,
          widthIn: 36,
          heightIn: 84,
          color: null,
          kind: "window",
        },
      ],
      [
        {
          openingCode: "6",
          typeText: "3070",
          qty: 12,
          label: null,
          pageNumber: 2,
          widthIn: 36,
          heightIn: 84,
          color: null,
          kind: "window",
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(12);
  });
});
