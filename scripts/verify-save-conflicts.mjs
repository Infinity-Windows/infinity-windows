// Disposable PostgreSQL only. Real RPC definitions; platform/dependency stubs.
// PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node scripts/verify-save-conflicts.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
const migration = await read('supabase/migrations/20261130000000_nonretryable_save_conflicts.sql');
const names = ['set_project_location','file_daily_log','correct_stage_contributors','workflow_save_draft','workflow_publish_plan'];
let checks = 0;
async function rpcDefinition(file, name) {
  const sql = await read('supabase/migrations/' + file);
  const start = sql.search(new RegExp('create (?:or replace )?function public\\.' + name + '\\('));
  assert.ok(start >= 0, name);
  const body = sql.indexOf('$$', start), end = sql.indexOf('$$;', body + 2);
  assert.ok(end > body);
  return sql.slice(start, end + 3);
}
async function refused(sql, args, code, message) {
  await assert.rejects(db.query(sql, args), e => e.code === code && e.message.includes(message));
  checks++;
}
await db.exec(await read('scripts/tests/ai-daily-logs/setup.sql'));
for (const file of ['20260949000000_daily_logs.sql','20260951000000_share_with_builder.sql','20261014000000_installer_daily_reporting.sql'])
  await db.exec(await read('supabase/migrations/' + file));
await db.exec(await rpcDefinition('20261024000000_ai_field_operations.sql','_ai_job_visible'));
await db.exec('set check_function_bodies=off');
for (const file of ['20261030000000_ai_daily_log_contributions.sql','20261052000000_daily_log_revision_guard.sql','20261064000000_daily_log_progress_fields.sql'])
  await db.exec(await read('supabase/migrations/' + file));
await db.exec(`
  alter table projects add address text, add latitude double precision, add longitude double precision;
  create table custom_work_commands(id uuid primary key,profile_id uuid,payload jsonb,result_id uuid);
  create table custom_work_units(id uuid primary key,project_id uuid,opening_id uuid);
  create table project_openings(id uuid,removed_at timestamptz,project_id uuid);
  create table workflow_plans(id uuid primary key,state text,revision bigint,published_revision bigint,draft jsonb,source_snapshot jsonb,updated_at timestamptz);
  create table workflow_publish_requests(request_id uuid,fingerprint text,result jsonb);
  create function workflow_require_manager() returns void language plpgsql as $$begin if not _is_lead(auth.uid()) then raise exception 'denied' using errcode='42501'; end if; end$$;
  create function workflow_conflicts(uuid) returns jsonb language sql as $$select '[]'::jsonb$$;
  create function workflow_snapshot(uuid) returns jsonb language sql as $$select '{}'::jsonb$$;
  create function custom_work_internal() returns boolean language sql as $$select true$$;
  create function _stage_contributor_sources_visible(uuid,text,date) returns boolean language sql as $$select true$$;
  create function _stage_contributor_digest(uuid,text,date) returns text language sql as $$select 'current-digest'::text$$;
`);
for (const [file,name] of [
  ['20261127000000_manual_job_location.sql','set_project_location'],
  ['20261049000000_foreman_unit_contributors.sql','correct_stage_contributors'],
  ['20261006000000_schedule_end_time.sql','workflow_save_draft'],
  ['20261006000000_schedule_end_time.sql','workflow_publish_plan']]) await db.exec(await rpcDefinition(file,name));
// Explicit grants make preservation observable (CREATE OR REPLACE must not broaden them).
await db.exec('revoke all on function set_project_location(uuid,text,double precision,double precision,text,double precision,double precision) from public,anon; grant execute on function set_project_location(uuid,text,double precision,double precision,text,double precision,double precision) to authenticated');
const definitions = async () => (await db.query(`select proname,pg_get_functiondef(oid) definition,proacl::text acl,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname=any($1::text[]) order by proname`,[names])).rows;
const before = await definitions();
assert.equal(before.length,5);
assert.equal(before.reduce((n,f)=>n+(f.definition.match(/errcode\s*=\s*'40001'/gi)||[]).length,0),8); checks++;
await db.exec(migration);
const after = await definitions();
for (let i=0;i<before.length;i++) {
  assert.equal(after[i].definition,before[i].definition.replace(/errcode\s*=\s*'40001'/gi,"errcode = 'PT409'"));
  for(const key of ['acl','prosecdef','proconfig']) assert.deepEqual(after[i][key],before[i][key]);
  checks++;
}
await db.exec(migration); assert.deepEqual(await definitions(),after); checks++;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.query("insert into profiles(id,role,display_name) values($1,'foreman','Synthetic lead'),($2,'installer','Synthetic installer')",[id(1),id(2)]);
await db.query("insert into projects(id,name,address) values($1,'Synthetic job','Original')",[id(10)]);
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(1)]);
const location = 'select set_project_location($1,$2,null,null,$3,null,null)';
await db.query(location,[id(10),'Saved','Original']); checks++;
// Lost-response replay: old expected snapshot, identical desired result.
await db.query(location,[id(10),'Saved','Original']); checks++;
await refused(location,[id(10),'Stale overwrite','Original'],'PT409','location changed');
assert.equal((await db.query('select address from projects where id=$1',[id(10)])).rows[0].address,'Saved'); checks++;
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(2)]);
await refused(location,[id(10),'Forbidden','Saved'],'42501','foreman');
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(1)]);
const daily="select * from file_daily_log($1,current_date,p_notes=>$2,p_expected_revision=>$3)";
await refused(daily,[id(10),'Missing revision',null],'PT409','refresh');
const log=(await db.query(daily,[id(10),'Original report',0])).rows[0]; checks++;
await refused(daily,[id(10),'Stale report',0],'PT409','changed');
assert.equal((await db.query('select notes from daily_logs where id=$1',[log.id])).rows[0].notes,'Original report'); checks++;
await db.query("insert into custom_work_units(id,project_id) values($1,$2)",[id(20),id(10)]);
await refused('select correct_stage_contributors($1,$2::jsonb)',[id(30),JSON.stringify({unit_id:id(20),stage:'Installing',work_date:'2026-10-01',expected_digest:'old',reason:'Correction',remove:[id(2)]})],'PT409','summary changed');
assert.equal((await db.query('select count(*)::int n from custom_work_commands')).rows[0].n,0); checks++;
await db.query("insert into workflow_plans(id,state,revision,published_revision,draft,source_snapshot) values($1,'active',2,0,'{\"assignments\":[],\"trips\":[]}','{}')",[id(40)]);
await refused('select workflow_save_draft($1,1,$2::jsonb)',[id(40),'{}'],'PT409','plan changed');
const draft=(await db.query('select draft from workflow_plans where id=$1',[id(40)])).rows[0].draft;
assert.equal((await db.query('select workflow_save_draft($1,2,$2::jsonb) r',[id(40),JSON.stringify(draft)])).rows[0].r,2); checks++;
const publish='select workflow_publish_plan($1,$2,$3,$4)';
await refused(publish,[id(40),1,id(41),'bad-token'],'PT409','plan changed');
await refused(publish,[id(40),2,id(41),'bad-token'],'PT409','Bookings changed');
await db.query("update workflow_plans set source_snapshot='\"old\"'::jsonb where id=$1",[id(40)]);
const token=(await db.query("select md5(draft::text||'[]') token from workflow_plans where id=$1",[id(40)])).rows[0].token;
await refused(publish,[id(40),2,id(41),token],'PT409','linked source');
assert.equal((await db.query('select revision from workflow_plans where id=$1',[id(40)])).rows[0].revision,2); checks++;
// Failure must roll back the entire migration statement, not partially patch functions.
await db.exec('begin');
await db.exec("alter function workflow_save_draft(uuid,bigint,jsonb) rename to missing_workflow_save_draft");
await assert.rejects(db.exec(migration),e=>e.message.includes('Expected five')); checks++;
await db.exec('rollback');
assert.deepEqual(await definitions(),after); checks++;
await db.close();
console.log(`${checks} disposable PostgreSQL assertions passed. Real five RPC bodies; dependency/auth fixtures. No network or production database access. Does not emulate PostgREST HTTP or concurrent sessions.`);
