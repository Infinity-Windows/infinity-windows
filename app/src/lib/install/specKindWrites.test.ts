// Wave X: the app stores what kind of unit each mark is at every specs write
// path. These are the two pure pieces of that — the shape written, and what
// happens on a phone whose database has not had the migration yet.

import { describe, expect, it } from "vitest";
import { missingOptionalSpecColumns } from "./api";
import { specKindColumns } from "./unitKind";

describe("what gets written with a spec", () => {
  // Real Black Desert spec text (marks #26-#39 are the French door run).
  it("a French door writes both columns", () => {
    expect(
      specKindColumns({
        style: "Thermal break Aluminum French Door (Low track)",
        operation: "XO",
      }),
    ).toEqual({ unit_kind: "door", door_kind: "french" });
  });

  it("a window writes no door kind at all", () => {
    expect(
      specKindColumns({ style: "Thermal Break Aluminum Fixed Window", operation: "O" }),
    ).toEqual({ unit_kind: "window", door_kind: null });
  });

  // Null is the honest answer, and project_scope_counts has a bucket for it.
  // Guessing here would put the mark in the window pile and nobody would know.
  it("paperwork that says neither leaves both null", () => {
    expect(specKindColumns({ style: "Thermal Break Aluminum", operation: null })).toEqual({
      unit_kind: null,
      door_kind: null,
    });
  });
});

describe("a database that has not had the migration yet", () => {
  const notCached = (column: string) => ({
    code: "PGRST204",
    message: `Could not find the '${column}' column of 'project_mark_specs' in the schema cache`,
  });

  // PostgREST names ONE column per complaint, and the two kind columns arrive
  // in the same migration. Dropping only the named half would be refused all
  // over again — and on a half-applied database the check constraint (a door
  // kind only means something on a door) would refuse it too.
  it("drops both kind columns when it names either one", () => {
    expect(missingOptionalSpecColumns(notCached("unit_kind"))).toEqual([
      "unit_kind",
      "door_kind",
    ]);
    expect(missingOptionalSpecColumns(notCached("door_kind"))).toEqual([
      "unit_kind",
      "door_kind",
    ]);
  });

  it("still drops the drawing columns one at a time", () => {
    expect(missingOptionalSpecColumns(notCached("planset_id"))).toEqual(["planset_id"]);
  });

  // A refusal, a dead connection, a constraint violation: those have to reach
  // the person, not be quietly retried with a smaller row.
  it("says nothing about an error that is not a missing column", () => {
    expect(
      missingOptionalSpecColumns({ code: "42501", message: "permission denied" }),
    ).toEqual([]);
    expect(missingOptionalSpecColumns(null)).toEqual([]);
  });
});
