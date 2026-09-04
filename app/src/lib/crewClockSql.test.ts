// What the roster's bulk clock is allowed to put on a supervisor's screen.
//
// `when others` inside clock_in_many / clock_out_many catches far more than
// the refusals that migration writes: a check constraint on time_shifts, one
// of the unit_sessions triggers, a deadlock. The first cut passed `sqlerrm`
// straight through for all of them, so an unexpected failure would have
// printed
//
//   Not done — new row for relation "time_shifts" violates check constraint
//   "time_shifts_job_mode_check"
//
// onto a phone in the yard — the exact leak the app's rule against String(err)
// exists to stop (2026-09-04 review). The fix is a marker: every refusal this
// file writes carries `using hint = 'crew-clock'`, the loop repeats only those
// word for word, and everything else becomes one plain sentence with the real
// text going to the Postgres log.
//
// A scan of the SQL, not a database test: there is no Postgres in this suite,
// and the property worth pinning is textual anyway — that no `raise exception`
// in the two per-person functions is left unmarked, so a refusal added later
// cannot silently come back as raw Postgres wording.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = resolve(
  REPO,
  "supabase/migrations/20260985000000_clock_the_crew.sql",
);
const PROTOTYPE = resolve(REPO, "docs/prototype-migrations.sql");
const SQL = readFileSync(MIGRATION, "utf8");

/** The body of one `create or replace function public.<name>(` block. */
function body(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is in the migration`).toBeGreaterThan(-1);
  const end = SQL.indexOf("\n$$;", start);
  expect(end, `${name} has a body`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe("every refusal the crew clock writes is marked as one", () => {
  it("marks all of them in clock_in_for and clock_out_for", () => {
    for (const fn of ["clock_in_for", "clock_out_for"]) {
      const src = body(fn);
      const raises = src.match(/raise exception[\s\S]*?;/g) ?? [];
      expect(raises.length, `${fn} refuses at least once`).toBeGreaterThan(0);
      for (const r of raises) {
        expect(r, `${fn}: ${r.slice(0, 60)}…`).toContain("hint = 'crew-clock'");
      }
    }
  });

  it("uses the marker, not the sentence, to decide what to repeat", () => {
    for (const fn of ["clock_in_many", "clock_out_many"]) {
      const src = body(fn);
      expect(src).toContain("get stacked diagnostics v_hint = pg_exception_hint");
      expect(src).toContain("if v_hint is distinct from 'crew-clock' then");
      // The generic line, and the real text going where it belongs.
      expect(src).toContain("refused:Something went wrong for this person.");
      expect(src).toMatch(/raise warning '.*unexpected error for %/);
      // sqlerrm is still repeated — but only on the marked branch.
      expect(src).toContain("'refused:' || sqlerrm");
    }
  });

  it("keeps the per-person subtransaction, so one failure never sinks the rest", () => {
    for (const fn of ["clock_in_many", "clock_out_many"]) {
      const src = body(fn);
      expect(src).toContain("exception when others then");
      expect(src).toContain("return next");
    }
  });

  // The refusals a supervisor is meant to read are still plain sentences —
  // marking them must not have turned them into codes.
  it("still says why in plain English", () => {
    expect(SQL).toContain("Only a supervisor or above can clock somebody else in.");
    expect(SQL).toContain(
      "Give today's toolbox talk first, then tick the box to say you did.".replace(
        "today's",
        "today''s",
      ),
    );
  });
});

describe("the group sign-in is stored as the weaker record it is", () => {
  it("files it with no typed name, no signature and no PDF", () => {
    const src = body("_file_group_toolbox_signin");
    expect(src).toContain("(talk_id, profile_id, signed_at, typed_name, signed_by, signed_via)");
    expect(src).toContain("'group'");
    expect(src).not.toContain("signature_path");
    expect(src).not.toContain("pdf_path");
  });

  it("defaults signed_via to 'self', so no existing row is re-labelled", () => {
    expect(SQL).toContain("add column if not exists signed_via text not null default 'self'");
    expect(SQL).toContain("check (signed_via in ('self', 'group'))");
  });
});

it("is mirrored into docs/prototype-migrations.sql, verbatim", () => {
  const doc = readFileSync(PROTOTYPE, "utf8");
  expect(doc).toContain("20260985000000_clock_the_crew.sql (mirrored)");
  // Verbatim, not "roughly": the mirror is what a fresh database is built
  // from, and a mirror that drifts is a schema nobody can reproduce.
  expect(doc).toContain(SQL);
});
