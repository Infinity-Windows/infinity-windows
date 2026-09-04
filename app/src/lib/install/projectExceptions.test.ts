// The foreman's Exceptions list has to find the units the map is already
// showing amber.
//
// Wave E made a data-off flag's REASON the message and the note optional, so
// the ordinary way to raise one leaves flag_note null. This read asked only
// about flag_note, which meant the exact case the wave introduced — one tap,
// a reason, no typing — was invisible to the person whose job it is to chase
// it. These tests pin the widened question, and the peel-back that keeps the
// screen working on a phone that reaches a server without the new column.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  /** Every `.or(...)` string the openings read has asked, in order. */
  ors: [] as string[],
  /** Fail the first openings read the way a server without flag_kind does. */
  flagKindMissing: false,
  openings: [] as Record<string, unknown>[],
}));

vi.mock("../supabase", () => {
  const FLAG_KIND_MISSING = {
    code: "42703",
    message: 'column project_openings.flag_kind does not exist',
  };

  const make = (table: string) => {
    let or = "";
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ["select", "eq", "not", "order", "in", "is"]) {
      builder[m] = chain;
    }
    builder.or = (clause: string) => {
      db.ors.push(clause);
      or = clause;
      return builder;
    };
    builder.then = (
      resolve: (v: { data: unknown; error: unknown }) => unknown,
    ) => {
      if (table !== "project_openings") return resolve({ data: [], error: null });
      if (or.includes("flag_kind") && db.flagKindMissing) {
        return resolve({ data: null, error: FLAG_KIND_MISSING });
      }
      return resolve({ data: db.openings, error: null });
    };
    return builder;
  };

  return {
    supabase: { from: (table: string) => make(table) },
    supabaseConfigured: true,
  };
});

import { listProjectExceptions } from "./api";

beforeEach(() => {
  db.ors = [];
  db.flagKindMissing = false;
  db.openings = [
    // A flag raised the ordinary way: a reason, and nobody typed anything.
    { id: "o1", opening_code: "7-1", flag_kind: "wrong_size", flag_note: null },
  ];
});

describe("listProjectExceptions", () => {
  it("asks about the reason, not only the note", async () => {
    const out = await listProjectExceptions("proj-1");

    expect(db.ors).toEqual([
      "flag_kind.not.is.null,flag_note.not.is.null,condition.eq.damaged",
    ]);
    expect(out.flaggedOpenings.map((o) => o.opening_code)).toEqual(["7-1"]);
  });

  it("still lists the notes it can find on a server without the reason column", async () => {
    db.flagKindMissing = true;

    const out = await listProjectExceptions("proj-1");

    expect(db.ors).toEqual([
      "flag_kind.not.is.null,flag_note.not.is.null,condition.eq.damaged",
      "flag_note.not.is.null,condition.eq.damaged",
    ]);
    // The screen empties of what that database cannot know about, and shows
    // everything it can — it never white-screens on a missing column.
    expect(out.flaggedOpenings).toHaveLength(1);
  });

  it("hands an empty list to somebody who may not see exceptions", async () => {
    const out = await listProjectExceptions("proj-1", false);
    expect(db.ors).toEqual([]);
    expect(out).toEqual({ failedInstalls: [], flaggedOpenings: [] });
  });
});
