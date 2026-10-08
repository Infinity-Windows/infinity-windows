import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PV 40 at the API boundary: a read sharing a mark with another plan set on
 * the job must be refused before ANY write — catalog, link, delete or insert.
 * The planner's own tests (extract.test.ts) cover what counts as a clash; this
 * file pins that the refusal comes first and names the other file.
 */
const db = vi.hoisted(() => ({
  writes: [] as string[],
  plansets: [] as Record<string, unknown>[],
  openings: [] as Record<string, unknown>[],
  specs: [] as Record<string, unknown>[],
  specsError: null as { code: string; message: string } | null,
  rpcArgs: [] as Record<string, unknown>[],
}));

vi.mock("../supabase", () => {
  const make = (table: string) => {
    let mutating: string | null = null;
    let activeOnly = false;
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.is = (column: string, value: unknown) => {
      if (column === "removed_at" && value === null) activeOnly = true;
      return builder;
    };
    builder.in = () => builder;
    builder.single = () => builder;
    for (const op of ["delete", "update", "upsert"]) {
      builder[op] = () => {
        mutating = op;
        db.writes.push(`${table}:${op}`);
        return builder;
      };
    }
    builder.insert = () => {
      mutating = "insert";
      db.writes.push(`${table}:insert`);
      return builder;
    };
    builder.then = (resolve: (value: unknown) => void) => {
      if (mutating) return resolve({ data: { id: "new", type_code: "X" }, error: null });
      if (table === "project_plansets") return resolve({ data: db.plansets, error: null });
      if (table === "project_openings")
        return resolve({
          data: activeOnly
            ? db.openings.filter((row) => row.removed_at == null)
            : db.openings,
          error: null,
        });
      if (table === "project_mark_specs") return resolve({ data: db.specs, error: db.specsError });
      return resolve({ data: [], error: null });
    };
    return builder;
  };
  return {
    supabase: {
      from: (table: string) => make(table),
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "planset_referenced_openings") {
          return Promise.resolve({ data: [], error: null });
        }
        db.writes.push(`rpc:${name}`);
        db.rpcArgs.push(args);
        return Promise.resolve({ data: { inserted: 0 }, error: null });
      },
    },
    supabaseConfigured: true,
  };
});

import {
  assertNoCrossDocumentMarkCollision,
  ensureTypesFromSpecs,
  linkSpecsToOpenings,
  saveDraftOpenings,
} from "./api";
import { CrossDocumentMarkCollisionError, type DraftOpening } from "./extract";

const draft = (opening_code: string): DraftOpening => ({
  opening_code,
  window_type_id: "type-alu",
  type_text: "Aluminum slider",
  match_score: 1,
  label: null,
  page_number: 1,
  mark_code: opening_code.split("-")[0],
  width_in: 36,
  height_in: 60,
  color: null,
  kind: "window",
});

const opening = (id: string, code: string, planset_id: string | null) => ({
  id,
  opening_code: code,
  window_type_id: "type-vinyl",
  confirmed: false,
  status: "planned",
  pin_x: null,
  pin_y: null,
  page_number: 1,
  planset_id,
  assigned_to: null,
  work_started_at: null,
  ro_width_in: null,
  ro_height_in: null,
  ro_quick_ok: false,
  condition: "unknown",
  field_added: false,
});

beforeEach(() => {
  db.writes = [];
  db.rpcArgs = [];
  db.plansets = [
    { id: "vinyl-cad", kind: "specs", storage_path: "proj/pv40/Vinyl CAD.pdf" },
    { id: "aluminum-cad", kind: "specs", storage_path: "proj/pv40/Aluminum CAD.pdf" },
  ];
  db.openings = [
    opening("v1", "1", "vinyl-cad"),
    opening("v2", "2", "vinyl-cad"),
    opening("v3", "3", "vinyl-cad"),
  ];
  db.specs = [];
  db.specsError = null;
});

const aluminum = [draft("1"), draft("9")];

describe("a second CAD set that shares a mark (PV 40)", () => {
  it("ignores a mark from a removed unit when checking another file", async () => {
    db.openings = [
      { ...opening("old-1", "1", "vinyl-cad"), removed_at: "2026-10-05T00:00:00Z" },
    ];

    await expect(
      assertNoCrossDocumentMarkCollision("pv40", "aluminum-cad", [draft("1")]),
    ).resolves.toBeUndefined();
    expect(db.writes).toEqual([]);
  });

  it("the preflight refuses, naming the mark and the other file", async () => {
    const err = await assertNoCrossDocumentMarkCollision(
      "pv40",
      "aluminum-cad",
      aluminum,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossDocumentMarkCollisionError);
    expect((err as Error).message).toContain("#1");
    expect((err as Error).message).toContain("Vinyl CAD.pdf");
    expect(db.writes).toEqual([]);
  });

  it("protects rich specs even when the first CAD created no opening rows", async () => {
    db.openings = [];
    db.specs = [{ mark_code: "1", planset_id: "vinyl-cad" }];
    await expect(
      assertNoCrossDocumentMarkCollision("pv40", "aluminum-cad", aluminum),
    ).rejects.toBeInstanceOf(CrossDocumentMarkCollisionError);
    expect(db.writes).toEqual([]);
  });

  it("allows a disjoint rich-spec mark from the second CAD", async () => {
    db.openings = [];
    db.specs = [{ mark_code: "1", planset_id: "vinyl-cad" }];
    await assertNoCrossDocumentMarkCollision("pv40", "aluminum-cad", [draft("9")]);
    expect(db.writes).toEqual([]);
  });

  it("refuses extraction when spec provenance cannot be read", async () => {
    db.specsError = {
      code: "PGRST204",
      message: "Could not find the 'planset_id' column of 'project_mark_specs' in the schema cache",
    };
    await expect(
      assertNoCrossDocumentMarkCollision("pv40", "aluminum-cad", [draft("9")]),
    ).rejects.toThrow("planset provenance update");
    expect(db.writes).toEqual([]);
  });

  // Catalog enrichment and type links now happen inside the commit, so a read
  // the commit refuses can no longer have touched the catalog or the vinyl
  // rows. What is left of these two in the browser writes nothing at all.
  it("ensureTypesFromSpecs never writes the catalog, even for a clashing read", async () => {
    const out = await ensureTypesFromSpecs(aluminum, {
      projectId: "pv40",
      plansetId: "aluminum-cad",
    });
    expect(out).toHaveLength(aluminum.length);
    expect(db.writes).toEqual([]);
  });

  it("linkSpecsToOpenings never re-types the vinyl rows, even for a clashing read", async () => {
    await expect(
      linkSpecsToOpenings("pv40", aluminum, { plansetId: "aluminum-cad" }),
    ).resolves.toEqual({ linked: 0 });
    expect(db.writes).toEqual([]);
  });

  it("saveDraftOpenings refuses on its own, deleting and inserting nothing", async () => {
    await expect(
      saveDraftOpenings("pv40", "aluminum-cad", aluminum, { specsAuthoritative: true }),
    ).rejects.toBeInstanceOf(CrossDocumentMarkCollisionError);
    expect(db.writes).toEqual([]);
  });

  it("a disjoint second set saves alongside, deleting nothing of the first", async () => {
    await assertNoCrossDocumentMarkCollision("pv40", "aluminum-cad", [draft("8"), draft("9")]);
    const result = await saveDraftOpenings(
      "pv40",
      "aluminum-cad",
      [draft("8"), draft("9")],
      { specsAuthoritative: true },
    );
    expect(result.inserted).toBe(2);
    // One atomic commit; the first set's rows are not among its deletes.
    expect(db.writes).toEqual(["rpc:reconcile_planset_openings"]);
    expect(db.rpcArgs[0].p_delete_ids).toEqual([]);
  });

  it("re-reading the vinyl set itself passes the preflight and replaces its own drafts", async () => {
    await assertNoCrossDocumentMarkCollision("pv40", "vinyl-cad", [draft("1"), draft("2")]);
    const result = await saveDraftOpenings(
      "pv40",
      "vinyl-cad",
      [draft("1"), draft("2")],
      { specsAuthoritative: true },
    );
    expect(result.inserted).toBe(2);
    // Delete and insert travel together in ONE commit, never as two requests.
    expect(db.writes).toEqual(["rpc:reconcile_planset_openings"]);
    expect([...(db.rpcArgs[0].p_delete_ids as string[])].sort()).toEqual(["v1", "v2", "v3"]);
  });
});
