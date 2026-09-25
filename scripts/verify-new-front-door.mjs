// Release 1, the new front door (20261031000000): the actual migration under
// PostgreSQL, called the way the phone calls it. No live records.
//
// What this proves, in order:
//   1. set_my_ui_design writes ONLY the caller's own row and refuses junk.
//   2. The two owner RPCs refuse everyone below owner and do their one job.
//   3. The clock_in gate: unsigned is refused with the rule off; allowed once
//      the owner's date has arrived; a signature still opens it either way;
//      the offline client-id overload still dedupes. And Release 0's KEYED
//      clock_in (20261028000000, applied first — it merges first) — the
//      overload the app calls — goes through the same gate once 3f restates
//      it: refused with the rule off and for a date still ahead, open on the
//      date and with a signature; a resend of a saved id answered even after
//      the gate has closed; the ledger row, last_punch_at, the tap-time rule,
//      the timeline check against a completed shift and the per-person lock
//      all still there; and the body on the database is 20261028000000's but
//      for the one gate condition (Codex review of #642, 2026-09-25).
//   4. Unit work stays locked until the talk is signed (K1.3), on EVERY door,
//      even on a shift the rule opened unsigned: start_opening_work,
//      start_opening_phase, start_unit_session (both roles),
//      resume_opening_phase, custom_work_command 'start' with a unit, and
//      answer_summon are each refused with the one plain sentence and write
//      nothing; Prep time (a 'start' with no unit) is refused too, in its
//      own sentence, and writes nothing (the owner's answer, 2026-09-24);
//      signed, every door opens and does exactly what it did before, Prep
//      time included. The bodies under test are the REAL current ones —
//      20260969000000, 20260811010000, 20261011000000 and 20260963000000 are
//      loaded first, so the migration's create-or-replace lands on the true
//      signatures — not stubs of an older shape.
//   5. The three announcements exist in both languages for their audiences.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();
const migration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

/** One `create … function <head>` statement out of a migration, verbatim, through its `$$;` line. */
async function fnFrom(file, head) {
  const src = await migration(file);
  const start = src.indexOf(head);
  assert.ok(start >= 0, `${head} is defined in ${file}`);
  assert.equal(src.indexOf(head, start + 1), -1, `${head} is defined once in ${file}`);
  const end = src.indexOf("\n$$;\n", start);
  assert.ok(end > start, `${head} in ${file} ends with $$;`);
  return src.slice(start, end + 5);
}

// The slice of the real schema these functions touch. Column lists follow the
// live migrations (20260720000000 client_id, 20260723060030 note,
// 20260970000000 job_mode, 20260976000000 company_settings, 20260718007000
// task_sessions, 20260811000000/20260811010000 opening_phases, 20260820000000
// unit_sessions, 20260818000000 summons, 20260717004000 points_ledger).
await db.exec(`
create role authenticated; create role anon; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to authenticated, anon;

create table profiles (
  id uuid primary key, role text, rank integer, language text not null default 'en',
  is_partner boolean default false, active boolean not null default true,
  updated_at timestamptz default now()
);
create function public.role_rank(r text) returns int language sql immutable as
  $$ select case r when 'installer' then 0 when 'foreman' then 1 when 'supervisor' then 2 when 'owner' then 3 else 0 end $$;
create function public.my_role_rank() returns int language sql stable security definer as
  $$ select public.role_rank((select role from profiles where id = auth.uid())) $$;
create function public.is_partner_user() returns boolean language sql stable security definer as
  $$ select coalesce((select is_partner from profiles where id = auth.uid()), false) $$;
insert into profiles(id, role, rank)
  select ('00000000-0000-4000-8000-00000000000' || i)::uuid,
         (array['installer','foreman','supervisor','owner'])[i], i - 1
  from generate_series(1, 4) i;
-- The column grants 20260729200000 made per-column; the migration adds ui_design.
grant select (id, role, language) on profiles to authenticated;

create table projects (id uuid primary key, deleted_at timestamptz);
insert into projects (id) values ('00000000-0000-4000-8000-0000000000bb');
-- The custom-work read policies look the job up as the caller.
grant select on projects to authenticated;

create table company_settings (
  id integer primary key default 1 check (id = 1),
  evening_nudge_local_time time not null default '17:30',
  evening_nudge_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into company_settings (id) values (1);
alter table company_settings enable row level security;
revoke all on company_settings from anon, authenticated;
grant select on company_settings to authenticated;
create policy "crew read" on company_settings for select to authenticated using (not public.is_partner_user());

create table toolbox_completions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid, signed_at timestamptz not null default now()
);
alter table toolbox_completions enable row level security;
grant select, insert on toolbox_completions to authenticated;
create policy "own rows" on toolbox_completions for all to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create table time_shifts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null, project_id uuid, cost_code_id uuid,
  clock_in_at timestamptz not null default now(), clock_out_at timestamptz,
  clock_in_photo text, clock_in_lat double precision, clock_in_lng double precision,
  status text not null default 'open', client_id uuid, note text, job_mode text,
  break_seconds integer not null default 0, break_started_at timestamptz
);
-- What Release 0's keyed clock_in writes beside the shift: the audit line a
-- review mark leaves (20260718040000's columns), and the shift cap its
-- tap-time rule reads (20260730230000).
create table time_shift_edits (
  id uuid primary key default gen_random_uuid(), shift_id uuid, edited_by uuid,
  field text, old_value text, new_value text, reason text, created_at timestamptz default now()
);
create function public.shift_cap_hours() returns int language sql immutable as $$ select 16 $$;
grant select, insert, update on time_shifts to authenticated;
create function _close_dangling_shift(p_uid uuid) returns void language sql as
  $$ update time_shifts set clock_out_at = now(), status = 'submitted' where profile_id = p_uid and clock_out_at is null $$;

create table project_openings (
  id uuid primary key, project_id uuid references projects(id), status text not null default 'planned',
  assigned_to uuid, removed_at timestamptz, work_started_at timestamptz
);
grant select, update on project_openings to authenticated;
insert into project_openings (id, project_id) values
  ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb'),
  ('00000000-0000-4000-8000-0000000000ee', '00000000-0000-4000-8000-0000000000bb');

create table task_sessions (
  id uuid primary key default gen_random_uuid(), profile_id uuid, opening_id uuid, project_id uuid,
  state text not null default 'on_task', started_at timestamptz not null default now(), ended_at timestamptz
);
grant select, insert, update on task_sessions to authenticated;
create table unit_sessions (
  id uuid primary key default gen_random_uuid(), opening_id uuid, profile_id uuid,
  role text not null default 'install', is_rework boolean not null default false,
  started_at timestamptz not null default now(), ended_at timestamptz, end_reason text
);
create table opening_phases (
  id uuid primary key default gen_random_uuid(), opening_id uuid, kind text, started_by uuid,
  status text not null default 'active', started_at timestamptz not null default now(),
  paused_at timestamptz, paused_seconds int not null default 0,
  submitted_at timestamptz, submitted_by uuid, photo_path text, minutes int,
  unique (opening_id, kind)
);
create table summons (
  id uuid primary key default gen_random_uuid(), project_id uuid, opening_id uuid, requested_by uuid,
  needed int not null, needed_at timestamptz, note text, status text not null default 'open',
  created_at timestamptz not null default now(), closed_at timestamptz
);
create table summon_helpers (
  id uuid primary key default gen_random_uuid(), summon_id uuid references summons(id), profile_id uuid,
  joined_at timestamptz not null default now(), completed_at timestamptz, canceled_at timestamptz, minutes int,
  unique (summon_id, profile_id)
);
create table summon_declines (summon_id uuid, profile_id uuid, created_at timestamptz default now(), primary key (summon_id, profile_id));
create table points_ledger (
  id uuid primary key default gen_random_uuid(), profile_id uuid, kind text, points int, ref text,
  status text not null default 'confirmed', created_at timestamptz default now()
);

-- What the bodies call and this harness does not test.
create function _flashing_outstanding(p uuid) returns boolean language sql as $$ select false $$;
create function close_open_task_sessions(p uuid) returns void language sql as
  $$ update task_sessions set ended_at = now() where profile_id = p and ended_at is null $$;
create function _close_stale_sessions(p uuid) returns void language sql as $$ select $$;
create function _end_open_session(p uuid, r text) returns void language sql as
  $$ update unit_sessions set ended_at = now(), end_reason = r where profile_id = p and ended_at is null $$;
create function _has_open_redo(p uuid) returns boolean language sql as $$ select false $$;
create function _is_lead(p uuid) returns boolean language sql as
  $$ select exists (select 1 from profiles where id = p and role in ('foreman', 'supervisor', 'owner')) $$;
create function is_test_profile(p uuid) returns boolean language sql as $$ select false $$;
create function attach_sandbox_guards() returns void language sql as $$ select $$;

create table app_release_notes (
  id text primary key, published_on date not null, audience int[] not null, kind text not null,
  title_en text not null, title_es text not null, body_en text not null, body_es text not null,
  href text, withdrawn_at timestamptz
);
`);

// The unit-work doors as master defines them today, so the migration's
// create-or-replace meets the true signatures (a changed return type or
// argument list would fail right here). Older migrations name tables this
// slice does not carry, so their bodies are not checked at load; the
// migration under test is, below.
await db.exec("set check_function_bodies = off");
await db.exec(await migration("20260969000000_drop_redundant_toolbox_recheck.sql"));
await db.exec(await fnFrom("20260811010000_phase_pause.sql", "create or replace function resume_opening_phase("));
await db.exec(await migration("20261011000000_custom_work.sql"));
await db.exec(await fnFrom("20260963000000_summon_expiry.sql", "create or replace function unit_sessions_follow_summon_helpers("));
await db.exec("create trigger unit_sessions_follow_summon_helpers after insert or update on summon_helpers for each row execute function unit_sessions_follow_summon_helpers()");
await db.exec(await fnFrom("20260963000000_summon_expiry.sql", "create or replace function answer_summon("));
// Release 0 (20261028000000) merges before this migration, so it is on the
// database first — its keyed clock_in included, the overload 3f must replace.
// Body checking stays off for it, as in verify-clock-integrity.mjs: its
// person_record_counts names tables this slice does not carry.
const RELEASE0 = await migration("20261028000000_clock_integrity.sql");
await db.exec(RELEASE0);
await db.exec("set check_function_bodies = on");

await db.exec(await migration("20261031000000_new_front_door.sql"));

const uid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
// The company-local day, exactly as set_paid_time_rule_date and the gate
// compute it. `current_date` is the SESSION's day — UTC on a CI runner — and
// from 18:00 in Denver it is already tomorrow there, so "yesterday" was
// Denver's today and the past-date refusal went missing (CI, 2026-09-25 02:43 UTC).
const TODAY = "(now() at time zone 'America/Denver')::date";
const JOB = "00000000-0000-4000-8000-0000000000bb";
const COST = "00000000-0000-4000-8000-0000000000cc";
const OPENING = "00000000-0000-4000-8000-0000000000aa";
const PAUSED_OPENING = "00000000-0000-4000-8000-0000000000ee";
async function as(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid(n)]);
  await db.exec("set role authenticated");
}
async function admin() {
  await db.exec("reset role");
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const count = async (sql, params = []) => (await one(`select count(*)::int as n from ${sql}`, params)).n;
let seq = 0;
const fresh = () => `00000000-0000-4000-8000-0000000${String(++seq).padStart(5, "0")}`;

// ---- 1. the person's own front door -------------------------------------
await as(1);
assert.equal((await one("select ui_design from profiles where id = $1", [uid(1)])).ui_design, "classic");
await db.query("select set_my_ui_design('new')");
assert.equal((await one("select ui_design from profiles where id = $1", [uid(1)])).ui_design, "new");
// Only their own row moved.
assert.equal((await one("select ui_design from profiles where id = $1", [uid(2)])).ui_design, "classic");
await assert.rejects(() => db.query("select set_my_ui_design('neon')"), /classic or new/);
await assert.rejects(() => db.query("update profiles set ui_design = 'new' where id = $1", [uid(2)]));
await db.query("select set_my_ui_design(' Classic ')");
assert.equal((await one("select ui_design from profiles where id = $1", [uid(1)])).ui_design, "classic");

// ---- 2. the owner's two switches -----------------------------------------
for (const n of [1, 2, 3]) {
  await as(n);
  await assert.rejects(() => db.query("select set_new_design_switch('r1', false)"), /Only an owner/);
  await assert.rejects(() => db.query(`select set_paid_time_rule_date(${TODAY})`), /Only an owner/);
}
await as(4);
assert.equal((await one("select new_design_r1_enabled from company_settings")).new_design_r1_enabled, true);
await db.query("select set_new_design_switch('r1', false)");
assert.equal((await one("select new_design_r1_enabled from company_settings")).new_design_r1_enabled, false);
await assert.rejects(() => db.query("select set_new_design_switch('r9', true)"), /Unknown release/);
await db.query("select set_new_design_switch('r1', true)");
// Crew can READ the switch (the app resolves the design from it) but not write it.
await as(1);
assert.equal((await one("select new_design_r1_enabled from company_settings")).new_design_r1_enabled, true);
await assert.rejects(() => db.query("update company_settings set new_design_r1_enabled = false"));

// ---- 3. the clock_in gate -------------------------------------------------
const punch = () =>
  db.query("select id, profile_id from clock_in($1, $2, null, null, null, 'note', 'data')", [JOB, COST]);
await as(1);
// Rule off, unsigned: refused — exactly today's behaviour.
await assert.rejects(punch, /toolbox talk/);
assert.equal(await count("time_shifts"), 0);

// The owner picks a date in the future: still today's timing until then.
await as(4);
await assert.rejects(() => db.query(`select set_paid_time_rule_date(${TODAY} - 1)`), /cannot start in the past/);
await db.query(`select set_paid_time_rule_date(${TODAY} + 7)`);
await as(1);
await assert.rejects(punch, /toolbox talk/);

// The date arrives: the Start day tap clocks in, unsigned, on every overload.
await as(4);
await db.query(`select set_paid_time_rule_date(${TODAY})`);
await as(1);
const first = (await punch()).rows[0];
assert.equal(first.profile_id, uid(1));
assert.equal((await one("select job_mode, note from time_shifts where id = $1", [first.id])).job_mode, "data");

// ---- 4. unit work stays locked until signed — every door (K1.3) ----------
// The installer is on the clock, unsigned, on a shift the rule opened. Set
// the doors up: a flashing phase they paused yesterday, a summon a foreman
// put out on their unit, and a saved custom unit (the 'unit' action records
// a unit and starts nothing, so it is rightly not gated).
await admin();
await db.query(
  "insert into opening_phases (opening_id, kind, started_by, status, started_at, paused_at) values ($1, 'flashing', $2, 'active', now() - interval '1 day', now() - interval '5 minutes')",
  [PAUSED_OPENING, uid(1)],
);
const summonId = (await one("insert into summons (project_id, opening_id, requested_by, needed) values ($1, $2, $3, 1) returning id", [JOB, OPENING, uid(2)])).id;
await as(1);
const UNIT = fresh();
await db.query("select custom_work_command($1, 'unit', $2)", [
  fresh(),
  { id: UNIT, revision: 0, project_id: JOB, opening_id: null, label: "16", type_label: "Slider", facts: {}, reason: "harness" },
]);
const startCustomUnit = () =>
  one("select custom_work_command($1, 'start', $2) as id", [
    fresh(),
    { id: fresh(), unit_id: UNIT, shift_id: first.id, project_id: JOB, expected_session_id: null, stage: "Installing", participation: "install", description: "" },
  ]);
const doors = {
  start_opening_work: () => db.query("select start_opening_work($1)", [OPENING]),
  start_opening_phase: () => db.query("select start_opening_phase($1, 'flashing')", [OPENING]),
  "start_unit_session (install)": () => db.query("select start_unit_session($1, 'install')", [OPENING]),
  "start_unit_session (helper)": () => db.query("select start_unit_session($1, 'helper')", [OPENING]),
  resume_opening_phase: () => db.query("select resume_opening_phase($1, 'flashing')", [PAUSED_OPENING]),
  "custom_work_command start (a unit)": startCustomUnit,
  answer_summon: () => db.query("select answer_summon($1)", [summonId]),
};
const SENTENCE = /Sign today's toolbox talk before starting work on a unit\./;
for (const [door, open] of Object.entries(doors)) {
  await assert.rejects(open, SENTENCE, `${door}: refused unsigned on a shift the rule opened`);
}
// …and none of them wrote anything.
await admin();
const written = async () => ({
  task: await count("task_sessions"),
  unit: await count("unit_sessions"),
  phase: await count("opening_phases where opening_id = $1", [OPENING]),
  custom_unit: await count("custom_work_sessions where kind = 'unit'"),
  helper: await count("summon_helpers"),
  stamped: await count("project_openings where work_started_at is not null"),
  resumed: await count("opening_phases where opening_id = $1 and paused_at is null", [PAUSED_OPENING]),
});
assert.deepEqual(await written(), { task: 0, unit: 0, phase: 0, custom_unit: 0, helper: 0, stamped: 0, resumed: 0 });

// Prep time (a 'start' with no unit) waits for the same signature, in its
// own sentence (the owner's answer, 2026-09-24), and writes nothing.
const PREP_SENTENCE = /Sign today's toolbox talk before starting work\./;
const startPrep = (expected) =>
  one("select custom_work_command($1, 'start', $2) as id", [
    fresh(),
    { id: fresh(), unit_id: null, shift_id: first.id, expected_session_id: expected, description: "Hauling" },
  ]);
await as(1);
await assert.rejects(() => startPrep(null), PREP_SENTENCE, "Prep time: refused unsigned on a shift the rule opened");
await admin();
assert.equal(await count("custom_work_sessions where kind = 'idle'"), 0, "a refused Prep start wrote nothing");
await as(1);

// Signing today's talk unlocks every door, and each does what it always did.
await db.query("insert into toolbox_completions (profile_id) values ($1)", [uid(1)]);
const opened = (await db.query("select * from start_opening_work($1)", [OPENING])).rows[0];
assert.ok(opened.work_started_at, "start_opening_work stamps work_started_at");
await admin();
assert.equal(await count("task_sessions where profile_id = $1 and opening_id = $2 and state = 'on_task' and ended_at is null", [uid(1), OPENING]), 1);
await as(1);
const phase = (await db.query("select * from start_opening_phase($1, 'flashing')", [OPENING])).rows[0];
assert.deepEqual([phase.status, phase.started_by], ["active", uid(1)]);
const resumed = (await db.query("select * from resume_opening_phase($1, 'flashing')", [PAUSED_OPENING])).rows[0];
assert.equal(resumed.paused_at, null, "resume clears the pause");
assert.ok(resumed.paused_seconds >= 299, "and books the paused minutes");
const session = (await db.query("select * from start_unit_session($1, 'install')", [OPENING])).rows[0];
assert.deepEqual([session.profile_id, session.role, session.ended_at], [uid(1), "install", null]);
const customId = (await startCustomUnit()).id;
assert.deepEqual(await one("select kind, stage, participation from custom_work_sessions where id = $1", [customId]), { kind: "unit", stage: "Installing", participation: "install" });
await admin();
// Today's behaviour, unchanged: a custom start hands off the map session and pauses the phases.
assert.equal((await one("select end_reason from unit_sessions where id = $1", [session.id])).end_reason, "handoff");
assert.equal(await count("opening_phases where started_by = $1 and status = 'active' and paused_at is null", [uid(1)]), 0);
// Signed, Prep time starts exactly as it always did: the same row, the same
// stored identifiers, handing off the running custom unit session. (Before
// the summon: its helper session ends any open custom session, by design.)
await as(1);
const idleId = (await startPrep(customId)).id;
assert.deepEqual(await one("select kind, stage, description from custom_work_sessions where id = $1", [idleId]), { kind: "idle", stage: "Idle time", description: "Hauling" });
await admin();
assert.equal((await one("select end_reason from custom_work_sessions where id = $1", [customId])).end_reason, "switch", "the unit session handed off to Prep time");
await as(1);
await db.query("select custom_work_command($1, 'stop', $2)", [fresh(), { expected_session_id: idleId, outcome: "finished" }]);
const answered = (await db.query("select * from answer_summon($1)", [summonId])).rows[0];
assert.equal(answered.profile_id, uid(1));
await admin();
assert.equal(await count("unit_sessions where profile_id = $1 and role = 'helper' and opening_id = $2 and ended_at is null", [uid(1), OPENING]), 1, "the trigger opened the helper session");
assert.equal(await count("points_ledger where profile_id = $1 and kind = 'summon_answer'", [uid(1)]), 1);

// One helper, every door: the gate cannot be dropped from one path and kept
// on another without this list changing.
const gated = (await db.query(
  "select proname from pg_proc where pronamespace = 'public'::regnamespace and position('_unit_work_gate' in prosrc) > 0 order by proname",
)).rows.map((r) => r.proname);
assert.deepEqual(gated, ["answer_summon", "custom_work_command", "resume_opening_phase", "start_opening_phase", "start_opening_work", "start_unit_session"]);
// …and the Prep-time gate sits on the one path that starts Prep time.
const prepGated = (await db.query(
  "select proname from pg_proc where pronamespace = 'public'::regnamespace and position('_prep_time_gate' in prosrc) > 0 order by proname",
)).rows.map((r) => r.proname);
assert.deepEqual(prepGated, ["custom_work_command"]);
assert.ok((await one("select prosrc from pg_proc where proname = '_toolbox_gate_open'")).prosrc.includes("_toolbox_signed_today"), "the clock-in gate reads the one signed-today helper");
assert.ok((await one("select prosrc from pg_proc where proname = '_unit_work_gate'")).prosrc.includes("_toolbox_signed_today"), "so does the unit-work gate");
assert.ok((await one("select prosrc from pg_proc where proname = '_prep_time_gate'")).prosrc.includes("_toolbox_signed_today"), "and the Prep-time gate");

// Rule off or on, an unsigned person with NO shift still meets the shift
// sentence first — the order today's callers see is unchanged.
await as(3);
await assert.rejects(() => db.query("select start_unit_session($1, 'install')", [OPENING]), /clock in before starting a task/);
await assert.rejects(() => db.query("select start_opening_work($1)", [OPENING]), /clock in before starting a task/);
await assert.rejects(() => db.query("select answer_summon($1)", [summonId]), /clock in before answering a summon/);

// ---- back to the clock_in gate: the offline overload, the rule off again --
await as(1);
// The offline overload dedupes on the client id and passes the same gate.
const cid = "00000000-0000-4000-8000-0000000000dd";
const q1 = (await db.query("select id from clock_in($1, $2, null, null, null, $3::uuid)", [JOB, COST, cid])).rows[0];
const q2 = (await db.query("select id from clock_in($1, $2, null, null, null, $3::uuid)", [JOB, COST, cid])).rows[0];
assert.equal(q1.id, q2.id, "a resent offline clock-in is the same shift");

// Rule switched off again: a signature still opens the gate, unsigned is refused.
await as(4);
await db.query("select set_paid_time_rule_date(null)");
await as(2);
await assert.rejects(punch, /toolbox talk/);
await db.query("insert into toolbox_completions (profile_id) values ($1)", [uid(2)]);
assert.equal((await punch()).rows[0].profile_id, uid(2));

// The five-argument and note overloads share the one gate.
await as(3);
await assert.rejects(() => db.query("select clock_in($1, $2)", [JOB, COST]), /toolbox talk/);
await assert.rejects(() => db.query("select clock_in($1, $2, null, null, null, 'n')", [JOB, COST]), /toolbox talk/);

// ---- 3 (again). Release 0's keyed clock_in — the overload the app calls ----
// Codex review of #642 (2026-09-25): this migration used to re-issue only the
// five older overloads, while the app has called 20261028000000's keyed one
// since #640 — which kept its own inline signature check — so the owner's rule
// opened five doors the phone no longer uses and left its own shut. 3f
// restates it with the shared gate. Called here exactly as the app calls it:
// by name, all eleven arguments.
const KEYED_IN =
  "select * from clock_in(p_project_id => $1, p_cost_code_id => $2, p_photo => null, p_lat => null, p_lng => null, " +
  "p_note => $3, p_mode => $4, p_client_id => $5, p_tapped_at => $6, p_clock_checked_at => $7, p_clock_skew_ms => $8)";
const keyed = async (clientId, { mode = "data", tap = null, checked = null, skew = null } = {}) =>
  (await db.query(KEYED_IN, [JOB, COST, "keyed", mode, clientId, tap, checked, skew])).rows[0];
const ago = (m) => new Date(Date.now() - m * 60e3).toISOString();
const near = (a, b, ms, msg) => assert.ok(Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= ms, `${msg}: ${a} vs ${b}`);
await admin();
for (const n of [5, 6, 7, 8, 9]) await db.query("insert into profiles (id, role, rank) values ($1, 'installer', 0)", [uid(n)]);

// The rule is off again (above). Unsigned: refused, and nothing written.
const k1 = fresh();
await as(5);
await assert.rejects(() => keyed(k1), /complete today's toolbox talk before clocking in/, "keyed, rule off, unsigned: refused");
await admin();
assert.equal(await count("time_shifts where profile_id = $1", [uid(5)]), 0, "keyed, refused: no shift");
assert.equal(await count("time_clock_actions where client_id = $1", [k1]), 0, "keyed, refused: no ledger row");
// A date still ahead: still today's timing.
await as(4);
await db.query(`select set_paid_time_rule_date(${TODAY} + 7)`);
await as(5);
await assert.rejects(() => keyed(k1), /toolbox talk/, "keyed, rule set for a day ahead: still refused unsigned");
// The date arrives: the Start day tap clocks in unsigned through the keyed door.
await as(4);
await db.query(`select set_paid_time_rule_date(${TODAY})`);
await as(5);
const s5 = await keyed(k1, { mode: "tracking" });
assert.deepEqual([s5.profile_id, s5.client_id, s5.job_mode, s5.review_reason], [uid(5), k1, "tracking", null], "keyed, rule on, unsigned: clocks in");
assert.equal(new Date(s5.last_punch_at).getTime(), new Date(s5.clock_in_at).getTime(), "the shift remembers its last punch (20261028000000 §1b)");
await admin();
assert.deepEqual(
  await one("select action, outcome, profile_id, used_tap_time from time_clock_actions where client_id = $1", [k1]),
  { action: "clock_in", outcome: "clocked_in", profile_id: uid(5), used_tap_time: false },
  "one ledger row for the tap",
);
// The same tap again, after the owner has switched the rule off — the gate
// is closed now — is answered with the shift it made: the replay lookup
// comes before the gate, as it does in 20261028000000.
await as(4);
await db.query("select set_paid_time_rule_date(null)");
await as(5);
assert.equal((await keyed(k1, { mode: "tracking" })).id, s5.id, "a resend of a saved id is the same shift, gate open or not");
await admin();
assert.equal(await count("time_shifts where profile_id = $1", [uid(5)]), 1, "still one shift");
assert.equal(await count("time_clock_actions where client_id = $1", [k1]), 1, "still one ledger row");
// Rule off, signed: the keyed door opens exactly as before.
await as(6);
await assert.rejects(() => keyed(fresh()), /toolbox talk/);
await db.query("insert into toolbox_completions (profile_id) values ($1)", [uid(6)]);
assert.equal((await keyed(fresh())).profile_id, uid(6), "keyed, rule off, signed: clocks in");

// The tap-time rule survived the restatement: a trusted tap on a clean
// timeline pays from the tap, and the ledger says pay used it.
await admin();
await db.query("insert into toolbox_completions (profile_id) values ($1), ($2), ($3)", [uid(7), uid(8), uid(9)]);
const trust = (m) => ({ tap: ago(m), checked: ago(30), skew: 0 });
const t7 = fresh();
await as(7);
const s7 = await keyed(t7, trust(10));
near(s7.clock_in_at, ago(10), 5000, "a trusted tap on a clean timeline pays from the tap");
assert.equal(s7.review_reason, null);
await admin();
assert.equal((await one("select used_tap_time from time_clock_actions where client_id = $1", [t7])).used_tap_time, true);
// …and so did the timeline check (Codex review of #640): a completed,
// approved shift T-120m → T-60m, then a clock-in tapped at T-90m, starts at
// arrival and is marked for the foreman instead of paying the overlap twice.
await db.query(
  "insert into time_shifts (profile_id, project_id, cost_code_id, clock_in_at, clock_out_at, status) values ($1, $2, $3, $4, $5, 'approved')",
  [uid(8), JOB, COST, ago(120), ago(60)],
);
await as(8);
const late = await keyed(fresh(), trust(90));
assert.equal(late.review_reason, "overlaps_previous_shift", "a tap inside a completed shift is marked for the foreman");
near(late.clock_in_at, new Date().toISOString(), 5000, "and pays from arrival, not from the tap");
await admin();
assert.equal(await count("time_shift_edits where shift_id = $1 and field = 'review_reason'", [late.id]), 1, "with its audit line");
// The per-person lock is held for the transaction (one connection: held, not contended).
await db.exec("begin");
await as(9);
await keyed(fresh());
await db.exec("reset role");
assert.ok((await one("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).n >= 1, "clock_in holds its per-person lock while the transaction is open");
await db.exec("commit");
await admin();
assert.equal((await one("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).n, 0, "and lets go of it at commit");

// Six doors, one gate — and the keyed body on the database is Release 0's,
// line for line, but for the gate condition.
assert.deepEqual(
  await one("select count(*) filter (where position('_toolbox_gate_open' in prosrc) > 0)::int as gated, count(*)::int as total from pg_proc where proname = 'clock_in' and pronamespace = 'public'::regnamespace"),
  { gated: 6, total: 6 },
  "every clock_in overload on the database routes through _toolbox_gate_open",
);
const KEYED_SIG = "public.clock_in(uuid, uuid, text, double precision, double precision, text, text, uuid, timestamptz, timestamptz, integer)";
const live = await one(`select prosrc, prosecdef, proconfig from pg_proc where oid = '${KEYED_SIG}'::regprocedure`);
const r0Start = RELEASE0.indexOf("create or replace function public.clock_in(\n  p_project_id uuid,\n  p_cost_code_id uuid,\n  p_photo text,\n  p_lat double precision,\n  p_lng double precision,\n  p_note text,\n  p_mode text,\n  p_client_id uuid,");
assert.ok(r0Start >= 0, "20261028000000 defines the keyed clock_in");
const r0Body = RELEASE0.slice(RELEASE0.indexOf("as $$", r0Start) + 5, RELEASE0.indexOf("\n$$;\n", r0Start) + 1);
const R0_GATE =
  "  if not exists (\n    select 1 from public.toolbox_completions\n    where profile_id = v_uid and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date\n  ) then";
assert.equal(r0Body.split(R0_GATE).length, 2, "Release 0's keyed body carries its inline check exactly once");
assert.equal(live.prosrc, r0Body.replace(R0_GATE, "  if not public._toolbox_gate_open(v_uid) then"), "the keyed body on the database is Release 0's, but for the gate");
assert.equal(live.prosecdef, true, "still SECURITY DEFINER");
assert.deepEqual(live.proconfig, ["search_path=public, pg_temp"], "with its search path pinned");

// ---- 5. the announcements ------------------------------------------------
await admin();
const notes = (await db.query("select id, audience, title_es, body_es from app_release_notes order by id")).rows;
assert.deepEqual(
  notes.map((n) => n.id),
  ["2026-09-23-new-design-choice", "2026-09-23-new-design-owner-switches", "2026-09-23-prep-time"],
);
for (const n of notes) {
  assert.ok(n.title_es.length > 10 && n.body_es.length > 40, `${n.id} speaks Spanish`);
}
assert.deepEqual(notes.find((n) => n.id === "2026-09-23-new-design-owner-switches").audience, [3]);

console.log(
  "New front door: own-row design choice, owner-only switches, the one clock-in gate on all six clock_in doors including Release 0's keyed one (rule off / scheduled / on, signed, replay, ledger, tap time, timeline, lock, body pinned to 20261028000000), unit work locked on all six doors and Prep time on its one door until signed, and bilingual announcements passed.",
);
await db.close();
