// What 20261028000000_clock_integrity.sql must keep saying.
//
// The behaviour itself is proven against a real database by
// scripts/verify-clock-integrity.mjs (PGlite, in CI). This is the cheaper,
// textual half, run with every `npm test`: the properties that are about the
// SHAPE of the file — that every SECURITY DEFINER function pins its search
// path and says who may call it, that the legacy overloads keep the guards
// that stop a stale bundle moving a clock-out, that the review codes the
// server writes are exactly the ones the timecard can translate, and that the
// mirror a fresh database is built from carries the file verbatim.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG } from "./i18n/catalog";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION = resolve(REPO, "supabase/migrations/20261028000000_clock_integrity.sql");
const PROTOTYPE = resolve(REPO, "docs/prototype-migrations.sql");
const SQL = readFileSync(MIGRATION, "utf8");

/** Every `create or replace function public.<name>(` block, as {name, text}. */
function functions(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const re = /create or replace function public\.([a-z_]+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SQL))) {
    const end = SQL.indexOf("\n$$;", m.index);
    out.push({ name: m[1], text: SQL.slice(m.index, end) });
  }
  return out;
}

describe("every SECURITY DEFINER function is pinned and gated", () => {
  const definers = functions().filter((f) => /security definer/.test(f.text));

  it("finds the definer functions at all", () => {
    expect(definers.map((f) => f.name)).toEqual(
      expect.arrayContaining(["clock_in", "clock_out", "start_break", "end_break", "_flag_shift_for_review", "person_record_counts"]),
    );
  });

  it("pins search_path on each of them", () => {
    for (const f of definers) {
      expect(f.text, f.name).toContain("set search_path = public, pg_temp");
    }
  });

  it("revokes each new one from public and anon, and grants the clock RPCs to authenticated only", () => {
    for (const name of ["clock_in", "clock_out", "start_break", "end_break"]) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*uuid, timestamptz, timestamptz, integer\\) from public, anon;`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*uuid, timestamptz, timestamptz, integer\\) to authenticated;`));
    }
    // The helpers are callable by nobody but the owner the RPCs run as.
    for (const name of ["_flag_shift_for_review", "_clock_pick_time", "_clock_review_sentence"]) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
    }
  });
});

describe("the ledger is server-only", () => {
  it("turns row security on and hands no client role a grant", () => {
    expect(SQL).toContain("alter table public.time_clock_actions enable row level security;");
    expect(SQL).toContain("revoke all on table public.time_clock_actions from public, anon, authenticated;");
    expect(SQL).not.toMatch(/grant [a-z, ]+ on (table )?public\.time_clock_actions/);
    expect(SQL).not.toMatch(/create policy .* on public\.time_clock_actions/);
  });

  it("makes every ledger row a child of a shift", () => {
    expect(SQL).toMatch(/shift_id\s+uuid not null references public\.time_shifts\(id\) on delete cascade/);
  });
});

describe("the legacy overloads keep the guards a stale bundle relies on", () => {
  const legacy = (name: string, arity: RegExp) =>
    functions().find((f) => f.name === name && !/security definer/.test(f.text) && arity.test(f.text));

  it("clock_out only closes an OPEN shift and says so when it cannot", () => {
    const f = legacy("clock_out", /p_injury_note text default null/)!;
    expect(f).toBeTruthy();
    expect(f.text).toContain("and status = 'open' and clock_out_at is null");
    expect(f.text).toContain("This shift was already clocked out. Nothing was changed.");
  });

  it("start_break only starts on an open shift", () => {
    const f = legacy("start_break", /p_break_type text default 'other'/)!;
    expect(f).toBeTruthy();
    expect(f.text).toContain("and status = 'open' and clock_out_at is null");
  });

  it("end_break no longer succeeds in silence with no break to end", () => {
    const f = legacy("end_break", /\(p_shift_id uuid\)/)!;
    expect(f).toBeTruthy();
    expect(f.text).toContain("We couldn''t find the start of that break");
    expect(f.text).not.toContain("select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();");
  });
});

describe("the keyed end_break commits its flag rather than raising it away", () => {
  it("returns an outcome and marks the shift on 'no_break_running'", () => {
    const f = functions().find((f) => f.name === "end_break" && /security definer/.test(f.text))!;
    expect(f.text).toContain("returns jsonb");
    expect(f.text).toContain("'no_break_running'");
    expect(f.text).toContain("perform public._flag_shift_for_review(v_open.id, 'break_end_without_break'");
    // Not a raise on that branch: a raise would roll the flag back with it.
    const branch = f.text.slice(f.text.indexOf("if v_open.break_started_at is null then"), f.text.indexOf("v_pick := public._clock_pick_time"));
    expect(branch).not.toContain("raise exception");
  });
});

describe("the review codes the server writes are the ones the timecard can say", () => {
  it("every code in the CHECK has a phrasebook line in both languages", () => {
    const check = SQL.slice(SQL.indexOf("time_shifts_review_reason_check"), SQL.indexOf("));", SQL.indexOf("time_shifts_review_reason_check")));
    const codes = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(7);
    for (const code of codes) {
      const key = `timecard.review.${code}` as keyof typeof CATALOG;
      expect(CATALOG[key], key).toBeTruthy();
      expect(CATALOG[key].es, key).not.toBe(CATALOG[key].en);
    }
  });

  it("uses only those codes in its own bodies", () => {
    const written = [...SQL.matchAll(/'(clock_unchecked|clock_off|tap_after_arrival|tap_too_old|tap_out_of_order|overlaps_previous_shift|previous_shift_open|break_end_without_break)'/g)];
    expect(written.length).toBeGreaterThan(8);
    expect(SQL).not.toMatch(/review_reason = '(?!clock_unchecked|clock_off|tap_after_arrival|tap_too_old|tap_out_of_order|overlaps_previous_shift|previous_shift_open|break_end_without_break)/);
  });
});

// Codex review of #640 (2026-09-24): a trusted tap was judged against nothing
// when no shift was open, and against the running break only when one was —
// so a clock-in could start inside a completed shift, and a clock-out or a
// second break could land inside a lunch that had already ended. The
// behaviour is proven in scripts/verify-clock-integrity.mjs; this keeps the
// shape that makes it possible from being edited away.
describe("every punch is judged against the whole timeline", () => {
  const keyed = (name: string) => functions().find((f) => f.name === name && /security definer/.test(f.text))!;
  const legacy = (name: string) => functions().find((f) => f.name === name && !/security definer/.test(f.text))!;

  it("a clock-in reads the person's timeline under a per-person lock and refuses to start inside a shift that still counts", () => {
    const f = keyed("clock_in");
    expect(f.text).toContain("pg_advisory_xact_lock(hashtextextended('clock_in:' || v_uid::text, 0))");
    expect(f.text).toContain("where profile_id = v_uid and status <> 'voided'");
    expect(f.text).toContain("'overlaps_previous_shift'");
    // The lock is taken before the replay lookup, so a tap resent neck and
    // neck with itself waits for the first copy and then finds its shift.
    expect(f.text.indexOf("pg_advisory_xact_lock")).toBeLessThan(f.text.indexOf("from public.time_clock_actions a"));
  });

  it("every clock RPC, legacy signatures included, stamps the shift's last punch", () => {
    for (const f of [keyed("clock_in"), keyed("clock_out"), legacy("clock_out"), keyed("start_break"), legacy("start_break"), keyed("end_break"), legacy("end_break")]) {
      expect(f.text, f.name).toContain("last_punch_at");
    }
    expect(SQL).toContain("alter table public.time_shifts add column if not exists last_punch_at timestamptz;");
  });

  it("a clock-out and a break start bound on that stamp, not only on the break still running", () => {
    expect(keyed("clock_out").text).toContain("greatest(v_open.clock_in_at, v_open.break_started_at, v_open.last_punch_at)");
    expect(keyed("start_break").text).toContain("greatest(v_open.clock_in_at, v_open.last_punch_at)");
    expect(keyed("end_break").text).toContain("greatest(v_open.break_started_at, v_open.last_punch_at)");
  });
});

it("is mirrored into docs/prototype-migrations.sql, verbatim", () => {
  const doc = readFileSync(PROTOTYPE, "utf8");
  expect(doc).toContain("20261028000000_clock_integrity.sql (mirrored)");
  // Verbatim, not "roughly": the mirror is what a fresh database is built
  // from, and a mirror that drifts is a schema nobody can reproduce.
  expect(doc).toContain(SQL);
});
