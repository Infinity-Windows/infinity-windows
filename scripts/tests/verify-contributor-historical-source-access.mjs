// Historical-source authorization regression. Disposable PGlite only.
// Bootstrap adapted from verify-ai-field-operations.mjs; actual migration functions
// load below, with platform auth/storage/sandbox/clock fixture stubs.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const arg = process.argv.find((a) => a.startsWith("--pglite="));
const { PGlite } = await import(arg?.slice(9) ?? process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
// Print the database's own message, not PGlite's bundled source.
process.on("uncaughtException", (e) => { console.error("FAILED after [" + globalThis.lastCheck + "]:", e.message, e.where ?? "", e.actual !== undefined ? JSON.stringify({ actual: e.actual, expected: e.expected }) : ""); process.exit(1); });
const db = new PGlite();
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean default true,partner boolean default false,display_name text,retired_at timestamptz,access_revoked_at timestamptz,is_test boolean default false);
create table projects(id uuid primary key,deleted_at timestamptz,name text,job_code text,address text,is_test boolean default false,allowed_modes text[] default '{data}',created_at timestamptz default now());
create table project_pipeline(project_id uuid primary key references projects on delete cascade,ready_state text not null default 'ready',updated_at timestamptz,updated_by uuid);
create table window_types(id uuid primary key,name text,width_in numeric,height_in numeric);
create table project_mark_specs(project_id uuid,mark_code text,style text,operation text,width_in int,height_in int);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz,opening_code text,label text,window_type_id uuid,assigned_to uuid,assigned_by uuid,assigned_at timestamptz);
create table opening_assignment_events(opening_id uuid,from_profile uuid,to_profile uuid,changed_by uuid,via text);
create function log_assignment() returns trigger language plpgsql security definer as $$begin if new.assigned_to is distinct from old.assigned_to then insert into opening_assignment_events values(new.id,old.assigned_to,new.assigned_to,auth.uid(),case when new.assigned_to is null then 'unassign' else coalesce(nullif(current_setting('app.assignment_via',true),''),'dispatch') end); end if; return new; end$$;
create trigger log_assignment after update of assigned_to on project_openings for each row execute function log_assignment();
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid,opening_id uuid,started_at timestamptz default now(),ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid references profiles on delete cascade,opening_id uuid,state text default 'on_task',started_at timestamptz default now(),ended_at timestamptz);
create table opening_phases(id uuid primary key default gen_random_uuid(),opening_id uuid,started_by uuid,status text,paused_at timestamptz);
create table project_messages(id uuid primary key default gen_random_uuid(),project_id uuid,author_id uuid,body text,mentions uuid[]);
create table service_job_supervisors(project_id uuid,profile_id uuid);
create table sandbox_projects(project_id uuid primary key);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,owner uuid default auth.uid(),created_at timestamptz default now(),primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to authenticated;
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql stable as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer as $$select exists(select 1 from profiles where id=p and role in ('supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer as $$select coalesce((select is_test from profiles where id=p),false)$$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer as $$select p is not null and exists(select 1 from sandbox_projects where project_id=p)$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
-- Same semantics as guard_test_account_sandbox_only for project_id tables and projects.id.
create function guard_stub() returns trigger language plpgsql security definer as $$
declare pid uuid; begin
  if auth.uid() is null or not is_test_profile(auth.uid()) then return coalesce(new,old); end if;
  pid := case when tg_table_name='projects' then (to_jsonb(coalesce(new,old))->>'id')::uuid else (to_jsonb(coalesce(new,old))->>'project_id')::uuid end;
  if not is_sandbox_project(pid) then raise exception 'This is a test login. It can only change the automation sandbox job, not a real one.' using errcode='42501'; end if;
  return coalesce(new,old); end $$;
create function attach_sandbox_guards() returns void language plpgsql as $$
declare t text; begin
  for t in select table_name::text from information_schema.columns c join information_schema.tables x using(table_schema,table_name)
    where c.table_schema='public' and c.column_name='project_id' and x.table_type='BASE TABLE' and table_name<>'sandbox_projects' union select 'projects' loop
    execute format('drop trigger if exists zz_sandbox on public.%I', t);
    execute format('create trigger zz_sandbox before insert or update or delete on public.%I for each row execute function guard_stub()', t);
  end loop; end $$;
-- The real end_break closes the break into break_seconds.
create function end_break(p uuid) returns time_shifts language sql security definer as $$
  update time_shifts set break_seconds=coalesce(break_seconds,0)+extract(epoch from now()-break_started_at)::int,break_started_at=null where id=p returning *$$;
grant select on profiles,projects to authenticated;
`);
await db.exec(await migration("20261011000000_custom_work.sql"));
await db.exec("create trigger unit_sessions_follow_shift after update on time_shifts for each row execute function unit_sessions_follow_shift()");
await db.exec(`alter table profiles add column is_partner boolean generated always as (partner) stored;
create table app_release_notes(id text primary key,published_on date,audience int[],kind text,title_en text,title_es text,body_en text,body_es text,href text);
create table ai_spend_limits(id int primary key,min_role text not null default 'foreman',monthly_cap_cents int default 15000,per_user_daily_calls int default 40,enforced boolean default true,updated_at timestamptz);
insert into ai_spend_limits(id) values(1);`);
await db.exec(await migration("20261023000000_foreman_crew_unit_records.sql"));
await db.exec(await migration("20261024000000_ai_field_operations.sql"));
await db.exec(await migration("20261024010000_installer_ai_floor.sql"));
await db.exec(await migration("20261024020000_ai_field_operations_note.sql"));

await db.exec(`create table company_settings(id int primary key,updated_at timestamptz not null default now(),updated_by uuid); insert into company_settings(id) values(1);
create function _close_dangling_shift(p uuid) returns void language sql as $$update time_shifts set clock_out_at=now(),status='submitted' where profile_id=p and clock_out_at is null$$;
create table summons(id uuid primary key default gen_random_uuid(),project_id uuid,opening_id uuid,requested_by uuid,needed int,status text default 'open',created_at timestamptz default now());
create table summon_helpers(id uuid primary key default gen_random_uuid(),summon_id uuid,profile_id uuid,joined_at timestamptz default now(),completed_at timestamptz,canceled_at timestamptz,minutes int);
create table summon_declines(summon_id uuid,profile_id uuid,primary key(summon_id,profile_id));
create table points_ledger(id uuid primary key default gen_random_uuid(),profile_id uuid,kind text,points int,ref text,status text);`);
await db.exec(await migration("20261031000000_new_front_door.sql"));
await db.exec(await migration("20261049000000_foreman_unit_contributors.sql"));

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOREMAN = id(1), ALICE = id(2), BOB = id(3), SUPERVISOR = id(4);
const TEST_FOREMAN = id(5), TEST_INSTALLER = id(6);
let serial = 100, checks = 0;
const fresh = () => id(serial++);
function equal(actual, expected, why) {
  globalThis.lastCheck = why;
  assert.deepEqual(actual, expected, why);
  checks++;
}
async function admin() {
  await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)");
}
async function actor(who = FOREMAN) {
  await admin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [who]);
  await db.exec("set role authenticated");
}
await db.query(`insert into profiles(id,role,display_name) values
  ($1,'foreman','Frank'),($2,'installer','Alice'),($3,'installer','Bob'),($4,'supervisor','Sue')`,
  [FOREMAN, ALICE, BOB, SUPERVISOR]);
// Off today must not become an access restriction in the new helper.
await db.query("update profiles set active=false where id=$1", [FOREMAN]);
await db.query("insert into profiles(id,role,display_name,is_test) values($1,'foreman','QA lead',true),($2,'installer','QA worker',true)", [TEST_FOREMAN, TEST_INSTALLER]);
const day = '2026-09-29';
async function rawCounts(project, recordIds) {
  // These are direct authenticated table reads, without summary RPCs or a join
  // that could accidentally hide an unsafe participant policy. IDs were known
  // before visibility changed, exactly as a stale client could retain them.
  return [
    (await db.query('select * from crew_work_records where project_id=$1', [project])).rows.length,
    (await db.query('select * from custom_work_history where project_id=$1', [project])).rows.length,
    (await db.query('select * from crew_work_record_people where record_id=any($1::uuid[])', [recordIds])).rows.length,
  ];
}
async function record(unit, people, stage = 'Flashing', key = fresh()) {
  return db.query('select record_stage_contributors($1,$2)', [key, {
    unit_id: unit, people, stage, work_date: day, outcome: 'partial', description: 'After shift'
  }]);
}
async function summary(unit, stage = 'Flashing') {
  return (await db.query('select * from stage_contributor_summary($1) where stage=$2 order by profile_id', [unit, stage])).rows;
}
async function correct(unit, digest, people = [ALICE], key = fresh()) {
  return db.query('select correct_stage_contributors($1,$2)', [key, {
    unit_id: unit, stage: 'Flashing', work_date: day, expected_digest: digest,
    remove: people, reason: 'Review original evidence'
  }]);
}
// Complete rows, not counts: a refusal must not change existing audit, receipts,
// participants, report content, unit facts/revision, or the conservative flag.
async function snapshot() {
  await admin();
  const out = {};
  for (const table of ['crew_work_records', 'crew_work_record_people', 'custom_work_history', 'custom_work_commands', 'custom_work_units']) {
    out[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from ${table} t`)).rows[0].rows;
  }
  return out;
}
async function refusedUnchanged(call, why) {
  const before = await snapshot();
  await actor();
  globalThis.lastCheck = why;
  await assert.rejects(call, e => e.code === '42501' && /earlier records.*unavailable/i.test(e.message), why);
  checks++;
  equal(await snapshot(), before, `${why}: complete rows unchanged`);
}
async function fixture(mixed) {
  await admin();
  const origin = fresh(), current = fresh(), unit = fresh();
  await db.query("insert into projects(id,name) values($1,'Original'),($2,'Current')", [origin, current]);
  await db.query("insert into custom_work_units(id,project_id,created_by,label,facts) values($1,$2,$3,'Unit A','{\"installation_complete\":\"No\"}')", [unit, origin, FOREMAN]);
  await actor();
  await record(unit, [ALICE]);
  // Move through the actual supported RPC so the old report keeps its project.
  await db.query("select custom_work_command($1,'unit',$2)", [fresh(), {
    id: unit, revision: 1, project_id: current, opening_id: null, label: 'Unit A',
    type_label: 'Unknown', facts: { installation_complete: 'No' }, reason: 'Correct project link'
  }]);
  if (mixed) await record(unit, [BOB]);
  // A different tuple on the current project must remain usable.
  await record(unit, [BOB], 'Hardware');
  const before = await summary(unit);
  equal(before.map(r => r.profile_id), mixed ? [ALICE, BOB] : [ALICE], 'visible sources remain readable after a unit move');
  const originRecordIds = (await db.query('select id from crew_work_records where project_id=$1', [origin])).rows.map(r => r.id);
  const rawBefore = await rawCounts(origin, originRecordIds);
  equal(rawBefore.every(n => n > 0), true, 'raw report, history and participant evidence exists before visibility changes');
  return { origin, current, unit, digest: before[0].digest, originRecordIds, rawBefore };
}

// Both original-project visibility failures, both pure hidden and mixed source
// tuples. The foreman already knows the genuine digest before losing access.
for (const mode of ['hidden', 'deleted']) {
  for (const mixed of [false, true]) {
    const f = await fixture(mixed);
    await admin();
    await db.query(mode === 'hidden' ? 'update projects set is_test=true where id=$1' : 'update projects set deleted_at=now() where id=$1', [f.origin]);
    await actor();
    equal(await summary(f.unit), [], `${mode}/${mixed}: no contributor or digest from an unreviewable tuple`);
    equal(await rawCounts(f.origin, f.originRecordIds), [0, 0, 0], `${mode}/${mixed}: raw foreman reads hide the original project after unit move`);
    await actor(ALICE);
    equal(await rawCounts(f.origin, f.originRecordIds), [0, 0, 0], `${mode}/${mixed}: raw installer reads hide the original project`);
    await actor(TEST_FOREMAN);
    equal(await rawCounts(f.current, f.originRecordIds), [0, 0, 0], `${mode}/${mixed}: automation cannot read real current-job history or old participants`);
    await actor();
    equal((await summary(f.unit, 'Hardware')).map(r => r.profile_id), [BOB], `${mode}/${mixed}: unrelated accessible tuple still readable`);
    await refusedUnchanged(() => correct(f.unit, f.digest), `${mode}/${mixed}: saved digest cannot void inaccessible evidence`);
    // Even removing only a visible participant in a mixed tuple must refuse:
    // its preview/digest would otherwise include hidden source records.
    if (mixed) await refusedUnchanged(() => correct(f.unit, f.digest, [BOB]), `${mode}: mixed tuple cannot be partially corrected`);
    await refusedUnchanged(() => record(f.unit, [ALICE]), `${mode}/${mixed}: semantic dedupe cannot inspect hidden sources`);
    await refusedUnchanged(() => record(f.unit, [BOB]), `${mode}/${mixed}: add cannot extend an unreviewable tuple`);
    await actor();
    await record(f.unit, [ALICE], 'Hardware');
    equal((await summary(f.unit, 'Hardware')).map(r => r.profile_id), [ALICE, BOB], `${mode}/${mixed}: another tuple still accepts work`);

    // Existing supervisor authority can see a testing job, but even supervisors
    // cannot correct soft-deleted historical projects through this path.
    await actor(SUPERVISOR);
    equal((await summary(f.unit)).map(r => r.profile_id), mode === 'hidden' ? (mixed ? [ALICE, BOB] : [ALICE]) : [], `${mode}/${mixed}: actual supervisor visibility applies`);
    equal(await rawCounts(f.origin, f.originRecordIds), mode === 'hidden' ? f.rawBefore : [0, 0, 0], `${mode}/${mixed}: raw supervisor visibility matches existing project authority`);
    await admin();
    await db.query('update projects set is_test=false,deleted_at=null where id=$1', [f.origin]);
    await actor();
    equal(await rawCounts(f.origin, f.originRecordIds), f.rawBefore, `${mode}/${mixed}: raw evidence returns when original project access is restored`);
    equal((await summary(f.unit))[0].digest, f.digest, `${mode}/${mixed}: refused writes preserved source evidence`);
    await correct(f.unit, f.digest);
    equal((await summary(f.unit)).map(r => r.profile_id), mixed ? [BOB] : [], `${mode}/${mixed}: correction succeeds after access is restored`);
  }
}

// Inaccessible sources that are not effective work must not poison a tuple.
// Keep voided history and future assignments while recording visible work.
const excluded = await fixture(false);
await correct(excluded.unit, excluded.digest);
await admin();
const assignment = fresh();
await db.query(`insert into crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome)
  values($1,$2,$3,$4,$5,'Flashing','assigned')`, [assignment, excluded.origin, excluded.unit, FOREMAN, day]);
await db.query('insert into crew_work_record_people(record_id,profile_id) values($1,$2)', [assignment, ALICE]);
await db.query('update projects set is_test=true where id=$1', [excluded.origin]);
await actor();
await record(excluded.unit, [BOB]);
equal((await summary(excluded.unit)).map(r => r.profile_id), [BOB], 'voided and assigned hidden records do not block effective work');
// The private authority helper must not become a source-enumeration endpoint.
await assert.rejects(() => db.query("select _stage_contributor_sources_visible($1,'Flashing',$2)", [excluded.unit, day]), e => e.code === '42501');
checks++;
await actor(ALICE);
equal((await summary(excluded.unit)).map(r => r.profile_id), [BOB], 'installer can read an accessible summary');
await assert.rejects(() => record(excluded.unit, [ALICE]), e => e.code === '42501');
checks++;

// Test-logins may read their sandbox evidence, not real work or arbitrary test
// projects. The private AI helper itself stays uncallable from authenticated.
await admin();
const sandbox = fresh(), sandboxUnit = fresh();
await db.query("insert into projects(id,name,is_test) values($1,'QA sandbox',true)", [sandbox]);
await db.query('insert into sandbox_projects(project_id) values($1)', [sandbox]);
await db.query("insert into custom_work_units(id,project_id,created_by,label) values($1,$2,$3,'QA unit')", [sandboxUnit, sandbox, TEST_FOREMAN]);
await actor(TEST_FOREMAN);
await record(sandboxUnit, [TEST_INSTALLER]);
const sandboxIds = (await db.query('select id from crew_work_records where project_id=$1', [sandbox])).rows.map(r => r.id);
equal(await rawCounts(sandbox, sandboxIds), [1, 1, 1], 'automation reads actual sandbox report, history and participants');
equal(await rawCounts(excluded.current, [assignment]), [0, 0, 0], 'automation cannot read real-job history or a non-sandbox test report');
await assert.rejects(() => db.query('select _ai_job_visible($1,$2)', [sandbox, TEST_FOREMAN]), e => e.code === '42501');
checks++;
for (const who of [FOREMAN, ALICE]) {
  await actor(who);
  equal(await rawCounts(sandbox, sandboxIds), [0, 0, 0], 'real crew cannot read sandbox ledger directly');
}
await actor(SUPERVISOR);
equal(await rawCounts(sandbox, sandboxIds), [1, 1, 1], 'real supervisor retains authorized test-project reads');

// Projectless work keeps its author/lead rule without allowing a test foreman
// to use that exception to enumerate real people's unassigned history.
await admin();
const unassignedEntity = fresh();
await db.query(`insert into custom_work_history(actor_id,entity_id,action) values
  ($1,$4,'unit'),($2,$4,'unit'),($3,$4,'unit')`, [FOREMAN, ALICE, TEST_FOREMAN, unassignedEntity]);
for (const [who, expected] of [[TEST_FOREMAN, [TEST_FOREMAN]], [FOREMAN, [FOREMAN, ALICE]], [ALICE, [ALICE]]]) {
  await actor(who);
  equal((await db.query('select actor_id from custom_work_history where entity_id=$1 order by actor_id', [unassignedEntity])).rows.map(r => r.actor_id), expected, 'projectless raw history preserves authorship and the test partition');
}
// No alternate policy path restores reads for a removed login or a partner.
await admin();
await db.query('update profiles set access_revoked_at=now() where id=$1', [TEST_FOREMAN]);
await actor(TEST_FOREMAN);
equal(await rawCounts(sandbox, sandboxIds), [0, 0, 0], 'revoked automation loses raw reads');
await admin();
await db.query('update profiles set partner=true where id=$1', [SUPERVISOR]);
await actor(SUPERVISOR);
equal(await rawCounts(sandbox, sandboxIds), [0, 0, 0], 'partner with elevated role cannot read raw ledger');
await db.close();
console.log(`${checks} historical-source authorization assertions passed. Actual custom-work, crew, AI visibility and front-door migrations loaded; disposable single-connection PGlite with platform fixture stubs. No production writes or concurrency claim.`);
