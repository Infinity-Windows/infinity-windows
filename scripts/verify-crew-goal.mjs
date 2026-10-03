// Disposable PostgreSQL regression for the actual crew_goal_summary migration.
// PGLITE_MODULE=/tmp/forge-daily-log-pglite/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-crew-goal.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();
const job = "11111111-1111-4111-8111-111111111111";
const hidden = "22222222-2222-4222-8222-222222222222";
const people = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
await db.exec(`
  create role authenticated; create role anon; create schema auth;
  grant usage on schema public, auth to authenticated;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.profiles(id uuid primary key, role text, is_partner boolean default false, retired_at timestamptz, access_revoked_at timestamptz);
  create table public.projects(id uuid primary key, deleted_at timestamptz, is_test boolean not null default false);
  create table public.project_labor_targets(project_id uuid primary key, goal_hours numeric, revision integer, updated_at timestamptz);
  create table public.time_shifts(id uuid primary key, profile_id uuid, project_id uuid, status text, clock_in_at timestamptz, clock_out_at timestamptz, break_seconds integer, break_started_at timestamptz, review_reason text, time_confirmed boolean);
  create function public.is_partner_user() returns boolean language sql stable security definer as $$ select coalesce((select is_partner from public.profiles where id=auth.uid()),false) $$;
  create function public.custom_work_internal() returns boolean language sql stable security definer as $$ select exists(select 1 from public.profiles where id=auth.uid() and role in ('installer','foreman','supervisor','owner') and retired_at is null and access_revoked_at is null and not is_partner) $$;
  create function public._is_supervisor(uid uuid) returns boolean language sql stable security definer as $$ select exists(select 1 from public.profiles where id=uid and role in ('supervisor','owner')) $$;
  create function public.is_test_profile(uid uuid) returns boolean language sql stable as $$ select false $$;
  create function public.is_sandbox_project(jid uuid) returns boolean language sql stable as $$ select false $$;
`);
await db.query("insert into public.profiles(id,role,is_partner) values ($1,'installer',false),($2,'foreman',false),($3,'owner',false),($4,'installer',true),($5,'installer',false)", people);
await db.query("update public.profiles set access_revoked_at=now() where id=$1", [people[4]]);
await db.query("insert into public.projects(id,is_test) values ($1,false),($2,true)", [job, hidden]);
await db.query("insert into public.project_labor_targets values ($1,120,3,now())", [job]);
await db.query(`insert into public.time_shifts(id,profile_id,project_id,status,clock_in_at,clock_out_at,break_seconds,review_reason,time_confirmed)
  values
  ('10000000-0000-4000-8000-000000000001',$1,$3,'submitted','2026-10-01T08:00:00Z','2026-10-01T16:00:00Z',1800,'clock_unchecked',false),
  ('10000000-0000-4000-8000-000000000002',$2,$3,'approved','2026-10-01T08:00:00Z','2026-10-01T16:00:00Z',1800,null,true),
  ('10000000-0000-4000-8000-000000000003',$2,$3,'rejected','2026-10-01T08:00:00Z','2026-10-01T10:00:00Z',0,null,false),
  ('10000000-0000-4000-8000-000000000004',$2,$3,'submitted','2026-10-01T16:00:00Z','2026-10-01T15:00:00Z',0,null,true)`, [people[0], people[1], job]);
// Three hours since clock-in with 15 minutes of earlier break and a break
// running for 30 minutes: 2h15m provisional. A resumed second worker has
// two hours since clock-in and 10 minutes of earlier break: 1h50m. Together
// these are 4h05m, with second-level drift handled from RPC's own as_of.
await db.query(`insert into public.time_shifts(id,profile_id,project_id,status,clock_in_at,clock_out_at,break_seconds,break_started_at)
  values
  ('10000000-0000-4000-8000-000000000005',$1,$3,'open',date_trunc('second',statement_timestamp()) - interval '3 hours',null,900,date_trunc('second',statement_timestamp()) - interval '30 minutes'),
  ('10000000-0000-4000-8000-000000000006',$2,$3,'open',date_trunc('second',statement_timestamp()) - interval '2 hours',null,600,null)`, [people[0], people[1], job]);
const openRows = (await db.query("select clock_in_at,break_seconds,break_started_at from public.time_shifts where status='open' order by id")).rows;
await db.exec(await readFile(new URL("../supabase/migrations/20261105000000_crew_goal_summary.sql", import.meta.url), "utf8"));
async function asUser(id) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
}
for (const id of people.slice(0, 3)) {
  await asUser(id);
  const result = (await db.query("select public.crew_goal_summary($1) as goal", [job])).rows[0].goal;
  assert.equal(Number(result.recorded_hours), 15, "two workers' paid time is additive; suspect valid shift remains recorded");
  assert.equal(result.unresolved_shifts, 3, "two flags on one valid shift count once, plus rejected and invalid duration");
  assert.equal(result.open_shifts, 2, "both workers' open shifts count");
  const asOf = new Date(result.as_of).getTime();
  const expectedRunningSeconds = openRows.reduce((total, row) => {
    const elapsed = Math.floor((asOf - new Date(row.clock_in_at).getTime()) / 1000);
    const activeBreak = row.break_started_at
      ? Math.floor((asOf - new Date(row.break_started_at).getTime()) / 1000) : 0;
    return total + Math.max(0, elapsed - row.break_seconds - activeBreak);
  }, 0);
  assert.ok(Math.abs(expectedRunningSeconds - 14_700) <= 2, "hand total is 2h15m plus 1h50m");
  assert.ok(Math.abs(Number(result.running_provisional_hours) * 3600 - expectedRunningSeconds) < 0.001,
    "running time subtracts stored and current breaks without losing the resumed worker");
  assert.equal(result.goal_revision, 3);
  assert.ok(Math.abs(Number(result.allowance_hours) - (105 - expectedRunningSeconds / 3600)) < 1e-9);
  assert.deepEqual(Object.keys(result).sort(), ["allowance_hours","as_of","goal_hours","goal_revision","goal_updated_at","open_shifts","recorded_hours","running_provisional_hours","unresolved_shifts"].sort());
  if (id !== people[2]) await assert.rejects(db.query("select public.crew_goal_summary($1)", [hidden]));
}
for (const id of people.slice(3)) {
  await asUser(id);
  await assert.rejects(db.query("select public.crew_goal_summary($1)", [job]));
}
await db.close();
console.log("Crew goal RPC: paid math, flagged closed rows, one-count review, role payload and denials passed (disposable PGlite).");
