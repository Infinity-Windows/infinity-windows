// What 20261031000000_new_front_door.sql must keep saying about Release 0's
// keyed clock_in (Codex review of #642, 2026-09-25).
//
// The app calls clock_in through the eleven-argument overload 20261028000000
// added (the tap's one-time id, the mode, the tap time). The front door's
// paid-time rule has to open THAT door, not only the five older ones, so the
// migration restates it with the shared gate — and restates it exactly: the
// per-person lock, the replay answered before the gate, the tap-time rule, the
// timeline check against completed shifts, last_punch_at, the ledger and the
// review flag are Release 0's payroll fixes, and a restatement that dropped
// one would undo them quietly. The behaviour is proven on a real database by
// scripts/verify-new-front-door.mjs (both migrations applied in order) and
// the practice-run probe; this is the textual half, run with every npm test.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");
const RELEASE0 = read("20261028000000_clock_integrity.sql");
const FRONT_DOOR = read("20261031000000_new_front_door.sql");

/** The keyed overload's head: the argument list only it has. */
const KEYED_HEAD =
  "create or replace function public.clock_in(\n  p_project_id uuid,\n  p_cost_code_id uuid,\n  p_photo text,\n" +
  "  p_lat double precision,\n  p_lng double precision,\n  p_note text,\n  p_mode text,\n  p_client_id uuid,";

/** The keyed clock_in's create statement in a migration, through its `$$;`, or null. */
function keyedClockIn(sql: string): string | null {
  const start = sql.indexOf(KEYED_HEAD);
  if (start < 0) return null;
  expect(sql.indexOf(KEYED_HEAD, start + 1), "defined once per file").toBe(-1);
  return sql.slice(start, sql.indexOf("\n$$;\n", start) + 4);
}

const RELEASE0_GATE = [
  "  if not exists (",
  "    select 1 from public.toolbox_completions",
  "    where profile_id = v_uid and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date",
  "  ) then",
].join("\n");
const SHARED_GATE = "  if not public._toolbox_gate_open(v_uid) then";

describe("Release 0's keyed clock_in, restated by the new front door", () => {
  const release0 = keyedClockIn(RELEASE0)!;
  const restated = keyedClockIn(FRONT_DOOR);

  it("is restated at all: the door the app calls goes through the paid-time rule too", () => {
    expect(release0).toBeTruthy();
    expect(restated).toBeTruthy();
    expect(restated).toContain(SHARED_GATE);
    expect(restated).not.toContain("from public.toolbox_completions");
  });

  it("is Release 0's final body line for line, but for the gate condition", () => {
    expect(release0.split(RELEASE0_GATE)).toHaveLength(2);
    expect(restated).toBe(release0.replace(RELEASE0_GATE, SHARED_GATE));
  });

  it("keeps Release 0's payroll fixes, in their order: lock, replay before the gate, dangling close, timeline, ledger", () => {
    const at = (needle: string) => {
      const i = restated!.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at("perform pg_advisory_xact_lock(hashtextextended('clock_in:' || v_uid::text, 0));"),
      at("where a.client_id = p_client_id and a.profile_id = v_uid;"),
      at(SHARED_GATE),
      at("perform public._close_dangling_shift(v_uid);"),
      at("v_pick := (now(), false, 'overlaps_previous_shift')::public.clock_time_pick;"),
      at("note, job_mode, client_id, clock_in_at, last_punch_at, review_reason)"),
      at("insert into public.time_clock_actions"),
      at("perform public._flag_shift_for_review("),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("stays SECURITY DEFINER with its search path pinned, and callable by signed-in people only", () => {
    expect(restated).toContain("security definer\nset search_path = public, pg_temp");
    const sig = "public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer)";
    expect(FRONT_DOOR).toContain(`revoke all on function ${sig} from public, anon;`);
    expect(FRONT_DOOR).toContain(`grant execute on function ${sig} to authenticated;`);
  });

  it("is the LAST definition of that overload in migration order, so no later file puts an inline check back", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const defining = files.filter((f) => keyedClockIn(read(f)) !== null);
    expect(defining).toContain("20261028000000_clock_integrity.sql");
    expect(defining.at(-1)).toBe("20261031000000_new_front_door.sql");
  });

  it("every clock_in in the front door reads the shared gate, and none keeps an inline toolbox check", () => {
    const blocks = FRONT_DOOR.split(/\n(?=create or replace function (?:public\.)?clock_in\()/).slice(1);
    const bodies = blocks.map((b) => b.slice(0, b.indexOf("\n$$;\n")));
    expect(bodies).toHaveLength(6);
    for (const body of bodies) {
      expect(body).toMatch(/if not public\._toolbox_gate_open\((?:auth\.uid\(\)|v_uid)\) then/);
      expect(body).not.toContain("toolbox_completions");
    }
  });
});
