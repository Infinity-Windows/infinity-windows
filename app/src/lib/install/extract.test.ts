import { describe, expect, it, vi } from "vitest";
import {
  describeMarkCount,
  extractScheduleRows,
  matchWindowType,
  parseScheduleRows,
  planDraftPersistence,
  rowsToDraftOpenings,
  summarizeExtractOutcome,
  unionScheduleRows,
  type DraftOpening,
  type ExistingOpeningLite,
  type ScheduleRow,
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

  it("parses #14-style numeric marks and 4x5 sizes as feet", () => {
    const rows = parseScheduleRows(`
MARK  SIZE  QTY  TYPE  COLOR
#14  4x5  3  CASEMENT  WHITE
#6  3'-0" x 4'-0"  2  DOOR  BRONZE
`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const fourteen = rows.find((r) => r.openingCode === "14");
    expect(fourteen).toMatchObject({
      qty: 3,
      widthIn: 48,
      heightIn: 60,
      color: "WHITE",
      kind: "window",
    });
    const six = rows.find((r) => r.openingCode === "6");
    expect(six).toMatchObject({
      qty: 2,
      kind: "door",
      color: "BRONZE",
    });
    expect(six?.widthIn).toBe(36);
    expect(six?.heightIn).toBe(48);
  });
});

describe("parseSizeInches", () => {
  it("reads feet-inch and bare 4x5", async () => {
    const { parseSizeInches } = await import("./extract");
    expect(parseSizeInches(`3'-0" x 5'-0"`)).toEqual({ widthIn: 36, heightIn: 60 });
    expect(parseSizeInches("4x5")).toEqual({ widthIn: 48, heightIn: 60 });
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
    expect(drafts.every((d) => d.mark_code === "W1")).toBe(true);
  });

  it("keeps #14 as the type mark across instances", () => {
    const drafts = rowsToDraftOpenings(
      parseScheduleRows("#14  CASEMENT  4x5  2  WHITE"),
      TYPES,
    );
    expect(drafts.map((d) => d.opening_code)).toEqual(["14-1", "14-2"]);
    expect(drafts.every((d) => d.mark_code === "14")).toBe(true);
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

describe("extractScheduleRows", () => {
  it("uses deterministic rows when present and skips AI", async () => {
    const ai = vi.fn(async () => [
      {
        openingCode: "X1",
        typeText: "CAS3050",
        qty: 1,
        label: null,
        pageNumber: 1,
        widthIn: null,
        heightIn: null,
        color: null,
        kind: "window" as const,
      },
    ]);
    const result = await extractScheduleRows(
      [{ pageNumber: 1, text: SCHEDULE_TEXT }],
      ai,
    );
    expect(["deterministic", "merged"]).toContain(result.source);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(ai).not.toHaveBeenCalled();
  });

  it("builds openings from manufacturer detail marks when no schedule exists", async () => {
    const ai = vi.fn(async () => []);
    const result = await extractScheduleRows(
      [
        {
          pageNumber: 1,
          text: "PV Townhomes Bldg 14-#4A\n6080 XO\n#4B\n3060 FIXED",
        },
      ],
      ai,
    );
    expect(result.source).toBe("details");
    expect(result.rows.map((r) => r.openingCode).sort()).toEqual(["4A", "4B"]);
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
        widthIn: null,
        heightIn: null,
        color: null,
        kind: "window" as const,
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

  it("reconciles AI with deterministic when the result looks low", async () => {
    const ai = vi.fn(async () => [
      // AI finds an extra mark the deterministic pass missed, plus a higher
      // qty for W1 — neither should be lost.
      { openingCode: "W1", typeText: "CAS3050", qty: 5, label: null, pageNumber: 1, widthIn: null, heightIn: null, color: null, kind: "window" as const },
      { openingCode: "W9", typeText: "DH2846", qty: 3, label: null, pageNumber: 1, widthIn: null, heightIn: null, color: null, kind: "window" as const },
    ]);
    const result = await extractScheduleRows(
      [{ pageNumber: 1, text: "W1  CAS3050  2  LIVING" }],
      ai,
      { aiWhenBelow: 5 },
    );
    expect(ai).toHaveBeenCalledOnce();
    const w1 = result.rows.find((r) => r.openingCode === "W1");
    const w9 = result.rows.find((r) => r.openingCode === "W9");
    expect(w1?.qty).toBe(5); // larger qty wins
    expect(w9).toBeDefined(); // AI-only mark is kept
  });

  it("does not call AI when merged rows exceed the low-water mark", async () => {
    const ai = vi.fn(async () => []);
    const result = await extractScheduleRows(
      [{ pageNumber: 1, text: SCHEDULE_TEXT }],
      ai,
      { aiWhenBelow: 2 },
    );
    expect(ai).not.toHaveBeenCalled();
    expect(result.rows.length).toBeGreaterThan(2);
  });
});

// A schedule whose per-mark quantities sum to 105 openings (mirrors the real
// Smith Residence / Pecan Valley building count). Guards against ever again
// collapsing multi-quantity marks down to one opening each.
const MULTI_QTY_SCHEDULE = `
WINDOW & DOOR SCHEDULE
MARK  TYPE  SIZE  QTY  LOCATION
#14  CAS3050  3'-0" x 5'-0"  25  LIVING ROOM
#17  DH2846  2'-8" x 4'-6"  16  BEDROOMS
#6   SL6040  6'-0" x 4'-0"  12  KITCHEN
#11  PIC4060  4'-0" x 6'-0"  5   STAIR
#12  CAS3050  3'-0" x 5'-0"  5   BATH
#19  DH2846  2'-8" x 4'-6"  4   LOFT
#20  SL6040  6'-0" x 4'-0"  4   DINING
#21  PIC4060  4'-0" x 6'-0"  4   ENTRY
#4   ENTRY DOOR  3'-0" x 8'-0"  30  UNIT ENTRY
`;

describe("quantity expansion (sums, not counts)", () => {
  it("reads inline 'QTY N' data rows that used to be dropped as headers", () => {
    const rows = parseScheduleRows("#14  CAS3050  QTY 3  LIVING ROOM");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openingCode: "14", typeText: "CAS3050", qty: 3 });
    expect(rows[0].label ?? "").not.toMatch(/QTY/i);
  });

  it("reads explicit qty markers: (N), xN, N EA", () => {
    expect(parseScheduleRows("W1  CAS3050  (7)  DEN")[0].qty).toBe(7);
    expect(parseScheduleRows("W2  DH2846  x12  HALL")[0].qty).toBe(12);
    expect(parseScheduleRows("W3  SL6040  9 EA  SHOP")[0].qty).toBe(9);
  });

  it("expands a realistic multi-mark schedule to 105 openings", () => {
    const rows = parseScheduleRows(MULTI_QTY_SCHEDULE);
    expect(rows).toHaveLength(9);
    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
    expect(totalQty).toBe(105);

    const drafts = rowsToDraftOpenings(rows, []);
    expect(drafts).toHaveLength(105);
    // Each mark expands into individually numbered instances.
    expect(drafts.filter((d) => d.mark_code === "14")).toHaveLength(25);
    expect(drafts.filter((d) => d.mark_code === "4")).toHaveLength(30);
    expect(drafts.find((d) => d.opening_code === "14-25")).toBeDefined();
    expect(drafts.find((d) => d.mark_code === "4")?.kind).toBe("door");
  });
});

describe("unionScheduleRows", () => {
  const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
    openingCode: "W1",
    typeText: "W1",
    qty: 1,
    label: null,
    pageNumber: 1,
    widthIn: null,
    heightIn: null,
    color: null,
    kind: "window",
    ...over,
  });

  it("keeps every mark and prefers the larger quantity + richer product", () => {
    const merged = unionScheduleRows(
      [row({ openingCode: "14", typeText: "14", qty: 2 })],
      [
        row({ openingCode: "14", typeText: "CAS3050", qty: 5 }),
        row({ openingCode: "22", typeText: "DH2846", qty: 3 }),
      ],
    );
    const fourteen = merged.find((r) => r.openingCode === "14");
    expect(fourteen?.qty).toBe(5);
    expect(fourteen?.typeText).toBe("CAS3050");
    expect(merged.find((r) => r.openingCode === "22")).toBeDefined();
  });
});

describe("planDraftPersistence (per-slot re-extract, root-cause fix)", () => {
  const draft = (code: string, kind: "window" | "door" = "window"): DraftOpening => ({
    opening_code: code,
    window_type_id: null,
    type_text: code,
    match_score: 0,
    label: null,
    page_number: 3,
    mark_code: code.replace(/-\d+$/, ""),
    width_in: null,
    height_in: null,
    color: null,
    kind,
    pin_x: 0.5,
    pin_y: 0.5,
  });

  const existing = (
    code: string,
    kind: "building" | "specs",
    over: Partial<ExistingOpeningLite> = {},
  ): ExistingOpeningLite => ({
    id: `${kind}:${code}`,
    opening_code: code,
    confirmed: false,
    status: "planned",
    pin_x: null,
    pin_y: null,
    page_number: 3,
    planset_kind: kind,
    ...over,
  });

  it("uploading specs does NOT wipe building-plan openings (105 stays 105)", () => {
    // 105 building openings already exist; the specs sheet lists 6 detail marks.
    const building = ["14-1", "14-2", "6-1", "4A", "18B-1", "13A-1"].map((c) =>
      existing(c, "building"),
    );
    const specsDrafts = ["4A", "18B", "13A"].map((c) => draft(c));

    const plan = planDraftPersistence(building, specsDrafts, "specs");
    // Nothing building is deleted.
    expect(plan.deleteIds).toHaveLength(0);
    // Specs marks already owned by the building plan are not duplicated.
    expect(plan.inserts).toHaveLength(0);
    expect(plan.skipped).toBe(3);
  });

  it("re-uploading the SAME kind replaces its own unconfirmed drafts", () => {
    const prior = [existing("14-1", "building"), existing("6-1", "building")];
    const plan = planDraftPersistence(prior, [draft("14-1"), draft("9-1")], "building");
    expect(plan.deleteIds.sort()).toEqual(["building:14-1", "building:6-1"].sort());
    expect(plan.inserts.map((d) => d.opening_code).sort()).toEqual(["14-1", "9-1"]);
  });

  it("never deletes or overwrites confirmed / in-progress openings", () => {
    const prior = [
      existing("14-1", "building", { confirmed: true }),
      existing("6-1", "building", { status: "assigned" }),
      existing("7-1", "building"),
    ];
    const plan = planDraftPersistence(prior, [draft("14-1"), draft("7-1")], "building");
    expect(plan.deleteIds).toEqual(["building:7-1"]);
    // Confirmed 14-1 blocks re-inserting that code.
    expect(plan.inserts.map((d) => d.opening_code)).toEqual(["7-1"]);
  });

  it("building plan supersedes unconfirmed specs-only openings for its marks", () => {
    const prior = [existing("4A", "specs"), existing("99", "specs")];
    const plan = planDraftPersistence(prior, [draft("4A"), draft("14-1")], "building");
    // The specs 4A is superseded by the authoritative building plan.
    expect(plan.deleteIds).toContain("specs:4A");
    expect(plan.deleteIds).not.toContain("specs:99");
    expect(plan.inserts.map((d) => d.opening_code).sort()).toEqual(["14-1", "4A"]);
  });

  it("preserves manual pins across a same-kind re-extract", () => {
    const prior = [
      existing("14-1", "building", { pin_x: 0.2, pin_y: 0.3, page_number: 4 }),
    ];
    const plan = planDraftPersistence(prior, [draft("14-1")], "building");
    expect(plan.inserts[0]).toMatchObject({ pin_x: 0.2, pin_y: 0.3, page_number: 4 });
  });

  // `confirmed || status !== 'planned'` is not the whole picture. Several RPCs
  // record real field work WITHOUT moving either flag, and one of them —
  // undo_install — actively resets an installed opening back to
  // planned/unconfirmed while deliberately KEEPING the install event. Deleting
  // that row cascades the install event and the QC check away with it.
  describe("field work is never deleted by a re-extract", () => {
    it("keeps an opening someone has measured (set_opening_rough_opening)", () => {
      const prior = [existing("14-1", "building", { ro_width_in: 35.5, ro_height_in: 60 })];
      const plan = planDraftPersistence(prior, [draft("14-1")], "building");
      expect(plan.deleteIds).toEqual([]);
    });

    it("keeps an opening whose arrival condition was checked", () => {
      const prior = [existing("14-1", "building", { condition: "damaged" })];
      const plan = planDraftPersistence(prior, [draft("14-1")], "building");
      expect(plan.deleteIds).toEqual([]);
    });

    it("keeps an opening dispatched to an installer", () => {
      const prior = [existing("14-1", "building", { assigned_to: "profile-1" })];
      const plan = planDraftPersistence(prior, [draft("14-1")], "building");
      expect(plan.deleteIds).toEqual([]);
    });

    it("keeps an opening someone has already started work on", () => {
      const prior = [
        existing("14-1", "building", { work_started_at: "2026-07-28T10:00:00Z" }),
      ];
      const plan = planDraftPersistence(prior, [draft("14-1")], "building");
      expect(plan.deleteIds).toEqual([]);
    });

    // undo_install sets status='planned', confirmed=false and voids (never
    // deletes) the install event. install_events + qc_checks are ON DELETE
    // CASCADE, so deleting this row destroys the install record for good.
    it("keeps an undone install, whose install event is only voided", () => {
      const prior = [existing("14-1", "building", { referenced: true })];
      const plan = planDraftPersistence(prior, [draft("14-1")], "building");
      expect(plan.deleteIds).toEqual([]);
    });

    it("still replaces a plain untouched draft", () => {
      const prior = [existing("14-1", "building")];
      const plan = planDraftPersistence(prior, [draft("14-1")], "building");
      expect(plan.deleteIds).toEqual(["building:14-1"]);
    });

    it("does not insert a duplicate over an opening kept for field work", () => {
      const prior = [existing("14-1", "building", { assigned_to: "profile-1" })];
      const plan = planDraftPersistence(prior, [draft("14-1"), draft("9-1")], "building");
      expect(plan.inserts.map((d) => d.opening_code)).toEqual(["9-1"]);
      expect(plan.skipped).toBe(1);
    });

    it("a specs re-extract cannot supersede a building opening with field work", () => {
      const prior = [existing("4A", "specs", { ro_width_in: 35.5 })];
      const plan = planDraftPersistence(prior, [draft("4A")], "building");
      expect(plan.deleteIds).toEqual([]);
    });
  });
});

// "3× #9 windows" was read on site as one window built from three pieces, and
// the whole count was doubted because of it. A mark is a type; the number is how
// many separate openings carry it.
describe("describeMarkCount", () => {
  it("says how many openings use a mark, not how many pieces it has", () => {
    expect(describeMarkCount({ mark: "9", count: 3, kind: "window" })).toBe(
      "3 windows use mark #9",
    );
    expect(describeMarkCount({ mark: "14", count: 25, kind: "window" })).toBe(
      "25 windows use mark #14",
    );
    expect(describeMarkCount({ mark: "4A", count: 1, kind: "door" })).toBe(
      "1 door uses mark #4A",
    );
    expect(describeMarkCount({ mark: "6", count: 12, kind: "door" })).toBe(
      "12 doors use mark #6",
    );
  });
});

// Black Desert has 38 marks. Listing every one of them pushed the three facts
// that matter — how many openings, how many repeats were ignored, how many
// elevation references were saved — off the bottom of a phone screen.
describe("summarizeExtractOutcome", () => {
  const marks = [
    { mark: "1", count: 2, kind: "door" as const },
    { mark: "9", count: 3, kind: "window" as const },
    { mark: "14", count: 37, kind: "window" as const },
  ];

  it("leads with the totals instead of enumerating every mark", () => {
    const out = summarizeExtractOutcome({
      marks,
      inserted: 42,
      skipped: 0,
      repeatViewCallouts: 57,
      elevationViews: 54,
      source: "merged",
    });
    expect(out.headline).toBe(
      "Loaded 42 openings across 3 marks — 40 windows and 2 doors.",
    );
    expect(out.headline).not.toContain("#14");
  });

  it("keeps the repeat and elevation counts so they can be sanity-checked", () => {
    const out = summarizeExtractOutcome({
      marks,
      inserted: 42,
      skipped: 0,
      repeatViewCallouts: 57,
      elevationViews: 54,
      source: "merged",
    });
    expect(out.notes).toContain(
      "Ignored 57 repeat numbers on the elevation sheets — those draw the same openings again.",
    );
    expect(out.notes).toContain(
      "Saved 54 of them as a reference, so the crew can see where each window sits on the outside.",
    );
  });

  it("keeps the approved per-mark wording in the breakdown", () => {
    const out = summarizeExtractOutcome({
      marks,
      inserted: 42,
      skipped: 0,
      repeatViewCallouts: 0,
      elevationViews: 0,
      source: "merged",
    });
    expect(out.breakdown).toEqual([
      "2 doors use mark #1",
      "3 windows use mark #9",
      "37 windows use mark #14",
    ]);
  });

  it("uses the per-mark sentence itself when there is only one mark", () => {
    const out = summarizeExtractOutcome({
      marks: [{ mark: "9", count: 3, kind: "window" }],
      inserted: 3,
      skipped: 0,
      repeatViewCallouts: 0,
      elevationViews: 0,
      source: "details",
    });
    expect(out.headline).toBe("Loaded 3 openings — 3 windows use mark #9.");
  });

  it("says plainly when nothing was found", () => {
    const out = summarizeExtractOutcome({
      marks: [],
      inserted: 0,
      skipped: 0,
      repeatViewCallouts: 0,
      elevationViews: 0,
      source: "none",
    });
    expect(out.headline).toBe("No marks found.");
  });

  it("mentions confirmed openings that were left alone", () => {
    const out = summarizeExtractOutcome({
      marks,
      inserted: 40,
      skipped: 2,
      repeatViewCallouts: 0,
      elevationViews: 0,
      source: "merged",
    });
    expect(out.notes).toContain(
      "Left 2 alone — already confirmed or already being worked on.",
    );
  });
});
