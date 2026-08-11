import { describe, expect, it } from "vitest";
import { isMissingColumn, isMissingFunction, isMissingTable } from "./schemaErrors";

describe("isMissingTable", () => {
  it("accepts both the PostgREST and the Postgres code", () => {
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "42P01" })).toBe(true);
  });

  it("matches a table named by the caller", () => {
    const err = { message: 'Could not find the table "public.project_mark_specs"' };
    expect(isMissingTable(err, "project_mark_specs")).toBe(true);
  });

  it("still catches the generic wording when the caller names other tables", () => {
    const err = { message: 'relation "schedule_events" does not exist' };
    expect(isMissingTable(err, "vehicles")).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isMissingTable({ code: "23505", message: "duplicate key value" })).toBe(false);
    expect(isMissingTable({ code: "42501", message: "permission denied for table projects" })).toBe(false);
  });

  it("is safe on non-objects", () => {
    expect(isMissingTable(null)).toBe(false);
    expect(isMissingTable(undefined)).toBe(false);
    expect(isMissingTable("boom")).toBe(false);
  });
});

describe("isMissingColumn", () => {
  it("accepts both codes when no column is named", () => {
    expect(isMissingColumn({ code: "PGRST204" })).toBe(true);
    expect(isMissingColumn({ code: "42703" })).toBe(true);
  });

  it("matches the wording without a code", () => {
    expect(isMissingColumn({ message: 'column "features" does not exist' })).toBe(true);
  });

  it("requires the named column to be the one that is missing", () => {
    const err = { code: "PGRST204", message: "Could not find the 'start_date' column" };
    expect(isMissingColumn(err, "start_date")).toBe(true);
    expect(isMissingColumn(err, "features")).toBe(false);
  });

  it("accepts a bare code when the error carries no message", () => {
    expect(isMissingColumn({ code: "PGRST204" }, "features")).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isMissingColumn({ code: "23503", message: "foreign key violation" })).toBe(false);
  });
});

describe("isMissingFunction", () => {
  it("accepts both the PostgREST and the Postgres code", () => {
    expect(isMissingFunction({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunction({ code: "42883" })).toBe(true);
  });

  it("matches the wording without a code", () => {
    expect(isMissingFunction({ message: "function public.pin_moves(uuid) does not exist" })).toBe(true);
  });

  it("does not fire on a missing table", () => {
    expect(isMissingFunction({ code: "PGRST205" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});
