import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the mocked PostgREST client saw, and what it should hand back.
 *
 * `quickOkColumnMissing` is the phone-ahead-of-the-server case: the bundle
 * knows about `ro_quick_ok` (20260966000000) and the database does not yet.
 */
const db = vi.hoisted(() => ({
  /** Every read, as "table:columns". */
  selects: [] as string[],
  deletedIds: [] as string[],
  inserted: [] as Record<string, unknown>[],
  openings: [] as Record<string, unknown>[],
  quickOkColumnMissing: false,
  /** The same case one migration later: the bundle knows `field_added`
   *  (20260977000000, wave E) and the database does not yet. */
  fieldAddedColumnMissing: false,
  /** Any other failure the openings read should return instead of rows. */
  openingsError: null as unknown,
}));

vi.mock("../supabase", () => {
  // Exactly what PostgREST returns for a column the schema cache has never
  // heard of — the shape `isMissingColumn` reads.
  const QUICK_OK_MISSING = {
    code: "42703",
    message: 'column project_openings.ro_quick_ok does not exist',
  };
  const FIELD_ADDED_MISSING = {
    code: "42703",
    message: 'column project_openings.field_added does not exist',
  };

  const make = (table: string) => {
    let columns = "";
    let deleting = false;
    const builder: Record<string, unknown> = {};
    builder.select = (cols: string) => {
      columns = cols;
      db.selects.push(`${table}:${cols}`);
      return builder;
    };
    builder.delete = () => {
      deleting = true;
      return builder;
    };
    builder.insert = (rows: Record<string, unknown>[]) => {
      db.inserted.push(...rows);
      return Promise.resolve({ data: null, error: null });
    };
    builder.eq = () => builder;
    builder.in = (_column: string, ids: string[]) => {
      if (deleting) db.deletedIds.push(...ids);
      return builder;
    };
    // PostgREST builders are thenable, so awaiting the chain hands back rows.
    builder.then = (resolve: (value: unknown) => void) => {
      if (deleting) return resolve({ data: null, error: null });
      if (table === "project_plansets")
        return resolve({ data: [{ id: "ps-1", kind: "building" }], error: null });
      if (table !== "project_openings") return resolve({ data: [], error: null });
      if (db.openingsError) return resolve({ data: null, error: db.openingsError });
      // Newest column first, the order PostgREST would notice them in.
      if (columns.includes("field_added") && db.fieldAddedColumnMissing)
        return resolve({ data: null, error: FIELD_ADDED_MISSING });
      if (columns.includes("ro_quick_ok") && db.quickOkColumnMissing)
        return resolve({ data: null, error: QUICK_OK_MISSING });
      return resolve({ data: db.openings, error: null });
    };
    return builder;
  };

  return {
    supabase: { from: (table: string) => make(table) },
    supabaseConfigured: true,
  };
});

import {
  EXISTING_OPENING_COLS,
  EXISTING_OPENING_COLS_NO_FIELD_ADDED,
  EXISTING_OPENING_COLS_NO_QUICK_OK,
  saveDraftOpenings,
} from "./api";
import type { DraftOpening } from "./extract";

const draft = (opening_code: string): DraftOpening => ({
  opening_code,
  window_type_id: null,
  type_text: "SH 3050",
  match_score: 1,
  label: null,
  page_number: 1,
  mark_code: opening_code.split("-")[0],
  width_in: 36,
  height_in: 60,
  color: null,
  kind: "window",
});

const openingsSelects = () =>
  db.selects.filter((s) => s.startsWith("project_openings:"));

beforeEach(() => {
  db.selects = [];
  db.deletedIds = [];
  db.inserted = [];
  db.quickOkColumnMissing = false;
  db.fieldAddedColumnMissing = false;
  db.openingsError = null;
  db.openings = [
    {
      id: "op-1",
      opening_code: "6-1",
      confirmed: false,
      status: "planned",
      pin_x: 0.2,
      pin_y: 0.4,
      page_number: 1,
      planset_id: "ps-1",
      assigned_to: null,
      work_started_at: null,
      ro_width_in: null,
      ro_height_in: null,
      ro_quick_ok: true,
      condition: "unknown",
    },
  ];
});

/**
 * The re-extract read is the one place in this module that names a column
 * instead of asking for `*` (OPENING_SELECT), so it is the one place a
 * half-deployed schema can take the whole save down with it. CLAUDE.md's rule
 * is that a feature shipping ahead of its migration degrades instead of
 * crashing, and here "crashing" means a foreman taps "Load marks from plans"
 * and gets nothing saved at all.
 */
describe("reading existing openings before a re-extract", () => {
  it("asks for the quick-check column when the database has it", async () => {
    const result = await saveDraftOpenings("proj-1", "ps-1", [draft("7-1")]);

    expect(openingsSelects()).toEqual([`project_openings:${EXISTING_OPENING_COLS}`]);
    expect(result.inserted).toBe(1);
  });

  it("still saves the draft when neither new column has reached the server", async () => {
    db.quickOkColumnMissing = true;
    db.fieldAddedColumnMissing = true;

    const result = await saveDraftOpenings("proj-1", "ps-1", [draft("7-1")]);

    expect(openingsSelects()).toEqual([
      `project_openings:${EXISTING_OPENING_COLS}`,
      `project_openings:${EXISTING_OPENING_COLS_NO_FIELD_ADDED}`,
      `project_openings:${EXISTING_OPENING_COLS_NO_QUICK_OK}`,
    ]);
    expect(result.inserted).toBe(1);
    expect(db.inserted.map((r) => r.opening_code)).toEqual(["7-1"]);
  });

  // The rungs are separate for this exact case: the two migrations can land
  // apart, and peeling straight back to the oldest list would throw away the
  // quick check on a server that has it.
  it("keeps the quick-check column when only field_added is missing", async () => {
    db.fieldAddedColumnMissing = true;

    const result = await saveDraftOpenings("proj-1", "ps-1", [draft("7-1")]);

    expect(openingsSelects()).toEqual([
      `project_openings:${EXISTING_OPENING_COLS}`,
      `project_openings:${EXISTING_OPENING_COLS_NO_FIELD_ADDED}`,
    ]);
    expect(result.inserted).toBe(1);
  });

  it("keeps a quick-checked opening a re-extract would otherwise delete", async () => {
    await saveDraftOpenings("proj-1", "ps-1", [draft("7-1")]);

    expect(db.deletedIds).not.toContain("op-1");
  });

  it("does not swallow a read that failed for any other reason", async () => {
    // A permission refusal carries no missing-column code. Retrying without
    // one column would not help, and saving on regardless would delete rows
    // nobody could read — so it has to reach the caller.
    db.openingsError = {
      code: "42501",
      message: "permission denied for table project_openings",
    };

    await expect(
      saveDraftOpenings("proj-1", "ps-1", [draft("7-1")]),
    ).rejects.toMatchObject({ code: "42501" });
    expect(openingsSelects()).toHaveLength(1);
    expect(db.inserted).toHaveLength(0);
  });
});

/**
 * Pure merge used by saveDraftOpenings: when re-extracting, keep pin coords
 * from prior drafts that share an opening_code.
 */
function mergePreservedPins(
  drafts: {
    opening_code: string;
    page_number: number;
    pin_x: number | null;
    pin_y: number | null;
  }[],
  preserved: Map<
    string,
    { pin_x: number; pin_y: number; page_number: number }
  >,
) {
  return drafts.map((d) => {
    const kept = preserved.get(d.opening_code);
    return {
      ...d,
      page_number: kept?.page_number ?? d.page_number,
      pin_x: kept?.pin_x ?? d.pin_x,
      pin_y: kept?.pin_y ?? d.pin_y,
    };
  });
}

describe("preserve manual pins on re-extract", () => {
  it("restores pins for matching opening codes", () => {
    const preserved = new Map([
      ["6-1", { pin_x: 0.22, pin_y: 0.41, page_number: 3 }],
    ]);
    const merged = mergePreservedPins(
      [
        {
          opening_code: "6-1",
          page_number: 3,
          pin_x: 0.18,
          pin_y: 0.58,
        },
        {
          opening_code: "6-2",
          page_number: 3,
          pin_x: 0.3,
          pin_y: 0.58,
        },
      ],
      preserved,
    );
    expect(merged[0]).toMatchObject({
      opening_code: "6-1",
      pin_x: 0.22,
      pin_y: 0.41,
      page_number: 3,
    });
    expect(merged[1]).toMatchObject({
      opening_code: "6-2",
      pin_x: 0.3,
      pin_y: 0.58,
    });
  });
});
