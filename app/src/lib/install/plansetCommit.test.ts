import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser half of the atomic plan-set commit (PV 40, 2026-10-05).
 *
 * Every extraction write now goes through one of two database functions —
 * reconcile_planset_openings and commit_planset_mark_specs — under one
 * per-project lock (outputs/CAD-Multi-Set-2026-10-05/
 * atomic_planset_extraction.draft.sql). What this file pins is the contract
 * the browser keeps with them:
 *
 *  - nothing is ever written AROUND them: no table delete, insert, upsert or
 *    update on openings or mark specs from an extraction path;
 *  - a server without them fails closed with an update-needed sentence,
 *    never falling back to the old two-request writes they replace;
 *  - their coded refusals reach a person as plain sentences, and a shared
 *    mark arrives as the same CrossDocumentMarkCollisionError the browser's
 *    own check throws.
 *
 * The SQL itself is exercised by the db-dry-run probe and the two-session
 * plan in that file; nothing here can stand in for those.
 */

const db = vi.hoisted(() => ({
  /** Table writes, as "table:op". Must stay empty on every extraction path. */
  tableWrites: [] as string[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as unknown,
  rpcData: { saved: 1, skipped: 0, adopted: 0 } as unknown,
  plansets: [] as Record<string, unknown>[],
  openings: [] as Record<string, unknown>[],
  specs: [] as Record<string, unknown>[],
  /** The global catalog, as a read of window_types sees it. */
  types: [] as Record<string, unknown>[],
  typesError: null as unknown,
  aiCalls: 0,
}));

vi.mock("../supabase", () => {
  const make = (table: string) => {
    let mutating: string | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.in = () => builder;
    builder.not = () => builder;
    builder.order = () => builder;
    builder.single = () => builder;
    for (const op of ["delete", "update", "upsert", "insert"]) {
      builder[op] = () => {
        mutating = op;
        db.tableWrites.push(`${table}:${op}`);
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => {
      if (mutating) return resolve({ data: null, error: null });
      if (table === "project_plansets") return resolve({ data: db.plansets, error: null });
      if (table === "project_openings") return resolve({ data: db.openings, error: null });
      if (table === "project_mark_specs") return resolve({ data: db.specs, error: null });
      if (table === "window_types")
        return resolve(
          db.typesError ? { data: null, error: db.typesError } : { data: db.types, error: null },
        );
      return resolve({ data: [], error: null });
    };
    return builder;
  };
  return {
    supabase: {
      from: (table: string) => make(table),
      rpc: (name: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ name, args });
        return Promise.resolve(
          db.rpcError ? { data: null, error: db.rpcError } : { data: db.rpcData, error: null },
        );
      },
      functions: {
        // The AI read is unavailable in tests; the run falls back to the
        // carried-over drafts, which is all this contract needs.
        invoke: () => {
          db.aiCalls += 1;
          return Promise.reject(new Error("offline"));
        },
      },
    },
    supabaseConfigured: true,
  };
});

import {
  COMMIT_MARK_SPECS_RPC,
  PLANSET_SERVER_UPDATE_NEEDED,
  PlansetExtractionRefusal,
  RECONCILE_OPENINGS_RPC,
  catalogSamplesFromDrafts,
  ensureTypesFromSpecs,
  extractAndSaveMarkSpecs,
  isPlansetRefusal,
  linkSpecsToOpenings,
  plansetCommitError,
  saveDraftOpenings,
} from "./api";
import { CrossDocumentMarkCollisionError, type DraftOpening } from "./extract";
import type { MarkSpecDraft } from "./specs";

const MISSING_FUNCTION = {
  code: "PGRST202",
  message: "Could not find the function public.reconcile_planset_openings in the schema cache",
};

const draft = (opening_code: string): DraftOpening => ({
  opening_code,
  window_type_id: null,
  type_text: opening_code,
  match_score: 1,
  label: null,
  page_number: 2,
  mark_code: opening_code.split("-")[0],
  width_in: 36,
  height_in: 60,
  color: null,
  kind: "window",
  pin_x: 0.4,
  pin_y: 0.6,
});

const row = (id: string, code: string, planset_id: string | null) => ({
  id,
  opening_code: code,
  confirmed: false,
  status: "planned",
  pin_x: 0.1,
  pin_y: 0.2,
  page_number: 3,
  planset_id,
  assigned_to: null,
  work_started_at: null,
  ro_width_in: null,
  ro_height_in: null,
  ro_quick_ok: false,
  condition: "unknown",
  field_added: false,
});

const specDrafts = (...marks: string[]) =>
  marks.map((m) => ({
    mark_code: m,
    style: "Thermal Break Aluminum Slider",
    source: "ai",
  })) as unknown as MarkSpecDraft[];

beforeEach(() => {
  db.tableWrites = [];
  db.rpcCalls = [];
  db.rpcError = null;
  db.rpcData = { saved: 1, skipped: 0, adopted: 0 };
  db.aiCalls = 0;
  db.plansets = [
    { id: "vinyl-cad", kind: "specs", storage_path: "proj/pv40/Vinyl CAD.pdf" },
    { id: "aluminum-cad", kind: "specs", storage_path: "proj/pv40/Aluminum CAD.pdf" },
  ];
  db.openings = [
    row("v1", "1", "vinyl-cad"),
    row("v2", "2", "vinyl-cad"),
    row("v3", "3", "vinyl-cad"),
  ];
  db.specs = [];
  db.types = [];
  db.typesError = null;
});

describe("opening drafts are committed by one database function", () => {
  it("sends the plan with the snapshot it was made against, and writes no table directly", async () => {
    await saveDraftOpenings("pv40", "vinyl-cad", [draft("1"), draft("4")], {
      specsAuthoritative: true,
    });

    expect(db.tableWrites).toEqual([]);
    expect(db.rpcCalls.map((c) => c.name)).toEqual([RECONCILE_OPENINGS_RPC]);
    const args = db.rpcCalls[0].args;
    expect(args.p_project_id).toBe("pv40");
    expect(args.p_planset_id).toBe("vinyl-cad");
    expect(args.p_specs_authoritative).toBe(true);
    // The whole job as read, so the server can refuse a stale plan.
    expect((args.p_snapshot as { id: string }[]).map((r) => r.id)).toEqual(["v1", "v2", "v3"]);
    // Every mark the read produced, not only what survived planning.
    expect(args.p_incoming_marks).toEqual(["1", "4"]);
    expect([...(args.p_delete_ids as string[])].sort()).toEqual(["v1", "v2", "v3"]);
    const inserts = args.p_inserts as { opening_code: string; pin_x: unknown }[];
    expect(inserts.map((i) => i.opening_code).sort()).toEqual(["1", "4"]);
    // Vision-first law still applied by the planner before the commit.
    expect(inserts.every((i) => i.pin_x === null)).toBe(true);
  });

  it("still validates a no-op plan on the server before later enrichment", async () => {
    // Mark 1 is confirmed, so a re-read of just mark 1 has nothing to do.
    db.openings = [{ ...row("v1", "1", "vinyl-cad"), confirmed: true }];
    const result = await saveDraftOpenings("pv40", "vinyl-cad", [draft("1")]);
    expect(result.inserted).toBe(0);
    expect(db.rpcCalls.map((c) => c.name)).toEqual([RECONCILE_OPENINGS_RPC]);
    expect(db.rpcCalls[0].args.p_delete_ids).toEqual([]);
    expect(db.rpcCalls[0].args.p_inserts).toEqual([]);
    expect(db.tableWrites).toEqual([]);
  });

  it("fails closed with an update-needed sentence when the server lacks the function", async () => {
    db.rpcError = MISSING_FUNCTION;
    const err = await saveDraftOpenings("pv40", "vinyl-cad", [draft("1")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlansetExtractionRefusal);
    expect((err as PlansetExtractionRefusal).code).toBe("forge.planset.update_required");
    expect((err as Error).message).toBe(PLANSET_SERVER_UPDATE_NEEDED);
    // No fallback to the old delete-then-insert.
    expect(db.tableWrites).toEqual([]);
  });

  it("turns a server-side shared-mark refusal into the collision error, naming the other file", async () => {
    // The browser's own check passed (the job looked clear when it read it);
    // another device committed mark 9 first and the lock caught it.
    db.rpcError = {
      code: "P0001",
      message: "No windows were loaded from this file: ... (#9). Nothing was changed.",
      hint: "forge.planset.mark_collision",
      details: JSON.stringify({ marks: ["9"], planset_ids: ["vinyl-cad"] }),
    };
    const err = await saveDraftOpenings("pv40", "aluminum-cad", [draft("9")]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CrossDocumentMarkCollisionError);
    expect((err as CrossDocumentMarkCollisionError).marks).toEqual(["9"]);
    expect((err as Error).message).toContain("#9");
    expect((err as Error).message).toContain("Vinyl CAD.pdf");
  });

  it("passes a stale-snapshot refusal through as the server's own sentence", async () => {
    db.rpcError = {
      code: "P0001",
      message: "The windows on this job changed while the plan set was being read. Nothing was changed; read it again.",
      hint: "forge.planset.stale_snapshot",
    };
    const err = await saveDraftOpenings("pv40", "vinyl-cad", [draft("1")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlansetExtractionRefusal);
    expect((err as PlansetExtractionRefusal).code).toBe("forge.planset.stale_snapshot");
    expect((err as Error).message).toMatch(/changed while the plan set was being read/);
  });
});

// The catalog types each mark needs, and the type links onto openings already
// on the job, used to be two browser passes apart from the save — so a read
// the save refused (or an old cached app) had already written the GLOBAL
// catalog and re-typed another source's windows. They now ride in the commit.
describe("catalog types and type links ride in the same commit", () => {
  it("sends one catalog sample per mark with the openings, and inserts carry their mark", async () => {
    const a = { ...draft("w1-1"), type_text: "Slider 6040", color: "Black" };
    const b = { ...draft("w1-2"), window_type_id: "type-matched-slider" };
    const c = { ...draft("D2"), kind: "door" as const, width_in: null };
    await saveDraftOpenings("pv40", "vinyl-cad", [a, b, c]);

    expect(db.tableWrites).toEqual([]);
    const args = db.rpcCalls[0].args;
    expect(args.p_types).toEqual([
      {
        mark_code: "w1",
        type_code: "W1",
        name: "Slider 6040 (#w1)",
        category: "window",
        width_in: 36,
        height_in: 60,
        notes: "Color: Black · Spec: Slider 6040",
        // A matched catalog product for the mark wins the link.
        window_type_id: "type-matched-slider",
      },
      {
        mark_code: "D2",
        type_code: "D2",
        name: "Mark #D2",
        category: "door",
        width_in: null,
        height_in: 60,
        notes: null,
        window_type_id: null,
      },
    ]);
    const inserts = args.p_inserts as { opening_code: string; mark_code: string }[];
    expect(inserts.find((i) => i.opening_code === "w1-1")?.mark_code).toBe("w1");
  });

  it("the caller's later catalog and link steps write nothing and report the commit's links", async () => {
    // Exactly what PlansetUpload and ProjectMap do after the save.
    db.rpcData = { inserted: 2, updated: 0, deleted: 3, linked: 2, catalog_written: 1 };
    db.types = [{ id: "type-mark-1", type_code: "1" }];
    const drafts = [draft("1"), draft("4")];

    const saved = await saveDraftOpenings("pv40", "vinyl-cad", drafts);
    const typed = await ensureTypesFromSpecs(drafts, { projectId: "pv40", plansetId: "vinyl-cad" });
    const linked = await linkSpecsToOpenings("pv40", typed, { plansetId: "vinyl-cad" });

    expect(saved.linked).toBe(2);
    expect(linked).toEqual({ linked: 2 });
    // Resolved for the summary from a read; mark 4 has no catalog row to read.
    expect(typed.map((d) => d.window_type_id)).toEqual(["type-mark-1", null]);
    // One commit, and not a single direct write to any table.
    expect(db.rpcCalls.map((c) => c.name)).toEqual([RECONCILE_OPENINGS_RPC]);
    expect(db.tableWrites).toEqual([]);
    // Reported once: a second ask is not a second set of links.
    await expect(linkSpecsToOpenings("pv40", typed, { plansetId: "vinyl-cad" })).resolves.toEqual({
      linked: 0,
    });
  });

  it("a refused commit leaves nothing for the later steps to have written", async () => {
    db.rpcError = {
      code: "P0001",
      message: "No windows were loaded from this file: it uses mark numbers another plan set on this job already uses (#1). Nothing was changed.",
      hint: "forge.planset.mark_collision",
      details: JSON.stringify({ marks: ["1"], planset_ids: ["vinyl-cad"] }),
    };
    const drafts = [draft("1"), draft("9")];
    await expect(saveDraftOpenings("pv40", "aluminum-cad", drafts)).rejects.toBeInstanceOf(
      CrossDocumentMarkCollisionError,
    );
    // Even a caller that carried on regardless cannot write the catalog or
    // re-type the vinyl rows from the browser any more.
    await ensureTypesFromSpecs(drafts, { projectId: "pv40", plansetId: "aluminum-cad" });
    await expect(
      linkSpecsToOpenings("pv40", drafts, { plansetId: "aluminum-cad" }),
    ).resolves.toEqual({ linked: 0 });
    expect(db.tableWrites).toEqual([]);
  });

  it("a no-op re-read still sends its catalog samples, so links are not skipped", async () => {
    db.openings = [{ ...row("v1", "1", "vinyl-cad"), confirmed: true }];
    await saveDraftOpenings("pv40", "vinyl-cad", [draft("1")]);
    const args = db.rpcCalls[0].args;
    expect(args.p_inserts).toEqual([]);
    expect((args.p_types as { mark_code: string }[]).map((t) => t.mark_code)).toEqual(["1"]);
  });

  it("ensureTypesFromSpecs keeps a matched type and does not fail a saved upload on a bad read", async () => {
    db.typesError = { code: "08006", message: "connection failure" };
    const drafts = [{ ...draft("1"), window_type_id: "type-matched" }, draft("2")];
    const out = await ensureTypesFromSpecs(drafts, { projectId: "pv40", plansetId: "vinyl-cad" });
    expect(out.map((d) => d.window_type_id)).toEqual(["type-matched", null]);
    expect(db.tableWrites).toEqual([]);
  });

  it("catalogSamplesFromDrafts skips blank marks and keeps first-draft naming", () => {
    const samples = catalogSamplesFromDrafts([
      { ...draft("5-1"), type_text: "Casement" },
      { ...draft("5-2"), type_text: "Something else" },
      { ...draft("x"), mark_code: "  " },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0].name).toBe("Casement (#5)");
  });
});

describe("rich spec pages are committed by one database function", () => {
  it("sends the page's drafts to the commit and never upserts, updates or adopts directly", async () => {
    const result = await extractAndSaveMarkSpecs(
      "pv40",
      [{ pageNumber: 1, text: "" }],
      [],
      "vinyl-cad",
      specDrafts("1", "2"),
    );

    expect(db.tableWrites).toEqual([]);
    expect(db.rpcCalls.map((c) => c.name)).toEqual([COMMIT_MARK_SPECS_RPC]);
    const args = db.rpcCalls[0].args;
    expect(args.p_project_id).toBe("pv40");
    expect(args.p_planset_id).toBe("vinyl-cad");
    const specs = args.p_specs as { mark_code: string; planset_id: string }[];
    expect(specs.map((s) => s.mark_code)).toEqual(["1", "2"]);
    expect(specs.every((s) => s.planset_id === "vinyl-cad")).toBe(true);
    // The counts are the server's, not the browser's guess.
    expect(result.saved).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("refuses a page whose mark another CAD set's spec row owns, before the commit", async () => {
    db.specs = [{ mark_code: "1", planset_id: "vinyl-cad" }];
    await expect(
      extractAndSaveMarkSpecs("pv40", [{ pageNumber: 1, text: "" }], [], "aluminum-cad", specDrafts("1", "9")),
    ).rejects.toBeInstanceOf(CrossDocumentMarkCollisionError);
    expect(db.rpcCalls).toEqual([]);
    expect(db.tableWrites).toEqual([]);
  });

  it("fails closed with an update-needed sentence when the server lacks the function", async () => {
    db.rpcError = { ...MISSING_FUNCTION, message: MISSING_FUNCTION.message.replace("reconcile_planset_openings", "commit_planset_mark_specs") };
    const err = await extractAndSaveMarkSpecs(
      "pv40",
      [{ pageNumber: 1, text: "" }],
      [],
      "vinyl-cad",
      specDrafts("1"),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlansetExtractionRefusal);
    expect((err as Error).message).toBe(PLANSET_SERVER_UPDATE_NEEDED);
    // No drop-a-column retry, no direct upsert.
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.tableWrites).toEqual([]);
  });

  it("refuses a spec write that cannot name its plan set, before paying for the AI read", async () => {
    const err = await extractAndSaveMarkSpecs(
      "pv40",
      [{ pageNumber: 1, text: "" }],
      [],
      null,
      specDrafts("1"),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlansetExtractionRefusal);
    expect(db.aiCalls).toBe(0);
    expect(db.rpcCalls).toEqual([]);
    expect(db.tableWrites).toEqual([]);
  });
});

describe("plansetCommitError (the refusal contract, pure)", () => {
  it("maps every coded refusal to a PlansetExtractionRefusal carrying the server's sentence", () => {
    const err = plansetCommitError({
      code: "P0001",
      message: "This read would remove windows that already have work or history on them (7-1). Nothing was changed.",
      hint: "forge.planset.protected",
    });
    expect(err).toBeInstanceOf(PlansetExtractionRefusal);
    expect((err as PlansetExtractionRefusal).code).toBe("forge.planset.protected");
    expect(isPlansetRefusal(err)).toBe(true);
  });

  it("still refuses plainly, in the server's words, when a collision's detail is garbled", () => {
    const message = "No windows were loaded from this file: it uses mark numbers another plan set on this job already uses (#1). Nothing was changed.";
    const err = plansetCommitError({
      code: "P0001",
      message,
      hint: "forge.planset.mark_collision",
      details: "not json",
    });
    expect(err).toBeInstanceOf(PlansetExtractionRefusal);
    expect((err as PlansetExtractionRefusal).code).toBe("forge.planset.mark_collision");
    expect((err as Error).message).toBe(message);
    expect(isPlansetRefusal(err)).toBe(true);
  });

  it("leaves an uncoded fault alone for formatApiError", () => {
    const fault = { code: "08006", message: "connection failure" };
    expect(plansetCommitError(fault)).toBe(fault);
    expect(isPlansetRefusal(fault)).toBe(false);
  });

  it("does not trust a hint it does not know", () => {
    const fault = { code: "P0001", message: "boom", hint: "forge.planset.something_new" };
    expect(plansetCommitError(fault)).toBe(fault);
  });
});
