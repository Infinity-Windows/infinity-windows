// Disposable PostgreSQL-compatible permission/transaction proof; never uses Supabase.
// npm install --prefix /tmp/forge-execution-db-check @electric-sql/pglite
// PGLITE_MODULE=/tmp/forge-execution-db-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-job-execution.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to authenticated, anon;
  create table public.profiles(id uuid primary key, role text, is_partner boolean default false);
  create table public.projects(id uuid primary key, deleted_at timestamptz);
  grant select on public.profiles, public.projects to authenticated;
  create function public.is_partner_user() returns boolean language sql security definer set search_path = public as $$ select coalesce((select is_partner from profiles where id = auth.uid()), false) $$;
  create function public._is_lead(uid uuid) returns boolean language sql stable as $$ select exists(select 1 from profiles where id = uid and role in ('foreman','supervisor','owner','lead','admin','big_boss')) $$;
  -- Existing sandbox guard installation is checked by scripts/test_sandbox_guard.py.
  create function public.attach_sandbox_guards() returns void language sql as $$ select $$;
  insert into profiles values ('00000000-0000-4000-8000-000000000001','owner',false),('00000000-0000-4000-8000-000000000002','foreman',false),('00000000-0000-4000-8000-000000000003','installer',false),('00000000-0000-4000-8000-000000000004','owner',true);
  insert into projects values ('11111111-1111-4111-8111-111111111111',null);
`);
await db.exec(await readFile(new URL("../supabase/migrations/20261009000000_job_labor_and_stages.sql", import.meta.url), "utf8"));
const job = "'11111111-1111-4111-8111-111111111111'";
let checks = 0;
async function asUser(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`]);
  await db.exec("set role authenticated");
}
async function denied(sql) { await assert.rejects(db.exec(sql)); checks++; }
await asUser(1);
await db.exec(`select public.set_project_labor_targets(${job},200,180,1500,0,'Initial estimate');`);
checks++;
await denied(`select public.set_project_labor_targets(${job},190,170,1500,0,'Stale save')`);
for (const value of ["0", "-1", "'NaN'::numeric", "'Infinity'::numeric"]) {
  await denied(`select public.set_project_labor_targets(${job},${value},180,1500,1,'Invalid estimate')`);
}
await denied(`update public.project_labor_targets set goal_hours=999 where project_id=${job}`);
await denied(`insert into public.project_execution_history(project_id,event_kind,after_value,reason) values (${job},'forged','{}','fake')`);
await asUser(2);
assert.equal((await db.query("select * from public.project_labor_targets")).rows.length, 1); checks++;
await denied(`select public.set_project_labor_targets(${job},200,180,1500,1,'Foreman edit')`);
await db.exec(`select public.set_project_stage(${job},'material_delivered',true,'Delivery confirmed',0)`); checks++;
await denied(`select public.set_project_stage(${job},'material_delivered',false,'Stale form',0)`);
await denied(`select public.set_project_stage(${job},'invented_stage',true,'Unknown stage',0)`);
await denied(`select public.set_project_stage(${job},'qc_passed',true,'',0)`);
await db.exec(`select public.set_project_stage(${job},'material_delivered',false,'Delivery needs review',1)`); checks++;
assert.equal((await db.query("select count(*)::int n from public.project_execution_history")).rows[0].n, 3); checks++;
for (const user of [3,4]) {
  await asUser(user);
  for (const table of ["project_labor_targets","project_stage_progress","project_execution_history"]) {
    assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0); checks++;
  }
  await denied(`select public.set_project_stage(${job},'qc_passed',true,'Not authorized',0)`);
  await denied(`select public.set_project_labor_targets(${job},200,180,1500,1,'Not authorized')`);
}
await db.exec("reset role; set role anon");
await denied(`select public.set_project_stage(${job},'qc_passed',true,'Not authorized',0)`);
await db.exec(`reset role; update public.projects set deleted_at=now()`);
await asUser(1);
assert.equal((await db.query("select * from public.project_labor_targets")).rows.length, 0); checks++;
await denied(`select public.set_project_stage(${job},'qc_passed',true,'Deleted job',0)`);
await db.exec("reset role; delete from public.projects");
for (const table of ["project_labor_targets","project_stage_progress","project_execution_history"]) {
  assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0); checks++;
}
await db.close();
console.log(`${checks} isolated database checks passed. Base-role helpers were stubbed; production deployment was not tested.`);
