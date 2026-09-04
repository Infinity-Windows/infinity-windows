// A group sign-in has to be legible to the app, not only to the database.
//
// 20260985000000 records the difference between a signature and a supervisor's
// attestation — signed_via, signed_by — and the migration's own comment, and
// CONTEXT.md, both claim "a compliance read can always tell an attestation
// from a signature". For a day that was true of the data and of nothing else:
// todayCompliance asked for two columns, so the Safety page's "who signed
// today" list counted a supervisor's word for it exactly like a signature, and
// a safety audit run off that screen would have over-counted (2026-09-04
// review).
//
// These tests are about the READ. The screens that use it are covered by the
// crew-clock e2e; what has to hold here is that the columns come back, that
// the two kinds are told apart, and — the part that is easy to get wrong — that
// a phone whose database has not applied the migration still gets its list.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Result {
  data: unknown;
  error: unknown;
}

/** table -> the answer for a select naming these columns. */
const answer = vi.fn<(table: string, cols: string) => Result>();
/** Every select this test made, as "table:columns". */
const selects: string[] = [];

vi.mock("./supabase", () => {
  function builder(table: string) {
    let cols = "";
    const chain = {
      select(c: string) {
        cols = c;
        selects.push(`${table}:${c}`);
        return chain;
      },
      eq: () => chain,
      gte: () => chain,
      order: () => chain,
      // Awaiting the chain is what actually runs it, exactly as PostgREST's
      // builder behaves.
      then<A, B>(
        ok: (r: Result) => A,
        bad?: (e: unknown) => B,
      ): Promise<A | B> {
        return Promise.resolve(answer(table, cols)).then(ok, bad);
      },
    };
    return chain;
  }
  return { supabase: { from: (table: string) => builder(table) } };
});

import { isGroupSignIn, todayCompliance } from "./toolbox";

const ANA = "profile-ana";
const BEN = "profile-ben";
const SUP = "profile-marlene";

const PROFILES = [
  { id: ANA, display_name: "Ana Ruiz", role: "installer", active: true },
  { id: BEN, display_name: "Ben Cole", role: "installer", active: true },
  { id: SUP, display_name: "Marlene", role: "supervisor", active: true },
];

const MISSING_COLUMN = {
  code: "PGRST204",
  message:
    "column toolbox_completions.signed_via does not exist",
};

beforeEach(() => {
  answer.mockReset();
  selects.length = 0;
});

describe("isGroupSignIn", () => {
  it("is only ever true for a row that says so", () => {
    expect(isGroupSignIn({ signed_via: "group" })).toBe(true);
    expect(isGroupSignIn({ signed_via: "self" })).toBe(false);
    // A database without the columns answers rows without the key. That is an
    // ordinary signature, which is what every row on such a database is.
    expect(isGroupSignIn({})).toBe(false);
    expect(isGroupSignIn(null)).toBe(false);
    expect(isGroupSignIn(undefined)).toBe(false);
  });
});

describe("todayCompliance", () => {
  it("asks for how each completion was made, not just that it was", () => {
    answer.mockImplementation((table) =>
      table === "profiles"
        ? { data: PROFILES, error: null }
        : { data: [], error: null },
    );
    return todayCompliance().then(() => {
      expect(selects).toContain(
        "toolbox_completions:profile_id, signed_at, signed_via, signed_by",
      );
    });
  });

  it("tells a supervisor's attestation from a real signature, and names who made it", async () => {
    answer.mockImplementation((table) =>
      table === "profiles"
        ? { data: PROFILES, error: null }
        : {
            data: [
              { profile_id: ANA, signed_at: "2026-09-04T13:00:00Z", signed_via: "self", signed_by: null },
              { profile_id: BEN, signed_at: "2026-09-04T13:01:00Z", signed_via: "group", signed_by: SUP },
            ],
            error: null,
          },
    );
    const rows = await todayCompliance();
    const ana = rows.find((r) => r.profile_id === ANA)!;
    const ben = rows.find((r) => r.profile_id === BEN)!;
    const sup = rows.find((r) => r.profile_id === SUP)!;

    // Both are covered — a group sign-in satisfies the clock-in gate, which is
    // the whole point of it.
    expect(ana.signed).toBe(true);
    expect(ben.signed).toBe(true);
    // …and they are still not the same fact.
    expect(ana.via).toBe("self");
    expect(ben.via).toBe("group");
    expect(ben.signed_by_name).toBe("Marlene");
    expect(ana.signed_by_name).toBeNull();
    expect(sup.signed).toBe(false);
    expect(sup.via).toBe("self");
  });

  // The attester's name costs no extra query — it comes out of the crew list
  // this function already fetched. Somebody who has since left it is simply
  // unnamed rather than an error.
  it("leaves the name null when the attester is not on the active crew list", async () => {
    answer.mockImplementation((table) =>
      table === "profiles"
        ? { data: PROFILES, error: null }
        : {
            data: [
              { profile_id: ANA, signed_at: "2026-09-04T13:00:00Z", signed_via: "group", signed_by: "gone" },
            ],
            error: null,
          },
    );
    const rows = await todayCompliance();
    const ana = rows.find((r) => r.profile_id === ANA)!;
    expect(ana.via).toBe("group");
    expect(ana.signed_by_name).toBeNull();
    // Two queries, not three: profiles + completions.
    expect(selects.filter((s) => s.startsWith("profiles:"))).toHaveLength(1);
  });

  // The frontend and the backend deploy as separate workflows, and the backend
  // one has silently failed before. Losing the whole compliance list to a
  // column that has not landed yet would be far worse than losing the badge.
  it("still answers on a database that has not applied the migration", async () => {
    answer.mockImplementation((table, cols) => {
      if (table === "profiles") return { data: PROFILES, error: null };
      if (cols.includes("signed_via")) return { data: null, error: MISSING_COLUMN };
      return {
        data: [{ profile_id: ANA, signed_at: "2026-09-04T13:00:00Z" }],
        error: null,
      };
    });
    const rows = await todayCompliance();
    const ana = rows.find((r) => r.profile_id === ANA)!;
    expect(ana.signed).toBe(true);
    expect(ana.via).toBe("self");
    expect(selects).toContain("toolbox_completions:profile_id, signed_at");
  });

  it("still throws a real failure rather than pretending nobody signed", async () => {
    answer.mockImplementation((table) =>
      table === "profiles"
        ? { data: PROFILES, error: null }
        : { data: null, error: { code: "500", message: "boom" } },
    );
    await expect(todayCompliance()).rejects.toEqual({ code: "500", message: "boom" });
  });
});
