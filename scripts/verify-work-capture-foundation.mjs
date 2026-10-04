// Execute the actual inert migration on a disposable embedded PostgreSQL.
// No production credentials. No timing/concurrency guarantees are tested here.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let checks=0;
const check=(value,message)=>{assert.ok(value,message); checks++;};
const one=async sql => (await db.query(sql)).rows[0];
const refuse=async (sql,code='23514') => {
  try { await db.exec(sql); assert.fail('Expected refusal: '+sql); }
  catch(error) { assert.equal(error.code,code); checks++; }
};
const migrationFunction=(file,name)=>{
 const source=readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
 const start=source.indexOf('create or replace function public.'+name+'(');
 assert.ok(start>=0,'Actual helper must exist: '+name);
 const end=source.indexOf('$$;',start); assert.ok(end>start);
 return source.slice(start,end+3);
};
await db.exec(`create role authenticated; create role anon;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table profiles(id uuid primary key,is_test boolean not null default false);
create table projects(id uuid primary key);
create table project_openings(id uuid primary key,project_id uuid);
create table sandbox_projects(project_id uuid primary key);
create table time_shifts(id uuid primary key,clock_in_at timestamptz,clock_out_at timestamptz,break_seconds int);
create table custom_work_sessions(id uuid primary key,started_at timestamptz,ended_at timestamptz);
insert into time_shifts values('${id(1)}','2026-10-03 13:00Z','2026-10-03 21:00Z',1800);
insert into custom_work_sessions values('${id(2)}','2026-10-03 13:00Z',null);`);
for(const [file,names] of [
 ['20260730120000_test_accounts_excluded_from_learning.sql',['is_test_profile']],
 ['20260730220000_test_accounts_sandbox_only.sql',['is_sandbox_project','row_project_id','guard_test_account_sandbox_only']],
 ['20260967000000_sandbox_guard_rearm.sql',['sandbox_scoped_tables','attach_sandbox_guards']],
])for(const name of names)await db.exec(migrationFunction(file,name));
const sourceSnapshot=async()=>JSON.stringify({
 shifts:(await db.query('select * from time_shifts order by id')).rows,
 sessions:(await db.query('select * from custom_work_sessions order by id')).rows,
});
const before=await sourceSnapshot();
const oldTriggers=(await db.query("select tgname from pg_trigger where not tgisinternal order by tgname")).rows;
await db.exec(readFileSync(new URL('../supabase/migrations/20261107020000_work_capture_foundation.sql',import.meta.url),'utf8'));
check(await sourceSnapshot()===before,'Inert migration does not alter existing payroll or sessions');
check(oldTriggers.length===0 && (await one("select count(*)::int as n from pg_trigger where tgrelid in ('time_shifts'::regclass,'custom_work_sessions'::regclass) and not tgisinternal")).n===0,'No timing observer/interception installed');
const tables=['work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_job_menu_selections','work_job_management_grants','personal_activity_state','personal_activity_commands','personal_activity_transitions','work_session_capture_metadata'];
for(const table of tables){
 check((await one(`select relrowsecurity as enabled from pg_class where oid='public.${table}'::regclass`)).enabled,table+' RLS enabled');
 check((await one(`select count(*)::int as n from public.${table}`)).n===0,table+' has no seed or fake operational records');
 for(const role of ['authenticated','anon'])check(!(await one(`select has_table_privilege('${role}','public.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed`)).allowed,role+' has no raw access to '+table);
}
for(const fn of ['work_capture_immutable_record()','work_capture_validate_menu()'])
 for(const role of ['authenticated','anon'])check(!(await one(`select has_function_privilege('${role}','public.${fn}','EXECUTE') as allowed`)).allowed,role+' cannot invoke private '+fn);
await db.exec(`insert into work_activity_definitions(id,code,created_by) values('${id(10)}','gathering','${id(1)}'),('${id(11)}','flashing','${id(1)}');
insert into work_activity_definition_versions(id,definition_id,version,scope,label_en,label_es,published_by) values
('${id(20)}','${id(10)}',1,'general','Gathering','Reunir','${id(1)}'),('${id(21)}','${id(11)}',1,'specific','Flashing','Tapajuntas','${id(1)}');
insert into work_capture_menus(id,code,created_by) values('${id(30)}','fixture_menu','${id(1)}');`);
const item=(d,v,p=0)=>({definitionId:id(d),versionId:id(v),position:p,enabled:true});
const menuSql=(n,items)=>`insert into work_capture_menu_versions(id,menu_id,version,label_en,label_es,items,published_by) values('${id(n)}','${id(30)}',${n},'Menu','Menu','${JSON.stringify(items)}','${id(1)}')`;
await db.exec(menuSql(40,[item(10,20),item(11,21,1)]));
check((await one(`select jsonb_array_length(items)::int as n from work_capture_menu_versions where id='${id(40)}'`)).n===2,'Whole approved membership stored in immutable snapshot');
await refuse(menuSql(41,[item(10,21)]));
await refuse(menuSql(42,[item(10,20),item(10,20,1)]));
await refuse(menuSql(43,[item(10,20),item(11,21)]));
await refuse(menuSql(44,[{...item(10,20),position:0.5}]));
await refuse(menuSql(45,[{...item(10,20),enabled:null}]));
await refuse(menuSql(46,[{...item(10,20),unexpected:true}]));
await refuse(`update work_capture_menu_versions set items='[]' where id='${id(40)}'`);
await refuse(`delete from work_activity_definition_versions where id='${id(20)}'`);
await refuse(`insert into personal_activity_state(profile_id,active_source_id) values('${id(1)}','${id(2)}')`);
await refuse(`insert into personal_activity_state(profile_id,revision) values('${id(1)}',9007199254740992)`);
await db.exec(`insert into personal_activity_state(profile_id) values('${id(1)}');`);
check((await one(`select integrity_state from personal_activity_state where profile_id='${id(1)}'`)).integrity_state==='review','Unknown initial state never asserts clean');
const grant=`insert into work_job_management_grants(project_id,profile_id,capability,granted_by) values('${id(50)}','${id(1)}','final_qc','${id(1)}')`;
await db.exec(grant);
await refuse(grant,'23505');
await refuse(`update work_job_management_grants set revoked_at=now() where profile_id='${id(1)}'`);
await db.exec(`update work_job_management_grants set revoked_at=now(),revoked_by='${id(1)}' where profile_id='${id(1)}'`);
await db.exec(grant);
check((await one('select count(*)::int as n from work_job_management_grants')).n===2,'Grant revisions retain revoked evidence');
await refuse(`insert into work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope,machine_kind) values('${id(60)}','${id(1)}','${id(50)}','${id(20)}','${id(40)}','general','scissor_lift')`);
await refuse(`insert into work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope,unit_id,fact_revision) values('${id(60)}','${id(1)}','${id(50)}','${id(21)}','${id(40)}','specific','${id(61)}',1)`);
const commandSql=(n,seq,status,beforeRev,afterRev,transition='null',effective='null',reason='null')=>
 `insert into personal_activity_commands(command_id,actor_id,subject_profile_id,protocol_version,normalized_payload,payload_hash,device_id,client_generation,client_sequence,expected_revision,status,reason_code,before_revision,after_revision,transition_id,effective_at,result)
 values('${id(n)}','${id(1)}','${id(1)}',1,'{}','${'0'.repeat(64)}','${id(70)}','${id(71)}',${seq},0,'${status}',${reason},${beforeRev},${afterRev},${transition},${effective},'{}')`;
await db.exec(commandSql(80,0,'noop',0,0));
check((await one(`select client_sequence::int as n from personal_activity_commands where command_id='${id(80)}'`)).n===0,'First dormant journal sequence0 is accepted');
await refuse(commandSql(81,-1,'noop',0,0));
await refuse(commandSql(82,1,'noop',0,1));
await refuse(commandSql(83,1,'applied',0,1));
await refuse(commandSql(84,1,'conflict',0,0));
await db.exec(commandSql(85,1,'applied',0,1,`'${id(90)}'`,"'2026-10-03 14:00Z'"));
await db.exec(commandSql(86,2,'refused',1,1,'null','null',"'retired_code'"));
await refuse(`update personal_activity_commands set normalized_payload='{"changed":true}' where command_id='${id(80)}'`);
await refuse(`delete from personal_activity_commands where command_id='${id(80)}'`);
await refuse(commandSql(87,0,'noop',0,0),'23505');
await db.exec(`insert into personal_activity_transitions(id,profile_id,revision_before,revision_after,command_id,cause,selected_effective_at,time_selection_reason,before_evidence,after_evidence,protocol_version)
 values('${id(90)}','${id(1)}',0,1,'${id(85)}','switch','2026-10-03 14:00Z','fixture','{}','{}',1)`);
await refuse(`update personal_activity_transitions set review_reason='changed' where id='${id(90)}'`);
await refuse(`delete from personal_activity_transitions where id='${id(90)}'`);
check((await one("select count(*)::int as n from pg_policies where tablename in ('personal_activity_commands','personal_activity_transitions','personal_activity_state')")).n===0,'No raw client ledger policy or state access introduced');
// Original identities survive removal of the operational parent; no FK silently
// deletes or nulls the private evidence. This is a disposable fixture deletion.
await db.exec(`insert into projects values('${id(50)}');
insert into work_job_menu_selections(project_id,revision,menu_version_id,selected_by) values('${id(50)}',1,'${id(40)}','${id(1)}');
insert into work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope) values('${id(60)}','${id(1)}','${id(50)}','${id(20)}','${id(40)}','general');`);
const retained=['work_job_menu_selections','work_job_management_grants','work_session_capture_metadata'];
const retainedSnapshot=async()=>JSON.stringify(await Promise.all(retained.map(async table=>(await db.query(`select * from ${table} order by project_id`)).rows)));
const originalEvidence=await retainedSnapshot();
await db.exec(`delete from projects where id='${id(50)}'`);
check(await retainedSnapshot()===originalEvidence,'Deleting fixture project preserves private rows and original job UUIDs byte-for-byte');
for(const table of retained){
 check((await one(`select count(*)::int as n from pg_trigger where tgrelid='${table}'::regclass and tgname='guard_test_account_sandbox_only' and tgenabled in ('O','A') and tgtype=31`)).n===1,table+' has active actual sandbox guard');
 check((await one(`select count(*)::int as n from pg_constraint where conrelid='${table}'::regclass and confrelid='projects'::regclass`)).n===0,table+' has no operational parent FK');
}
await db.exec(`insert into profiles values('${id(99)}',true); select set_config('request.jwt.claim.sub','${id(99)}',false)`);
await refuse(`insert into work_job_management_grants(project_id,profile_id,capability,granted_by) values('${id(50)}','${id(99)}','final_qc','${id(99)}')`,'42501');
await db.exec(`insert into sandbox_projects values('${id(98)}')`);
await db.exec(`insert into work_job_management_grants(project_id,profile_id,capability,granted_by) values('${id(98)}','${id(99)}','final_qc','${id(99)}')`);
check((await one(`select count(*)::int as n from work_job_management_grants where project_id='${id(98)}'`)).n===1,'Actual sandbox guard accepts synthetic sandbox job and refuses synthetic non-sandbox');
await db.exec("select set_config('request.jwt.claim.sub','',false)");
check(await sourceSnapshot()===before,'Fixture metadata checks did not alter original source rows');
await db.close();
console.log(`Work capture inert foundation: ${checks} checks passed; no active timer or multi-backend proof claimed.`);
