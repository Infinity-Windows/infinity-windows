import { describe, expect, it, vi } from "vitest";
import {
  buildingMarksToDraftOpenings,
  extractBuildingMarks,
  extractScheduleRows,
  formatMarkLabel,
  matchWindowType,
  normalizeMark,
  parseScheduleRows,
  rowsToDraftOpenings,
  rowsToSpecMarks,
  type TypeCandidate,
} from "./extract";

// Column-aligned text the way pdf.js line reconstruction emits it (double
// spaces between schedule columns), based on a typical residential window
// schedule sheet.
const SCHEDULE_TEXT = `
A5.1  WINDOW SCHEDULE
MARK  TYPE  SIZE  QTY  LOCATION  REMARKS
W1  CAS3050  3'-0" x 5'-0"  2  LIVING ROOM  LOW-E, TEMPERED
W2  DH2846  2'-8" x 4'-6"  4  BEDROOM 2  EGRESS
W3  SL6040  6'-0" x 4'-0"  1  KITCHEN
A-101  PIC4060  4'-0" x 6'-0"  1  STAIRWELL  FIXED
NOTE: ALL WINDOWS U-FACTOR 0.30 MAX
SEE SHEET A5.2 FOR DOOR SCHEDULE
`;

const PIPE_TEXT = `
MARK | TYPE | QTY | LOCATION
W4 | CAS3050 | 3 | GARAGE
`;

const TYPES: TypeCandidate[] = [
  { id: "t-cas", type_code: "CAS3050", name: "Casement 30x50" },
  { id: "t-dh", type_code: "DH2846", name: "Double Hung 28x46" },
  { id: "t-sl", type_code: "SL6040", name: "Slider 60x40" },
  { id: "t-pic", type_code: "PIC4060", name: "Picture 40x60" },
];

describe("parseScheduleRows", () => {
  it("parses column-aligned schedule rows", () => {
    const rows = parseScheduleRows(SCHEDULE_TEXT);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      openingCode: "W1",
      typeText: "CAS3050",
      qty: 2,
      pageNumber: 1,
    });
    expect(rows[0].label).toContain("LIVING ROOM");
    expect(rows[1]).toMatchObject({ openingCode: "W2", typeText: "DH2846", qty: 4 });
    expect(rows[3]).toMatchObject({ openingCode: "A-101", typeText: "PIC4060", qty: 1 });
  });

  it("skips header, note, and narrative lines", () => {
    const rows = parseScheduleRows(SCHEDULE_TEXT);
    const codes = rows.map((r) => r.openingCode);
    expect(codes).not.toContain("MARK");
    expect(codes).not.toContain("NOTE");
    // The title block line "A5.1 WINDOW SCHEDULE" must not become a row.
    expect(codes).not.toContain("A5.1");
  });

  it("ignores size fields so dimensions never become types or labels", () => {
    const rows = parseScheduleRows(SCHEDULE_TEXT);
    for (const row of rows) {
      expect(row.typeText).not.toMatch(/['"x]/);
      expect(row.label ?? "").not.toMatch(/\d'/);
    }
  });

  it("parses pipe-delimited tables", () => {
    const rows = parseScheduleRows(PIPE_TEXT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openingCode: "W4", typeText: "CAS3050", qty: 3 });
  });

  it("returns nothing for prose-only pages", () => {
    expect(
      parseScheduleRows(
        "GENERAL NOTES\nAll windows shall be installed per manufacturer instructions.\nFlash sill pans before setting units.",
      ),
    ).toHaveLength(0);
  });

  it("tags rows with the page number", () => {
    const rows = parseScheduleRows("W9  DH2846  1  ATTIC", 3);
    expect(rows[0].pageNumber).toBe(3);
  });
});

describe("matchWindowType", () => {
  it("exact type code match scores 1", () => {
    const m = matchWindowType("CAS3050", TYPES);
    expect(m.type?.id).toBe("t-cas");
    expect(m.score).toBe(1);
  });

  it("matches despite dashes and case", () => {
    const m = matchWindowType("cas-3050", TYPES);
    expect(m.type?.id).toBe("t-cas");
  });

  it("matches partial / contained codes", () => {
    const m = matchWindowType("CAS3050-XL", TYPES);
    expect(m.type?.id).toBe("t-cas");
  });

  it("matches against the type name", () => {
    const m = matchWindowType("CASEMENT 30X50", TYPES);
    expect(m.type?.id).toBe("t-cas");
  });

  it("returns null below threshold instead of guessing", () => {
    const m = matchWindowType("SKYLIGHT 2020", TYPES);
    expect(m.type).toBeNull();
  });

  it("tolerates a single typo in the code", () => {
    const m = matchWindowType("DH2847", TYPES);
    expect(m.type?.id).toBe("t-dh");
  });
});

describe("rowsToDraftOpenings", () => {
  it("expands qty into numbered opening codes", () => {
    const rows = parseScheduleRows("W1  CAS3050  3  LIVING ROOM");
    const drafts = rowsToDraftOpenings(rows, TYPES);
    expect(drafts.map((d) => d.opening_code)).toEqual(["W1-1", "W1-2", "W1-3"]);
    expect(drafts.every((d) => d.window_type_id === "t-cas")).toBe(true);
  });

  it("keeps single-qty codes as-is and carries labels", () => {
    const drafts = rowsToDraftOpenings(parseScheduleRows(SCHEDULE_TEXT), TYPES);
    const w3 = drafts.find((d) => d.opening_code === "W3");
    expect(w3).toBeDefined();
    expect(w3!.window_type_id).toBe("t-sl");
    expect(w3!.label).toContain("KITCHEN");
  });

  it("leaves unmatched types null for human review", () => {
    const drafts = rowsToDraftOpenings(
      parseScheduleRows("W8  AWN9999  1  BATH"),
      TYPES,
    );
    expect(drafts[0].window_type_id).toBeNull();
    expect(drafts[0].type_text).toBe("AWN9999");
  });
});

describe("hash marks (#14)", () => {
  it("normalizes and formats mark labels", () => {
    expect(normalizeMark("#14")).toBe("14");
    expect(normalizeMark("14")).toBe("14");
    expect(formatMarkLabel("14")).toBe("#14");
    expect(formatMarkLabel("W1")).toBe("W1");
  });

  it("parses #14 schedule rows with size and color", () => {
    const text = `
MARK  SIZE  TYPE  COLOR  QTY
#14  4'-0" x 5'-0"  CASEMENT  WHITE  1
#6  3x5  DOOR  BLACK  2
`;
    const rows = parseScheduleRows(text);
    expect(rows.some((r) => r.openingCode === "14")).toBe(true);
    const door = rows.find((r) => r.openingCode === "6");
    expect(door?.unitKind).toBe("door");
    const marks = rowsToSpecMarks(rows, TYPES);
    expect(marks.find((m) => m.mark === "14")?.size_text).toMatch(/4/);
  });

  it("extracts building-plan mark hits with pins", () => {
    const hits = extractBuildingMarks([
      {
        pageNumber: 1,
        width: 100,
        height: 100,
        fragments: [
          { text: "#14", x: 10, y: 80, width: 10, height: 8 },
          { text: "#14", x: 12, y: 81, width: 10, height: 8 }, // near-dupe
          { text: "#6", x: 70, y: 20, width: 8, height: 8 },
        ],
      },
    ]);
    expect(hits).toHaveLength(2);
    const drafts = buildingMarksToDraftOpenings(hits, [
      {
        mark: "14",
        type_text: "CASEMENT",
        size_text: "4x5",
        color_text: "WHITE",
        unit_kind: "window",
        window_type_id: "t-cas",
        match_score: 1,
      },
    ]);
    expect(drafts.map((d) => d.opening_code)).toEqual(["#14-1", "#6-1"]);
    expect(drafts[0].window_type_id).toBe("t-cas");
    expect(drafts[0].pin_x).toBeGreaterThan(0);
  });
});

describe("extractScheduleRows", () => {
  it("uses deterministic rows when present and skips AI", async () => {
    const ai = vi.fn(async () => [
      {
        openingCode: "X1",
        typeText: "CAS3050",
        qty: 1,
        label: null,
        pageNumber: 1,
      },
    ]);
    const result = await extractScheduleRows(
      [{ pageNumber: 1, text: SCHEDULE_TEXT }],
      ai,
    );
    expect(result.source).toBe("deterministic");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(ai).not.toHaveBeenCalled();
  });

  it("falls back to AI when deterministic finds nothing", async () => {
    const ai = vi.fn(async () => [
      {
        openingCode: "W9",
        typeText: "CAS3050",
        qty: 1,
        label: "DEN",
        pageNumber: 1,
      },
    ]);
    const result = await extractScheduleRows(
      [{ pageNumber: 1, text: "NO SCHEDULE HERE JUST NOTES" }],
      ai,
    );
    expect(result.source).toBe("ai");
    expect(result.rows).toHaveLength(1);
    expect(ai).toHaveBeenCalledOnce();
  });
});
