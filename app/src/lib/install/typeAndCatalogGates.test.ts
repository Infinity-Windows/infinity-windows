import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser half of the old-client gates on opening types and the catalog
 * (outputs/CAD-Multi-Set-2026-10-05/atomic_planset_extraction.draft.sql,
 * section 4b). The database now refuses any browser write of
 * project_openings.window_type_id or window_types category/size/notes that
 * does not come through set_opening_type or import_window_types. What this
 * pins is that the app only ever uses those two doors, sends what they
 * validate against, and turns their refusals into the crew's sentence. The
 * SQL itself is unrun; the db-dry-run probe (items j–o) is what proves it.
 */

const db = vi.hoisted(() => ({
  tableWrites: [] as string[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as unknown,
  rpcData: null as unknown,
}));

vi.mock("../supabase", () => {
  const make = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in", "is", "order", "single", "maybeSingle"]) {
      builder[op] = () => builder;
    }
    for (const op of ["insert", "update", "upsert", "delete"]) {
      builder[op] = () => {
        db.tableWrites.push(`${table}:${op}`);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
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
    },
    supabaseConfigured: true,
  };
});

import {
  OPENING_TYPE_SERVER_UPDATE_NEEDED,
  openingTypeError,
  setOpeningType,
  updateOpening,
} from "./api";
import {
  CATALOG_IMPORT_SERVER_UPDATE_NEEDED,
  catalogImportError,
  importWindowTypes,
} from "../api";
import type { CatalogCsvRow } from "../catalogCsv";

beforeEach(() => {
  db.tableWrites = [];
  db.rpcCalls = [];
  db.rpcError = null;
  db.rpcData = null;
});

const MISSING = (fn: string) => ({
  code: "PGRST202",
  message: `Could not find the function public.${fn} in the schema cache`,
});

describe("the type picker goes through set_opening_type", () => {
  it("sends the new type AND the type the screen showed, and writes no table", async () => {
    await setOpeningType("op-1", "type-b", "type-a");
    expect(db.rpcCalls).toEqual([
      {
        name: "set_opening_type",
        args: { p_opening_id: "op-1", p_window_type_id: "type-b", p_expected_type_id: "type-a" },
      },
    ]);
    expect(db.tableWrites).toEqual([]);
  });

  it("can clear a type, still naming what was there", async () => {
    await setOpeningType("op-1", null, "type-a");
    expect(db.rpcCalls[0].args).toMatchObject({ p_window_type_id: null, p_expected_type_id: "type-a" });
  });

  it("passes a stale-pick refusal through as the server's own sentence", async () => {
    const message =
      "Someone changed this window's type while you were looking. Reload to see the current type, then choose again.";
    db.rpcError = { code: "P0001", message, hint: "forge.opening_type.stale" };
    await expect(setOpeningType("op-1", "type-b", "type-a")).rejects.toThrow(message);
  });

  it("fails closed when the server has no set_opening_type yet — no direct PATCH fallback", async () => {
    db.rpcError = MISSING("set_opening_type");
    await expect(setOpeningType("op-1", "type-b", null)).rejects.toThrow(
      OPENING_TYPE_SERVER_UPDATE_NEEDED,
    );
    expect(db.tableWrites).toEqual([]);
  });

  it("every coded refusal becomes its sentence; anything else is left alone", () => {
    for (const hint of [
      "forge.opening_type.auth",
      "forge.opening_type.not_found",
      "forge.opening_type.installed",
      "forge.opening_type.unknown_type",
      "forge.opening_type.unit_mismatch",
      "forge.opening_type.update_required",
    ]) {
      const err = openingTypeError({ code: "P0001", message: `said ${hint}`, hint });
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(`said ${hint}`);
    }
    const fault = { code: "08006", message: "connection failure" };
    expect(openingTypeError(fault)).toBe(fault);
    const unknown = { code: "P0001", message: "x", hint: "forge.opening_type.new_thing" };
    expect(openingTypeError(unknown)).toBe(unknown);
  });

  it("other opening edits stay direct (label, code, pins)", async () => {
    await updateOpening("op-1", { label: "Kitchen N" });
    expect(db.tableWrites).toEqual(["project_openings:update"]);
    expect(db.rpcCalls).toEqual([]);
  });
});

const csvRow = (over: Partial<CatalogCsvRow> = {}): CatalogCsvRow => ({
  type_code: "CAS3050",
  name: "Casement 30x50",
  category: "casement",
  width_in: 30,
  height_in: 50,
  difficulty_rating: 2,
  required_capability: "nail_fin",
  tutorial_url: null,
  notes: null,
  ...over,
});

describe("the catalog import goes through import_window_types", () => {
  it("sends exactly the eight whitelisted columns and writes no table", async () => {
    db.rpcData = { inserted: 1, updated: 1, total: 2 };
    const result = await importWindowTypes([csvRow(), csvRow({ type_code: "DH2846" })]);

    expect(result).toEqual({ inserted: 1, updated: 1, total: 2 });
    expect(db.tableWrites).toEqual([]);
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["import_window_types"]);
    const rows = db.rpcCalls[0].args.p_rows as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "category",
        "difficulty_rating",
        "height_in",
        "name",
        "notes",
        "tutorial_url",
        "type_code",
        "width_in",
      ].sort(),
    );
    // Parsed from the file, never sent — same as the old upsert.
    expect(rows[0]).not.toHaveProperty("required_capability");
  });

  it("does not call the server for an empty file", async () => {
    await expect(importWindowTypes([])).resolves.toEqual({ inserted: 0, updated: 0, total: 0 });
    expect(db.rpcCalls).toEqual([]);
  });

  it("fails closed when the server has no import_window_types yet — no direct upsert", async () => {
    db.rpcError = MISSING("import_window_types");
    await expect(importWindowTypes([csvRow()])).rejects.toThrow(
      CATALOG_IMPORT_SERVER_UPDATE_NEEDED,
    );
    expect(db.tableWrites).toEqual([]);
  });

  it("a test account's refusal reaches the person as the server's sentence", async () => {
    const message =
      "Test accounts can't import the catalog — it is shared by every job, so there is no practice copy of it.";
    db.rpcError = { code: "42501", message, hint: "forge.catalog.test_account" };
    await expect(importWindowTypes([csvRow()])).rejects.toThrow(message);
  });

  it("leaves an uncoded fault alone for formatApiError", () => {
    const fault = { code: "08006", message: "connection failure" };
    expect(catalogImportError(fault)).toBe(fault);
  });
});
