import { describe, expect, it } from "vitest";
import { rowsToDraftOpenings } from "./extract";
import {
  calloutsOnFloorPlanSheets,
  splitCalloutsByFloorPlan,
  countPlanMarkCallouts,
  extractCadDetailPages,
  findFloorPlanPages,
  isElevationSheet,
  mergePageLists,
  mergeScheduleWithDetailRows,
  parseCadDetailScheduleRows,
  parseDetailQty,
} from "./planDetails";

// Verbatim lines from the two live jobs. Black Desert (Strata/STG) writes glass
// notes with a hash; Smith (PV Townhomes) writes real marks as a hyphen-attached
// job-code suffix. Reading the first kind as marks invented two openings on a
// job that has none, so both stay pinned here as fixtures.
const BLACK_DESERT_PROSE = [
  "596(23 2 \")  292(11 2 \")",
  "Obscure Glass #17",
  "Obscure Glass #3",
  "3 Point Lock",
  "#17 Glass Obscure  outside  outside",
  "#3 Glass Obscure  outside",
].join("\n");

const SMITH_DETAIL = [
  "PV Townhomes Bldg 14-#4A",
  "6080 XO",
  "PV Townhomes Bldg 14-#4B",
  "Fixed",
  "NO: PV Townhomes Bldg 14-#6",
  "QTY: 12",
].join("\n");

describe("mark callout recognition", () => {
  it("ignores Black Desert's glass notes, whichever side the hash sits on", () => {
    expect(countPlanMarkCallouts(BLACK_DESERT_PROSE)).toBe(0);
  });

  it("keeps Smith's hyphen-attached job-code marks", () => {
    expect(countPlanMarkCallouts(SMITH_DETAIL)).toBe(3);
    expect(
      parseCadDetailScheduleRows([{ pageNumber: 1, text: SMITH_DETAIL }]).map(
        (r) => r.openingCode,
      ),
    ).toEqual(["4A", "4B", "6"]);
  });

  it("keeps a bare callout line that is nothing but marks", () => {
    expect(countPlanMarkCallouts("#4A #4B #13A #13B #18A #18B")).toBe(6);
    expect(countPlanMarkCallouts("#13B")).toBe(1);
    expect(countPlanMarkCallouts("#4A, #4B")).toBe(2);
  });

  // The Mad Moose incident (2026-09-01): an addendum cut sheet's "NO: Mad
  // Moose Add-#1/#2/#3" callouts read the SAME hyphen-attached shape as
  // Smith's "Bldg 14-#4A" — but "Bldg 14" is a numeric job/building code
  // (correctly dropped: the mark repeats across buildings), while "Add" is
  // the addendum sheet's own word identifying these marks. Stripping it the
  // same way collided the addendum's #1/#2/#3 with the job's real marks
  // 1/2/3. A run of LETTERS immediately before the dash must survive.
  it("keeps an addendum sheet's own word prefix, unlike a numeric job code", () => {
    const MAD_MOOSE_ADDENDUM = [
      "NO: Mad Moose Add-#1",
      "QTY: 1",
      "NO: Mad Moose Add-#2",
      "QTY: 1",
      "NO: Mad Moose Add-#3",
      "QTY: 1",
    ].join("\n");
    expect(
      parseCadDetailScheduleRows([{ pageNumber: 1, text: MAD_MOOSE_ADDENDUM }]).map(
        (r) => r.openingCode,
      ),
    ).toEqual(["Add-1", "Add-2", "Add-3"]);
  });

  it("does not turn Black Desert's spec sheet into openings", () => {
    expect(
      parseCadDetailScheduleRows([
        { pageNumber: 3, text: BLACK_DESERT_PROSE },
      ]),
    ).toEqual([]);
  });

  it("ignores a hash buried in any other prose", () => {
    expect(countPlanMarkCallouts("See detail #5 on the sheet above")).toBe(0);
    expect(countPlanMarkCallouts("Sill Pan #2 Aluminum")).toBe(0);
  });
});

// Verbatim from Black Desert's plan set as pdf.js reads it. Page 1 is A.102
// MAIN LvL FLOOR PLAN; pages 2–4 are A.201–A.203 EXTERIOR ELEVATIONS, which
// re-number the same 42 openings 57 more times.
const BLACK_DESERT_FLOOR_SHEET = [
  "MAIN LvL FLOOR PLAN  35  36  8",
  "FLOOR PLAN KEYED NOTES :",
  "36.WINDOW. SEE WINDOW SCHEDULE FOR STYLE, AND OPERATION. VERIFY W/ THE",
  "EXTERIOR ELEVATION FOR THE SILL HEIGHT.",
  "A.102  FLOOR PLAN  COPYRIGHT 2025 ROUGE DESIGNS LLC",
].join("\n");

const BLACK_DESERT_ELEVATION_SHEET = [
  "ELEVATION MATERIAL LEGEND :",
  "EXTERIOR ELEVATION GENERAL NOTES :",
  "ELEVATION HEIGHT NOTES :",
  "*ARCHITECTURAL + 0'-0\" ELEVATION = SURVEY ELEVATION",
  "*FOUNDATION ELEVATION ARE RELATIVE TO ARCHITECTURAL MAIN FLOOR",
  "19'-0\"  OVERALL HEIGHT( 19FT MAX HEIGHT )",
  "FRONT ELEVATION - SOUTH  1/8\" = 1'-0\"",
  "RIGHT ELEVATION - EAST  1/8\" = 1'-0\"",
  "A.201  EXTERIOR  ELEVATIONS",
].join("\n");

describe("isElevationSheet", () => {
  it("reads Black Desert's elevation sheets as elevations, not floor drawings", () => {
    expect(isElevationSheet(BLACK_DESERT_ELEVATION_SHEET)).toBe(true);
    expect(isElevationSheet(BLACK_DESERT_FLOOR_SHEET)).toBe(false);
  });

  // The floor plan's own keyed notes say "VERIFY W/ THE EXTERIOR ELEVATION" and
  // the elevation sheets say "FOUNDATION ELEVATION ARE RELATIVE TO…". Neither is
  // a drawing title, so neither may decide this.
  it("is not fooled by the word elevation in prose", () => {
    expect(
      isElevationSheet(
        "SEE WINDOW SCHEDULE FOR STYLE. VERIFY W/ THE EXTERIOR ELEVATION FOR THE SILL HEIGHT.",
      ),
    ).toBe(false);
    expect(
      isElevationSheet("*FOUNDATION ELEVATION ARE RELATIVE TO ARCHITECTURAL"),
    ).toBe(false);
  });

  // Smith's marked plan has no extractable text at all — every number on it is a
  // FreeText annotation. A page we know nothing about is never thrown away.
  it("keeps a page with no readable text", () => {
    expect(isElevationSheet("")).toBe(false);
  });
});

describe("calloutsOnFloorPlanSheets", () => {
  it("counts Black Desert's openings once, on the floor plan", () => {
    const callouts = [
      ...Array.from({ length: 42 }, () => ({ pageNumber: 1 })),
      ...Array.from({ length: 28 }, () => ({ pageNumber: 2 })),
      ...Array.from({ length: 22 }, () => ({ pageNumber: 3 })),
      ...Array.from({ length: 7 }, () => ({ pageNumber: 4 })),
    ];
    const pages = [
      { pageNumber: 1, text: BLACK_DESERT_FLOOR_SHEET },
      { pageNumber: 2, text: BLACK_DESERT_ELEVATION_SHEET },
      { pageNumber: 3, text: BLACK_DESERT_ELEVATION_SHEET },
      { pageNumber: 4, text: BLACK_DESERT_ELEVATION_SHEET },
    ];
    expect(callouts).toHaveLength(99);
    expect(calloutsOnFloorPlanSheets(callouts, pages)).toHaveLength(42);
  });

  it("leaves Smith's textless marked plan untouched", () => {
    const callouts = [
      ...Array.from({ length: 34 }, () => ({ pageNumber: 3 })),
      ...Array.from({ length: 30 }, () => ({ pageNumber: 4 })),
    ];
    const pages = [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, text: "" }));
    expect(calloutsOnFloorPlanSheets(callouts, pages)).toHaveLength(64);
  });

  it("keeps every callout rather than return none", () => {
    const callouts = [{ pageNumber: 1 }, { pageNumber: 2 }];
    const pages = [1, 2].map((pageNumber) => ({
      pageNumber,
      text: BLACK_DESERT_ELEVATION_SHEET,
    }));
    expect(calloutsOnFloorPlanSheets(callouts, pages)).toHaveLength(2);
  });
});

// The elevation reference is built from the other half of this split. These
// guarantee the reference can never feed the opening count, however either side
// changes.
describe("splitCalloutsByFloorPlan", () => {
  const BLACK_DESERT = {
    callouts: [
      ...Array.from({ length: 42 }, (_, i) => ({ pageNumber: 1, id: `p1-${i}` })),
      ...Array.from({ length: 28 }, (_, i) => ({ pageNumber: 2, id: `p2-${i}` })),
      ...Array.from({ length: 22 }, (_, i) => ({ pageNumber: 3, id: `p3-${i}` })),
      ...Array.from({ length: 7 }, (_, i) => ({ pageNumber: 4, id: `p4-${i}` })),
    ],
    pages: [
      { pageNumber: 1, text: BLACK_DESERT_FLOOR_SHEET },
      { pageNumber: 2, text: BLACK_DESERT_ELEVATION_SHEET },
      { pageNumber: 3, text: BLACK_DESERT_ELEVATION_SHEET },
      { pageNumber: 4, text: BLACK_DESERT_ELEVATION_SHEET },
    ],
  };

  it("splits Black Desert 42 / 57", () => {
    const split = splitCalloutsByFloorPlan(BLACK_DESERT.callouts, BLACK_DESERT.pages);
    expect(split.planCallouts).toHaveLength(42);
    expect(split.repeatViewCallouts).toHaveLength(57);
  });

  it("never lets one callout be both an opening and a reference", () => {
    const split = splitCalloutsByFloorPlan(BLACK_DESERT.callouts, BLACK_DESERT.pages);
    const counted = new Set(split.planCallouts.map((c) => c.id));
    expect(split.repeatViewCallouts.some((c) => counted.has(c.id))).toBe(false);
    expect(split.planCallouts.length + split.repeatViewCallouts.length).toBe(
      BLACK_DESERT.callouts.length,
    );
  });

  it("gives Smith's textless plan no reference callouts at all", () => {
    // No positive evidence of an elevation anywhere, so all 105 stay openings
    // and there is nothing to build a reference from.
    const callouts = Array.from({ length: 105 }, (_, i) => ({
      pageNumber: (i % 4) + 1,
      id: `c-${i}`,
    }));
    const split = splitCalloutsByFloorPlan(
      callouts,
      [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, text: "" })),
    );
    expect(split.planCallouts).toHaveLength(105);
    expect(split.repeatViewCallouts).toEqual([]);
  });

  it("builds no reference when that would cost the job its openings", () => {
    // Every page reads as an elevation. Keeping the openings wins, and the
    // reference gets nothing rather than the count getting emptied.
    const split = splitCalloutsByFloorPlan(
      [{ pageNumber: 1, id: "a" }, { pageNumber: 2, id: "b" }],
      [1, 2].map((pageNumber) => ({
        pageNumber,
        text: BLACK_DESERT_ELEVATION_SHEET,
      })),
    );
    expect(split.planCallouts).toHaveLength(2);
    expect(split.repeatViewCallouts).toEqual([]);
  });

  it("is stable when run again — re-extracting cannot grow either side", () => {
    const once = splitCalloutsByFloorPlan(BLACK_DESERT.callouts, BLACK_DESERT.pages);
    const twice = splitCalloutsByFloorPlan(BLACK_DESERT.callouts, BLACK_DESERT.pages);
    expect(twice.planCallouts.map((c) => c.id)).toEqual(
      once.planCallouts.map((c) => c.id),
    );
    expect(twice.repeatViewCallouts.map((c) => c.id)).toEqual(
      once.repeatViewCallouts.map((c) => c.id),
    );
  });
});

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

  it("does not call a marked-up elevation sheet a numbered floor drawing", () => {
    const pages = [
      { pageNumber: 1, text: BLACK_DESERT_FLOOR_SHEET },
      { pageNumber: 2, text: BLACK_DESERT_ELEVATION_SHEET },
      { pageNumber: 3, text: BLACK_DESERT_ELEVATION_SHEET },
      { pageNumber: 4, text: BLACK_DESERT_ELEVATION_SHEET },
    ];
    const callouts = [
      ...Array.from({ length: 42 }, () => ({ pageNumber: 1 })),
      ...Array.from({ length: 28 }, () => ({ pageNumber: 2 })),
      ...Array.from({ length: 22 }, () => ({ pageNumber: 3 })),
      ...Array.from({ length: 7 }, () => ({ pageNumber: 4 })),
    ];
    expect(findFloorPlanPages(pages, callouts)).toEqual([1]);
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

describe("mergePageLists", () => {
  it("adds the page a job's marks are actually on", () => {
    // Oakridge: marks on page 1, detected floor sheets 3 and 4.
    expect(mergePageLists([3, 4], [1], 6)).toEqual([1, 3, 4]);
  });

  it("keeps detected sheets that have no marks yet", () => {
    expect(mergePageLists([2, 3], [], 6)).toEqual([2, 3]);
  });

  it("does not repeat a page that is in both lists", () => {
    expect(mergePageLists([1, 2], [1, 2], 4)).toEqual([1, 2]);
  });

  it("offers every page when nothing is known", () => {
    expect(mergePageLists([], [], 3)).toEqual([1, 2, 3]);
  });

  it("survives a planset whose page count is unknown", () => {
    expect(mergePageLists([], [], 0)).toEqual([]);
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

  // Black Desert's 14 spec pages don't use "#4A" marks or Smith's five hardware
  // phrases, so the text rules kept 3 of them — while 37 specs had already been
  // read off 11. The specs themselves are the evidence.
  it("keeps a page the extraction pulled specs from, whatever its wording", () => {
    const pages = [
      { pageNumber: 1, text: "Thermal Break Aluminum Fixed Window" },
      { pageNumber: 2, text: "Outside View  Obscure Glass" },
      { pageNumber: 3, text: "revision history" },
    ];
    expect(extractCadDetailPages(pages)).toEqual([]);
    expect(
      extractCadDetailPages(pages, [
        { mark_code: "1", image_page: 1 },
        { mark_code: "2", image_page: 1 },
        { mark_code: "10", image_page: 2 },
        { mark_code: "9", image_page: 2 },
        { mark_code: "25", image_page: null },
      ]),
    ).toEqual([
      { pageNumber: 1, marks: ["1", "2"], productCodes: [], notes: [] },
      { pageNumber: 2, marks: ["9", "10"], productCodes: [], notes: [] },
    ]);
  });

  it("merges spec marks with marks written on the sheet", () => {
    expect(
      extractCadDetailPages(
        [{ pageNumber: 4, text: "PV Townhomes Bldg 14-#4A\n6080 XO" }],
        [
          { mark_code: "#4A", image_page: 4 },
          { mark_code: "4B", image_page: 4 },
        ],
      ),
    ).toEqual([
      {
        pageNumber: 4,
        marks: ["4A", "4B"],
        productCodes: ["6080 XO"],
        notes: [],
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

  it("a weak bare-number schedule row defers to detail sheets entirely", () => {
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

  it("an explicit schedule QTY stands even when detail pages count higher (ESH-18 lesson)", () => {
    // Elevation/detail noise counted mark W2 nine times; the schedule table
    // says 3. The explicit QTY field is authoritative — noise never wins.
    const merged = mergeScheduleWithDetailRows(
      [
        {
          openingCode: "W2",
          typeText: "DH2846",
          qty: 3,
          label: null,
          pageNumber: 1,
          widthIn: 32,
          heightIn: 54,
          color: null,
          kind: "window",
        },
      ],
      [
        {
          openingCode: "W2",
          typeText: "DH2846",
          qty: 9,
          label: null,
          pageNumber: 4,
          widthIn: null,
          heightIn: null,
          color: null,
          kind: "window",
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(3);
  });
});
