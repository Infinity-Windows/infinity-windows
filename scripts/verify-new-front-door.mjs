// Release 1, the new front door (20261031000000): the actual migration under
// PostgreSQL, called the way the phone calls it. No live records.
//
// What this proves, in order:
//   1. set_my_ui_design writes ONLY the caller's own row and refuses junk.
//   2. The two owner RPCs refuse everyone below owner and do their one job.
//   3. The clock_in gate: unsigned is refused with the rule off; allowed once
//      the owner's date has arrived; a signature still opens it either way;
//      the offline client-id overload still dedupes; unit work still refuses
//      without a signature whatever the rule says.
//   4. The three announcements exist in both languages for their audiences.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();

// The slice of the real schema these functions touch. Column lists follow the
// live migrations (20260720000000 client_id, 20260723060030 note,
// 20260970000000 job_mode, 20260976000000 company_settings).
await db.exec(`
create role authenticated; create role anon; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to authenticated, anon;

create table profiles (
  id uuid primary key, role text, rank integer, language text not null default 'en',
  is_partner boolean default false, updated_at timestamptz default now()
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
grant select, insert, update on time_shifts to authenticated;
create function _close_dangling_shift(p_uid uuid) returns void language sql as
  $$ update time_shifts set clock_out_at = now(), status = 'submitted' where profile_id = p_uid and clock_out_at is null $$;

create table project_openings (id uuid primary key, project_id uuid, work_started_at timestamptz);
grant select, update on project_openings to authenticated;
create table task_sessions (profile_id uuid, opening_id uuid, project_id uuid, state text);
grant insert on task_sessions to authenticated;
create function _flashing_outstanding(p uuid) returns boolean language sql as $$ select false $$;
create function close_open_task_sessions(p uuid) returns void language sql as $$ select $$;
insert into project_openings (id, project_id) values ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb');

create table app_release_notes (
  id text primary key, published_on date not null, audience int[] not null, kind text not null,
  title_en text not null, title_es text not null, body_en text not null, body_es text not null,
  href text, withdrawn_at timestamptz
);
`);

// The unit-work gate the migration deliberately leaves alone (20260813000000).
await db.exec(`
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings language plpgsql as $$
declare v_opening project_openings; v_uid uuid := auth.uid();
begin
  if not exists (select 1 from time_shifts where profile_id = v_uid and status = 'open' and clock_out_at is null) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;
  if not exists (select 1 from toolbox_completions where profile_id = v_uid
      and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date) then
    raise exception 'clock in and complete today''s toolbox talk before starting a task';
  end if;
  update project_openings set work_started_at = coalesce(work_started_at, now()) where id = p_opening_id returning * into v_opening;
  return v_opening;
end; $$;
`);

await db.exec(
  await readFile(new URL("../supabase/migrations/20261031000000_new_front_door.sql", import.meta.url), "utf8"),
);

const uid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
async function as(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid(n)]);
  await db.exec("set role authenticated");
}
async function admin() {
  await db.exec("reset role");
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

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
  await assert.rejects(() => db.query("select set_paid_time_rule_date(current_date)"), /Only an owner/);
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
  db.query("select id, profile_id from clock_in($1, $2, null, null, null, 'note', 'data')", [
    "00000000-0000-4000-8000-0000000000bb",
    "00000000-0000-4000-8000-0000000000cc",
  ]);
await as(1);
// Rule off, unsigned: refused — exactly today's behaviour.
await assert.rejects(punch, /toolbox talk/);
assert.equal((await one("select count(*)::int as n from time_shifts")).n, 0);

// The owner picks a date in the future: still today's timing until then.
await as(4);
await assert.rejects(() => db.query("select set_paid_time_rule_date(current_date - 1)"), /cannot start in the past/);
await db.query("select set_paid_time_rule_date(current_date + 7)");
await as(1);
await assert.rejects(punch, /toolbox talk/);

// The date arrives: the Start day tap clocks in, unsigned, on every overload.
await as(4);
await db.query("select set_paid_time_rule_date(current_date)");
await as(1);
const first = (await punch()).rows[0];
assert.equal(first.profile_id, uid(1));
assert.equal((await one("select job_mode, note from time_shifts where id = $1", [first.id])).job_mode, "data");
// Unit work is STILL locked until the talk is signed (K1.3).
await assert.rejects(
  () => db.query("select start_opening_work('00000000-0000-4000-8000-0000000000aa')"),
  /toolbox talk/,
);
// The offline overload dedupes on the client id and passes the same gate.
const cid = "00000000-0000-4000-8000-0000000000dd";
const q1 = (await db.query("select id from clock_in($1, $2, null, null, null, $3::uuid)", [
  "00000000-0000-4000-8000-0000000000bb", "00000000-0000-4000-8000-0000000000cc", cid,
])).rows[0];
const q2 = (await db.query("select id from clock_in($1, $2, null, null, null, $3::uuid)", [
  "00000000-0000-4000-8000-0000000000bb", "00000000-0000-4000-8000-0000000000cc", cid,
])).rows[0];
assert.equal(q1.id, q2.id, "a resent offline clock-in is the same shift");
// Signing today's talk unlocks unit work.
await db.query("insert into toolbox_completions (profile_id) values ($1)", [uid(1)]);
await db.query("select start_opening_work('00000000-0000-4000-8000-0000000000aa')");

// Rule switched off again: a signature still opens the gate, unsigned is refused.
await as(4);
await db.query("select set_paid_time_rule_date(null)");
await as(2);
await assert.rejects(punch, /toolbox talk/);
await db.query("insert into toolbox_completions (profile_id) values ($1)", [uid(2)]);
assert.equal((await punch()).rows[0].profile_id, uid(2));

// The five-argument and note overloads share the one gate.
await as(3);
await assert.rejects(() => db.query("select clock_in($1, $2)", ["00000000-0000-4000-8000-0000000000bb", "00000000-0000-4000-8000-0000000000cc"]), /toolbox talk/);
await assert.rejects(() => db.query("select clock_in($1, $2, null, null, null, 'n')", ["00000000-0000-4000-8000-0000000000bb", "00000000-0000-4000-8000-0000000000cc"]), /toolbox talk/);

// ---- 4. the announcements ------------------------------------------------
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
  "New front door: own-row design choice, owner-only switches, the one clock-in gate (rule off / scheduled / on, offline dedupe, unit work still locked) and bilingual announcements passed.",
);
await db.close();
