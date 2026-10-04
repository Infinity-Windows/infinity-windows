// Sequential regression for the exact-job menu chooser, using the actual configuration migration and
// the actual latest dormant foundation (20261107020000) plus their real
// dependency helper bodies on a disposable embedded PostgreSQL. Synthetic
// profiles/projects only -- no production credentials, no clocks/payroll
// changes. This is a source-driven sequential regression harness: a single
// embedded connection cannot prove advisory-lock/race correctness across
// independent backends, and none is claimed here. Real-schema CAS testing
// and rollback are parent release gates (ASTRA-CAPTURE-SQL-CONTRACT.md §7).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const one = async sql => (await db.query(sql)).rows[0];
const all = async sql => (await db.query(sql)).rows;
const refuse = async (sql, code = '23514') => {
  try { await db.exec(sql); assert.fail('Expected refusal: ' + sql); }
  catch (error) { assert.equal(error.code, code, sql + ' -> ' + error.code); checks++; }
};
const as = uid => db.exec(`select set_config('request.jwt.claim.sub','${uid}',false)`);
const migrationFunction = (file, name) => {
  const source = readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
  const prefixes = ['create or replace function public.', 'create function public.',
    'create or replace function ', 'create function '];
  let start = -1;
  for (const p of prefixes) { start = source.indexOf(p + name + '('); if (start >= 0) break; }
  assert.ok(start >= 0, 'Actual helper must exist: ' + name);
  const end = source.indexOf('$$;', start);
  assert.ok(end > start);
  return source.slice(start, end + 3);
};

await db.exec(`create role authenticated; create role anon;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table profiles(id uuid primary key,role text,retired_at timestamptz,access_revoked_at timestamptz,
  is_partner boolean not null default false,is_test boolean not null default false);
create table projects(id uuid primary key,deleted_at timestamptz,is_test boolean not null default false);
create table project_openings(id uuid primary key,project_id uuid);
create table sandbox_projects(project_id uuid primary key);`);

for (const [file, names] of [
  ['20260730120000_test_accounts_excluded_from_learning.sql', ['is_test_profile']],
  ['20260730220000_test_accounts_sandbox_only.sql', ['is_sandbox_project', 'row_project_id', 'guard_test_account_sandbox_only']],
  ['20260810000000_team_timecards.sql', ['_is_supervisor']],
  ['20260967000000_sandbox_guard_rearm.sql', ['sandbox_scoped_tables', 'attach_sandbox_guards']],
  ['20261024000000_ai_field_operations.sql', ['_ai_job_visible']],
]) for (const name of names) await db.exec(migrationFunction(file, name));

// The actual dormant foundation this slice builds on, run verbatim.
await db.exec(readFileSync(new URL('../supabase/migrations/20261107020000_work_capture_foundation.sql', import.meta.url), 'utf8'));
// The actual new slice under review.
await db.exec(readFileSync(new URL('../supabase/migrations/20261108000000_work_configuration.sql', import.meta.url), 'utf8'));

await db.exec(readFileSync(new URL('../supabase/migrations/20261108200000_work_job_menu_choices.sql', import.meta.url), 'utf8'));
const OWNER=id(1), SUP=id(2), FORE=id(3), INSTALLER=id(4), PARTNER=id(5), RETIRED=id(6), REVOKED=id(7), QAOWNER=id(8), QAFORE=id(9);
const JOB=id(50), OTHER=id(51), TEST=id(52), DELETED=id(53);
await db.exec(`insert into profiles(id,role) values('${OWNER}','owner'),('${SUP}','supervisor'),('${FORE}','foreman'),('${INSTALLER}','installer');
insert into profiles(id,role,is_partner) values('${PARTNER}','supervisor',true);
insert into profiles(id,role,retired_at) values('${RETIRED}','owner',now());
insert into profiles(id,role,access_revoked_at) values('${REVOKED}','owner',now());
insert into profiles(id,role,is_test) values('${QAOWNER}','owner',true),('${QAFORE}','foreman',true);
insert into projects(id) values('${JOB}'),('${OTHER}');
insert into projects(id,is_test) values('${TEST}',true);
insert into projects(id,deleted_at) values('${DELETED}',now());
insert into sandbox_projects(project_id) values('${TEST}');`);
const read = async job => (await one(`select work_job_menu_choices(${job ? `'${job}'` : 'null'}) as s`)).s;
const deny = async actor => { await as(actor); await refuse(`select work_job_menu_choices('${JOB}')`, '42501'); };
await as(OWNER);
check((await read(JOB)).choices.length===0, 'Authorized empty choices is a successful read');
await db.exec(`select work_propose_menu_draft('${id(100)}','secret_draft',0,'SECRET','SECRETO','[]');
select work_publish_menu_version('${id(101)}','main',0,'Main','Principal','[]');
select work_publish_menu_version('${id(102)}','main',1,'Main 2','Principal 2','[]');
select work_publish_menu_version('${id(103)}','future',0,'Future','Futuro','[]',clock_timestamp()+interval '1 day');`);
let s=await read(JOB);
check(s.choices.length===2, 'Eligible old and latest versions are offered, future version is omitted');
check(!JSON.stringify(s).includes('SECRET')&&!('drafts' in s), 'Draft bodies never enter chooser');
check(Object.keys(s.choices[0]).sort().join(',')==='effectiveFrom,labelEn,labelEs,menuVersionId,publishedAt,version', 'Choice exposes exact minimal metadata');
const main=s.choices.find(c=>c.version===1).menuVersionId;
await db.exec(`select work_select_job_menu('${id(104)}','${JOB}','${main}',0)`);
check((await read(JOB)).currentRevision===1&&(await read(OTHER)).currentRevision===0, 'Only exact job pointer returned');
await db.exec(`select work_retire_menu('${id(105)}','main',2)`);
s=await read(JOB);
check(s.currentRevision===1&&s.currentSelection.menuVersionId===main&&s.choices.length===0, 'Retired current pointer remains while choice is excluded');
for(const actor of [OWNER,SUP]) {await as(actor);check((await read(JOB)).projectId===JOB,'Real company manager authorized');}
for(const actor of [FORE,INSTALLER,PARTNER,RETIRED,REVOKED]) await deny(actor);
await db.exec("select set_config('request.jwt.claim.sub','',false)");await refuse(`select work_job_menu_choices('${JOB}')`,'42501');
await as(OWNER);await refuse('select work_job_menu_choices(null)','42501');await refuse(`select work_job_menu_choices('${id(999)}')`,'42501');await refuse(`select work_job_menu_choices('${DELETED}')`,'42501');
await db.exec(`select work_grant_job_capability('${id(106)}','${OTHER}','${FORE}','menu_select');
select work_grant_job_capability('${id(107)}','${JOB}','${FORE}','dimensions_edit')`);
await deny(FORE);
await as(OWNER);await db.exec(`select work_grant_job_capability('${id(108)}','${JOB}','${FORE}','menu_select')`);
await as(FORE);check((await read(JOB)).projectId===JOB, 'Exact-job granted foreman authorized');
await as(OWNER);const grant=(await one(`select id from work_job_management_grants where project_id='${JOB}' and profile_id='${FORE}' and capability='menu_select' and revoked_at is null`)).id;
await db.exec(`select work_revoke_job_capability('${id(109)}','${JOB}','${FORE}','menu_select','${grant}')`);await deny(FORE);
await as(QAOWNER);check((await read(TEST)).projectId===TEST, 'QA owner reads named sandbox choices');
await refuse('select work_job_menu_choices(null)','42501');await refuse(`select work_job_menu_choices('${JOB}')`,'42501');await refuse('select work_configuration_snapshot(null)','23514');
await as(QAFORE);await refuse(`select work_job_menu_choices('${TEST}')`,'42501');
await as(QAOWNER);await db.exec(`select work_grant_job_capability('${id(110)}','${TEST}','${QAFORE}','menu_select')`);
await as(QAFORE);check((await read(TEST)).projectId===TEST, 'QA foreman needs exact sandbox grant');await refuse(`select work_job_menu_choices('${JOB}')`,'42501');
await as(OWNER);
await db.exec(`select work_publish_activity_version('${id(111)}','future_activity',0,'specific','Future A','Futuro A',false,'[]',clock_timestamp()+interval '1 day')`);
const activity=(await one("select d.id as definition_id,v.id as version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code='future_activity'"));
const item=enabled=>JSON.stringify([{definitionId:activity.definition_id,versionId:activity.version_id,position:0,enabled}]);
await db.exec(`select work_publish_menu_version('${id(112)}','disabled_future',0,'Disabled','Desactivado','${item(false)}');
select work_publish_menu_version('${id(113)}','enabled_future',0,'Enabled','Activado','${item(true)}')`);
s=await read(JOB);check(s.choices.length===1&&s.choices[0].labelEn==='Disabled','Disabled future child allowed, enabled future child excluded');
const future=(await one("select mv.id from work_capture_menu_versions mv join work_capture_menus m on m.id=mv.menu_id where m.code='future'")).id;
await refuse(`select work_select_job_menu('${id(114)}','${JOB}','${future}',1)`);
await refuse(`select work_select_job_menu('${id(115)}','${JOB}','${s.choices[0].menuVersionId}',0)`);
check((await read(JOB)).currentRevision===1,'Ineligible/stale selections preserve pointer');
for(const role of ['public','anon'])check(!(await one(`select has_function_privilege('${role}','public.work_job_menu_choices(uuid)','EXECUTE') as allowed`)).allowed,role+' cannot execute chooser');
check((await one("select has_function_privilege('authenticated','public.work_job_menu_choices(uuid)','EXECUTE') as allowed")).allowed,'Authenticated RPC execution granted');
check((await one("select provolatile from pg_proc where oid='public.work_job_menu_choices(uuid)'::regprocedure")).provolatile==='s','Chooser is statement-stable');
// Generate more eligible immutable versions through the real publisher. No truncation.
for(let i=0;i<500;i++)await db.exec(`select work_publish_menu_version('${id(2000+i)}','overflow',${i},'Overflow','Exceso','[]')`);
await refuse(`select work_job_menu_choices('${JOB}')`,'54000');
await db.close();console.log(`Job menu choices: ${checks} actual-migration sequential checks passed; no concurrency or production proof claimed.`);
