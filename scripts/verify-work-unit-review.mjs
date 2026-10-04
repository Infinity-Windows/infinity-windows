// Source-matched disposable sequential proof. Genuine roles/races are separate.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where,detail:e.detail,stack:e.stack}));process.exit(1)});
const moduleUrl=pathToFileURL(process.env.PGLITE_MODULE??'/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js');
const {PGlite}=await import(moduleUrl.href);const {pgcrypto}=await import(new URL('./contrib/pgcrypto.js',moduleUrl));const {uuid_ossp}=await import(new URL('./contrib/uuid_ossp.js',moduleUrl));
const root=new URL('../',import.meta.url);const read=p=>readFileSync(new URL(p,root),'utf8');const hash=s=>createHash('sha256').update(s).digest('hex');
const schema=read('scripts/fixtures/work-activity-engine-online-schema.sql');const engine=read('supabase/migrations/20261108410000_work_activity_engine_cutover.sql');
assert.equal(hash(schema),'ee41a980b19f76baa8637101b62703ecdf798a32eccbb0e9f074fbfd71c62471');assert.equal(hash(engine),'aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648');
const review=read('supabase/migrations/20261108440000_work_unit_review.sql');
const wire=[];const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});const q=async(s,a=[])=>{const row=(await db.query(s,a)).rows[0];if(/select work_unit_review_(read|command|command_receipt)\(/.test(s)&&row?.value)wire.push({sql:s,args:a,result:row.value});return row;};
await db.exec(schema);await db.exec(engine.slice(engine.indexOf('-- INSTALLED_SOURCE_GUARD:'),engine.indexOf('-- INSTALLED_GRAPH_GUARD:')));
await db.exec('begin;'+engine.slice(engine.indexOf('-- DEVELOPMENT_PRIVATE_PREFIX:')).replace(/rollback;\s*$/,'commit;'));
// Incompatible prior installed writer is refused atomically before DDL.
const priorWriter=(await q("select pg_get_functiondef('public._work_activity_row_event()'::regprocedure) value")).value;
assert.ok(priorWriter.includes('AS $function$'));
await db.exec('begin');await db.exec(priorWriter.replace('AS $function$','AS $function$\n-- Deliberately incompatible fixture source'));
let incompatible;try{await db.exec(review)}catch(e){incompatible=e}await db.exec('rollback');
assert.equal(incompatible?.code,'55000','Incompatible prior writer must refuse installation');
assert.equal((await q("select to_regclass('public.work_activity_source_history') value")).value,null,'Failed install leaves no partial history table');
await db.exec(review.replace(/rollback;\s*$/,'commit;'));
console.log('Installed exact review candidate',hash(review));
const watchedTables=['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events'];
const watchedFunctions=['_work_activity_operation_exit','_work_activity_event','_work_activity_touch','_work_activity_safety_exit','_work_activity_shift_lifecycle','_work_activity_retain_source','_work_activity_parent_source_history','_work_activity_source_material','_work_activity_row_event','_work_activity_gate','_work_activity_parent_gate','_work_activity_statement_begin','_work_activity_statement_end','_work_activity_row_before','_work_activity_read_committed','_work_activity_actor','_work_activity_unit_basis','_work_unit_fact_context_visible','_work_unit_fact_peek_epoch','_work_unit_fact_bump_epoch','_ai_job_visible','_work_config_internal','_work_config_is_supervisor','_work_config_is_foreman','is_test_profile','is_sandbox_project','service_job_access','service_internal','_work_unit_review_scope','_work_unit_review_view','_work_unit_review_authority','_work_unit_review_defect_projection','_work_unit_review_payload','_work_unit_review_decimal','_work_unit_review_text','person_record_counts','_work_activity_evidence','_work_activity_operation','work_capture_immutable_record','_work_activity_no_truncate','_work_activity_uuid','_work_activity_integer','_work_activity_object','work_unit_review_command','work_unit_review_read','work_unit_review_command_receipt'];
const sqlArray=xs=>'array['+xs.map(x=>"'"+x+"'").join(',')+']';
const catalogQuery=`select jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(${sqlArray(watchedFunctions)})),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(${sqlArray(watchedTables)}) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relname=any(${sqlArray(watchedTables)})),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(${sqlArray([...watchedFunctions,'_work_unit_review_coverage'])}) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(${sqlArray([...watchedTables.filter(x=>x.startsWith('work_unit_')||x==='work_activity_source_history'),'_work_unit_review_live_sources'])}) and r.rolname in('anon','authenticated','service_role')),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(${sqlArray(watchedTables)}))
) value`;
const catalog=(await q(catalogQuery)).value;
const catalogHash=hash(JSON.stringify(catalog)); // JS hash is fixture receipt only; SQL hashes its own canonical jsonb below.
// SQL canonical hash must be calculated by PostgreSQL, never JSON.stringify.
const expected=(await q(`select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') digest from (${catalogQuery}) c`)).digest;
const contract=`-- Generated exact source/column/trigger coverage; unknown source shape fails closed.
create or replace function public._work_unit_review_coverage() returns boolean
language sql stable security definer set search_path=public,pg_temp as $coverage$
 select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='${expected}' from (${catalogQuery}) c
$coverage$;
revoke all on function public._work_unit_review_coverage() from public,anon,authenticated,service_role;
`;
if(process.argv.includes('--build-coverage')){
 const updated=review.replace(/-- COVERAGE_CONTRACT_BEGIN[\s\S]*?-- COVERAGE_CONTRACT_END/,`-- COVERAGE_CONTRACT_BEGIN\n${contract}-- COVERAGE_CONTRACT_END`);
 writeFileSync(new URL('supabase/migrations/20261108440000_work_unit_review.sql',root),updated);
 await db.exec(contract);
 console.log('Built coverage',expected,'candidate',hash(updated));
}else assert.ok(review.includes(contract),'Coverage source drift: explicitly regenerate and review exact changes');
assert.equal((await q('select _work_unit_review_coverage() yes')).yes,true,'Actual catalog coverage must match');

if(process.argv.includes('--install-only')){await db.close();process.exit(0);}
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const as=async(uid,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid??'']);await db.exec('set role '+role);};
let checks=1;console.log('PASS 1 Exact incompatible prerequisite refused atomically');const check=(yes,label)=>{assert.ok(yes,label);checks++;console.log('PASS',checks,label)};
async function refuse(sql,args=[],code){await db.exec('savepoint expected_refusal');let error;try{await db.query(sql,args)}catch(e){error=e}await db.exec('rollback to savepoint expected_refusal');assert.ok(error,'Expected refusal: '+sql);if(code)assert.equal(error.code,code,error.message);checks++;}
await db.exec('begin');
await db.query('insert into auth.users(id) values($1),($2),($3),($4)',[id(1),id(2),id(3),id(4)]);
await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Observer','owner',false),($2,'Reviewer','owner',false),($3,'Foreman','foreman',false),($4,'Worker','installer',false)",[id(1),id(2),id(3),id(4)]);
await as(id(1),'postgres');await db.query("insert into projects(id,job_code,name) values($1,'UNIT-REVIEW-SYNTHETIC','Synthetic only'),($2,'UNIT-OTHER-SYNTHETIC','Synthetic other')",[id(10),id(11)]);
await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'UNIT-1'),($3,$2,'UNIT-2')",[id(20),id(10),id(21)]);
await as(id(1));
async function unit(uid,opening,width=36,height=48,unit='in'){
 return (await q("select custom_work_command($1,'unit',$2::jsonb) value",[id(uid+1000),JSON.stringify({id:id(uid),revision:0,project_id:id(10),opening_id:id(opening),label:'Unit '+uid,type_label:'Window',facts:{},dimension_observation:{width,height,unit,source:'estimated'},dimension_observation_reason:'Synthetic dimension observation',expected_fact_revision:0})])).value;
}
await unit(30,20);await unit(31,21);
const readView=async(uid=30)=>(await q('select work_unit_review_read($1) value',[id(uid)])).value;
let sequence=2000;
const command=async(action,data,uid=30,basis=null,commandId=null)=>{
 basis??=(await readView(uid)).review.basis;
 const payload={action,basis,data};const cid=commandId??id(sequence++);
 const result=(await q('select work_unit_review_command($1,1,$2::jsonb) value',[cid,JSON.stringify(payload)])).value;
 return {result,payload,cid};
};
let view=await readView();check(view.availability==='available'&&view.review.observation.source==='estimated','Canonical estimated observation preserved');
check(!view.review.capabilities.verifyDimensions,'Immutable observer cannot self verify');
await as(id(2));view=await readView();check(view.review.capabilities.verifyDimensions,'Independent authorized reviewer may corroborate');
const verification=await command('verify_dimensions',{widthDecimal:'0003.000',heightDecimal:'4.0',unit:'ft',source:'measured',sourceReference:null});
view=await readView();check(view.review.dimensionVerification.state==='verified'&&view.review.observation.source==='estimated','Exact ft corroboration attaches without rewriting estimate');
const replay=(await q('select work_unit_review_command($1,1,$2::jsonb) value',[verification.cid,JSON.stringify({...verification.payload,data:{...verification.payload.data,widthDecimal:'3',heightDecimal:'04.000'}})])).value;
check(JSON.stringify(replay)===JSON.stringify(verification.result),'Canonical decimal spellings replay immutable receipt');
await command('submit',{note:null});await command('pass',{note:null});view=await readView();
check(view.review.qc.state==='passed','Explicit submit and reviewer pass retained');
check(view.review.qc.qcAccepted===true,'Exact source coverage permits honest accepted QC');
const payrollSql="select jsonb_build_object('shifts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from time_shifts t),'custom',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from custom_work_sessions t),'unit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from unit_sessions t),'task',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from task_sessions t),'service',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from service_time_sessions t),'actions',(select coalesce(jsonb_agg(to_jsonb(t) order by client_id),'[]') from time_clock_actions t)) value";
await as(id(2),'postgres');const payrollBefore=(await q(payrollSql)).value;await as(id(2));
for(const [unit,width,height] of [['in','36','48'],['mm','914.4','1219.2'],['cm','91.44','121.92']]){await command('verify_dimensions',{widthDecimal:width,heightDecimal:height,unit,source:'plans',sourceReference:'Exact synthetic plan'});check((await readView()).review.dimensionVerification.state==='verified',unit+' exact rational equality');}
let basis=(await readView()).review.basis;
for(const bad of ['0','-1','+1','1e1','.1','1.','NaN','Infinity',' 36','36 ', '1'.repeat(101),36,null,true]) await refuse('select work_unit_review_command($1,1,$2::jsonb)',[id(sequence++),JSON.stringify({action:'verify_dimensions',basis,data:{widthDecimal:bad,heightDecimal:'48',unit:'in',source:'measured',sourceReference:null}})],'23514');
await refuse('select work_unit_review_command($1,1,$2::jsonb)',[id(sequence++),JSON.stringify({action:'verify_dimensions',basis,data:{widthDecimal:'36.00000000000000000000001',heightDecimal:'48',unit:'in',source:'measured',sourceReference:null}})],'23514');
await refuse('select work_unit_review_command($1,1,$2::jsonb)',[verification.cid,JSON.stringify({...verification.payload,data:{...verification.payload.data,source:'plans'}})],'42501');
await as(id(1));await refuse('select work_unit_review_command($1,1,$2::jsonb)',[verification.cid,JSON.stringify(verification.payload)],'42501');
check((await q('select work_unit_review_command_receipt($1) value',[verification.cid])).value.availability==='unavailable','Foreign receipt has no IDs');
await as(id(2));
await command('reopen',{note:'Synthetic inspection'});await command('submit',{note:null});
await command('fail',{note:'Two corrections',defects:[{id:id(500),summary:'Seal corner'},{id:id(501),summary:'Adjust latch'}]});
let failed=await readView();check(failed.review.defects.every(x=>x.state==='open')&&failed.review.qc.state==='failed','Fail creates immutable open defects');
const generation=failed.review.basis.generation;
await as(id(4));await command('claim_resolved',{note:null,defectIds:[id(500)]});failed=await readView();
check(failed.review.qc.state==='failed'&&failed.review.basis.generation===generation,'Partial claim stays failed in current generation');
await command('claim_resolved',{note:null,defectIds:[id(501)]});failed=await readView();
check(failed.review.qc.state==='awaiting_review'&&failed.review.basis.generation===generation+1,'All claims start a fresh correction submission');
await as(id(2));await command('fail',{note:'Corner needs another correction',defects:[]});
check((await readView()).review.defects.every(x=>x.state==='open'),'Fail may reject real claims without inventing a new defect');
await as(id(4));await command('claim_resolved',{note:null,defectIds:[id(500),id(501)]});
await as(id(2));await command('pass',{note:null});view=await readView();
check(view.review.defects.every(x=>x.state==='verified_resolved')&&view.review.qc.qcAccepted,'Only reviewer pass verifies claimed corrections');
await as(id(2),'postgres');check(JSON.stringify((await q(payrollSql)).value)===JSON.stringify(payrollBefore),'Review cycle leaves every timing row and payroll receipt byte-identical');await as(id(2));
await command('submit',{note:null},31);await command('pass',{note:null},31);
const otherBefore=(await readView(31)).review.basis.scopeToken;
const staleBasis=(await readView()).review.basis;
await db.query("update project_openings set status='installed' where id=$1",[id(20)]);
await db.query("update project_openings set status='planned' where id=$1",[id(20)]);
view=await readView();check(!view.review.qc.qcAccepted&&view.review.qc.state==='not_submitted'&&view.review.basis.scopeToken!==staleBasis.scopeToken,'Opening status ABA invalidates prior pass');
check((await readView(31)).review.qc.qcAccepted&&(await readView(31)).review.basis.scopeToken===otherBefore,'Unrelated unit remains accepted with identical token');
check(view.review.dimensionVerification.state==='verified','Work-only reopening does not revoke dimension corroboration');
await refuse('select work_unit_review_command($1,1,$2::jsonb)',[id(sequence++),JSON.stringify({action:'submit',basis:staleBasis,data:{note:null}})],'40001');
await command('submit',{note:null});await command('pass',{note:null});
await as(id(2),'postgres');
await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,started_by) values($1,$2,'flashing','active',clock_timestamp(),null)",[id(600),id(20)]);
await as(id(2));view=await readView();check(view.review.work.pendingCount>0&&!view.review.qc.qcAccepted,'Null-starter phase is retained and prevents current QC');
await as(id(2),'postgres');
const phaseBefore=(await q("select count(*)::int n from work_activity_source_history where source_kind='opening_phases' and source_id=$1",[id(600)])).n;
const retainedRoot=(await q("select _work_activity_operation_enter('unit_review_fixture') id")).id;
await db.query("update opening_phases set status='submitted',submitted_at=clock_timestamp() where id=$1",[id(600)]);
await db.query("update opening_phases set status='active',submitted_at=null where id=$1",[id(600)]);
await db.query("update opening_phases set status='submitted',submitted_at=clock_timestamp() where id=$1",[id(600)]);
await q('select _work_activity_operation_exit($1)',[retainedRoot]);
check((await q("select count(*)::int n from work_activity_source_history where source_kind='opening_phases' and source_id=$1",[id(600)])).n===phaseBefore+3,'Same-source intermediate phase mutations survive finalization');
check((await q('select count(*)::int n from work_activity_source_history where operation_id=$1',[retainedRoot])).n===3&&(await q('select count(*)::int n from work_activity_operations where id=$1',[retainedRoot])).n===0,'Three intermediate mutations retain root identity after ephemeral operation deletion');
await as(id(2));await command('submit',{note:null});await command('pass',{note:null});
check((await readView()).review.qc.qcAccepted,'Quiescent completed phase can be explicitly resubmitted and accepted');
// The phase's only worker must be included even without any profile_id source.
await as(id(2),'postgres');await db.exec('savepoint phase_only_worker');
await db.query('insert into auth.users(id) values($1)',[id(5)]);
await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Phase-only worker','installer',false)",[id(5)]);
await db.query('update opening_phases set started_by=$1 where id=$2',[id(5),id(600)]);
await as(id(2));await command('submit',{note:null});await command('pass',{note:null});
check((await readView()).review.qc.qcAccepted,'Clean phase-only worker supports proven acceptance');
const phaseOtherToken=(await readView(31)).review.basis.scopeToken;
await as(id(2),'postgres');await db.exec('savepoint phase_dirty_state');
await db.query("update personal_activity_state set integrity_state='review' where profile_id=$1",[id(5)]);
await as(id(2));view=await readView();check(view.review.qc.lifecycle==='unproven'&&view.review.qc.acceptance==='recorded_only'&&!view.review.qc.qcAccepted,'Phase-only dirty subject state cannot retain accepted QC');
check((await readView(31)).review.qc.qcAccepted&&(await readView(31)).review.basis.scopeToken===phaseOtherToken,'Phase-only dirty state preserves unrelated unit');
await as(id(2),'postgres');await db.exec('rollback to savepoint phase_dirty_state');
const phaseRevision=(await q('select revision from personal_activity_state where profile_id=$1',[id(5)])).revision;
await db.query('update personal_activity_state set revision=9007199254740991 where profile_id=$1',[id(5)]);
await db.query("update opening_phases set submitted_at=submitted_at+interval '1 second' where id=$1",[id(600)]);
check((await q("select count(*)::int n from work_activity_safety_events where source_kind='phase' and source_id=$1 and profile_id=$2",[id(600),id(5)])).n===1,'Real phase operation emits source-linked safety for phase-only worker');
// Clear only the disposable current-state uncertainty to isolate retained safety.
await db.query("update personal_activity_state set revision=$1,integrity_state='clean' where profile_id=$2",[phaseRevision,id(5)]);
await as(id(2));view=await readView();check(view.review.qc.lifecycle==='unproven'&&!view.review.qc.qcAccepted,'Retained exact phase safety remains unproven after current state is clean');
await command('submit',{note:null});await command('pass',{note:null});view=await readView();
check(view.review.qc.acceptance==='recorded_only'&&!view.review.qc.qcAccepted,'A recorded pass never accepts a phase-only unsafe source');
check((await readView(31)).review.qc.qcAccepted&&(await readView(31)).review.basis.scopeToken===phaseOtherToken,'Exact phase safety preserves unrelated unit');
await as(id(2),'postgres');await db.exec('rollback to savepoint phase_only_worker');
// Restoring trigger metadata cannot conceal current source holes.
for(const [table,sid,insertSql,args] of [
 ['unit_sessions',id(780),"insert into unit_sessions(id,opening_id,profile_id,started_at,ended_at) values($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour')",[id(780),id(20),id(1)]],
 ['task_sessions',id(781),"insert into task_sessions(id,opening_id,project_id,profile_id,state,started_at,ended_at) values($1,$2,$3,$4,'on_task',now()-interval '2 hours',now()-interval '1 hour')",[id(781),id(20),id(10),id(1)]]]){
 await db.exec('savepoint capture_hole');await db.exec('alter table '+table+' disable trigger zz_work_activity_row');await db.query(insertSql,args);await db.exec('alter table '+table+' enable trigger zz_work_activity_row');
 check((await q('select _work_unit_review_coverage() yes')).yes,'Restored '+table+' catalog alone is current');
 check((await q('select count(*)::int n from work_activity_source_history where source_kind=$1 and source_id=$2',[table,sid])).n===0,table+' fixture has an actual uncaptured live source');
 await as(id(2));view=await readView();check(view.review.qc.lifecycle==='unproven'&&!view.review.qc.qcAccepted,'Live '+table+' hole cannot preserve accepted QC after capture restoration');
 check((await readView(31)).review.qc.qcAccepted,'Uncaptured '+table+' preserves unrelated unit');
 await as(id(2),'postgres');await db.query('delete from '+table+' where id=$1',[sid]);
 check((await q('select bool_and(legacy_baseline) yes from work_activity_source_history where source_kind=$1 and source_id=$2',[table,sid])).yes,'Later captured '+table+' deletion retains unknown original provenance');
 await as(id(2));check((await readView()).review.qc.lifecycle==='unproven'&&!(await readView()).review.qc.qcAccepted,'Deleting uncaptured '+table+' cannot heal its history gap');
 await as(id(2),'postgres');await db.exec('rollback to savepoint capture_hole');
}
await db.exec('savepoint capture_changed_material');await db.exec('alter table opening_phases disable trigger zz_work_activity_row');
await db.query('update opening_phases set minutes=999 where id=$1',[id(600)]);await db.exec('alter table opening_phases enable trigger zz_work_activity_row');
await as(id(2));check((await readView()).review.qc.lifecycle==='unproven'&&!(await readView()).review.qc.qcAccepted,'Existing source with never-retained current material is unproven');
await as(id(2),'postgres');await db.query('update opening_phases set minutes=998 where id=$1',[id(600)]);
check((await q("select count(*)::int n from work_activity_source_history where source_kind='opening_phases' and source_id=$1 and legacy_baseline and before_value->>'minutes'='999'",[id(600)])).n===1,'Captured update retains never-recorded predecessor material as unknown');
await as(id(2));check((await readView()).review.qc.lifecycle==='unproven','Later captured update cannot heal an existing source material gap');
await as(id(2),'postgres');await db.exec('rollback to savepoint capture_changed_material');
// Metadata drift can never silently continue certifying coverage.
await as(id(2),'postgres');await db.exec('savepoint drift');await db.exec('alter table opening_phases disable trigger zz_work_activity_row');await as(id(2));
check((await readView()).review.qc.lifecycle==='unproven'&&!(await readView()).review.qc.qcAccepted,'Missing source capture marker fails closed');await as(id(2),'postgres');await db.exec('rollback to savepoint drift');await db.exec('savepoint acl_drift');await db.exec('grant select on work_unit_review_events to authenticated');await as(id(2));check((await readView()).review.qc.lifecycle==='unproven','Raw private ACL drift invalidates coverage');await as(id(2),'postgres');await db.exec('rollback to savepoint acl_drift');
await db.exec('savepoint hidden');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(10)]);await as(id(2));
const hidden=await readView();check(hidden.availability==='unavailable'&&hidden.review===null&&Object.keys(hidden).length===4,'Hidden current source has generic unavailable shape');
check((await q('select work_unit_review_command_receipt($1) value',[verification.cid])).value.receipt===null,'Hidden source removes historical receipt projection');await as(id(2),'postgres');await db.exec('rollback to savepoint hidden');
await as(id(2));
for(const table of watchedTables.filter(x=>x.startsWith('work_unit_')||x==='work_activity_source_history')) await refuse(`select * from ${table}`,[],'42501');
await as(id(2),'service_role');await refuse('select * from work_unit_review_commands',[],'42501');await refuse('select _work_activity_retain_source(\'custom_work_units\',\'forged\',\'{}\',\'{}\')',[],'42501');
await as(id(2),'postgres');await refuse('delete from work_unit_review_events',[],'23514');await refuse('truncate work_activity_source_history',[],'23514');
const census=(await q('select person_record_counts($1) value',[id(1)])).value;check(census['work_unit_dimension_verifications.observation_actor_id']>0&&census['work_activity_source_history.original_identities']>0,'Account census retains immutable observer and original source identities');

// Each source family changes one unit while the other remains current.
await as(id(2));
async function mutation(label,sql,args=[]){
 const before=(await readView()).review;const other=(await readView(31)).review;
 await as(id(2),'postgres');await db.exec('savepoint source_family');await db.query(sql,args);await as(id(2));
 const after=(await readView()).review;check(after.basis.scopeToken!==before.basis.scopeToken&&!after.qc.qcAccepted,label+' invalidates exact unit');
 check((await readView(31)).review.basis.scopeToken===other.basis.scopeToken&&(await readView(31)).review.qc.qcAccepted,label+' preserves unrelated unit');
 if(label.startsWith('Closed')){await command('submit',{note:null});await command('pass',{note:null});check((await readView()).review.qc.qcAccepted,label+' complete retained lifecycle supports fresh acceptance');}
 await as(id(2),'postgres');await db.exec('rollback to savepoint source_family');await as(id(2));
}
await mutation('Closed legacy unit session',"insert into unit_sessions(id,opening_id,profile_id,started_at,ended_at) values($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour')",[id(700),id(20),id(1)]);
await mutation('Closed mapped task session',"insert into task_sessions(id,opening_id,project_id,profile_id,state,started_at,ended_at) values($1,$2,$3,$4,'on_task',now()-interval '2 hours',now()-interval '1 hour')",[id(701),id(20),id(10),id(1)]);
await mutation('Redo history',"insert into unit_redos(id,opening_id,pressed_by,reason) values($1,$2,$3,'Synthetic redo')",[id(702),id(20),id(1)]);
await as(id(2),'postgres');await db.exec('savepoint legacy_qc_fixture');await db.query("update project_openings set status='installed' where id=$1",[id(20)]);await as(id(2));await command('submit',{note:null});await command('pass',{note:null});
await mutation('Legacy QC callback',"insert into qc_checks(id,project_opening_id,status,checked_by) values($1,$2,'callback',$3)",[id(703),id(20),id(1)]);
await as(id(2),'postgres');await db.exec('rollback to savepoint legacy_qc_fixture');await as(id(2));
await mutation('Install evidence',"insert into install_events(id,project_opening_id,installer_id,minutes) values($1,$2,$3,30)",[id(704),id(20),id(1)]);
await mutation('Crew reported work',"insert into crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description) values($1,$2,$3,$4,current_date,'Installing','finished',false,'Synthetic')",[id(705),id(10),id(30),id(1)]);
await as(id(2),'postgres');await db.exec('savepoint service_fixture');
await db.query("insert into service_visits(id,project_id,created_by) values($1,$2,$3)",[id(710),id(10),id(1)]);
await db.query("insert into service_visit_units(id,visit_id,project_id,created_by,work_unit_id,opening_id,label,type_label,issue,outcome) values($1,$2,$3,$4,$5,$6,'Synthetic unit','Window','Synthetic service','resolved')",[id(711),id(710),id(10),id(1),id(30),id(20)]);
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status) values($1,$2,$3,now()-interval '4 hours',now()-interval '1 hour','submitted')",[id(712),id(1),id(10)]);
await as(id(2));await command('submit',{note:null});await command('pass',{note:null});
await mutation('Service work through actual bridge',"insert into service_time_sessions(id,visit_id,project_id,unit_id,shift_id,profile_id,kind,stage,description,started_at,ended_at) values($1,$2,$3,$4,$5,$6,'unit','Repair','Synthetic',now()-interval '3 hours',now()-interval '2 hours')",[id(713),id(710),id(10),id(711),id(712),id(1)]);
await as(id(2),'postgres');await db.exec('rollback to savepoint service_fixture');
await db.exec('savepoint helper_fixture');await db.query("insert into summons(id,project_id,opening_id,requested_by,needed,status) values($1,$2,$3,$4,1,'closed')",[id(720),id(10),id(20),id(1)]);
await as(id(2));await command('submit',{note:null});await command('pass',{note:null});
await mutation('Helper through actual summon opening',"insert into summon_helpers(id,summon_id,profile_id,joined_at,completed_at,minutes) values($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour',60)",[id(721),id(720),id(1)]);
await as(id(2),'postgres');await db.exec('rollback to savepoint helper_fixture');
// The authenticated foreman's distinct grant does not make them an independent observer.
await as(id(2));for(const cap of ['dimensions_edit','final_qc']) await q('select work_grant_job_capability($1,$2,$3,$4)',[id(sequence++),id(10),id(3),cap]);
await as(id(3));await command('submit',{note:null});await command('pass',{note:null});check((await readView()).review.qc.qcAccepted,'Foreman can submit and finally approve their own work on granted job');
// Gated canonical relink retains original source and grant obligations.
await as(id(1));await db.exec('savepoint original_scope');
const original=(await readView()).review.basis;
await q("select custom_work_command($1,'link',$2::jsonb)",[id(sequence++),JSON.stringify({id:id(30),revision:original.unitRevision,project_id:id(11),opening_id:null,label:'Relinked',type_label:'Window',facts:(await q('select facts from custom_work_units where id=$1',[id(30)])).facts,reason:'Synthetic source test'})]);
await as(id(3));check(!(await readView()).review.capabilities.verifyDimensions,'Destination grant is separately required after relink');
await as(id(2));await q('select work_grant_job_capability($1,$2,$3,$4)',[id(sequence++),id(11),id(3),'dimensions_edit']);await as(id(3));check((await readView()).review.capabilities.verifyDimensions,'All current and original grants allow corroboration');
await as(id(2),'postgres');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(10)]);await as(id(3));check((await readView()).availability==='unavailable','Hidden original job denies current destination scope');
await as(id(2),'postgres');await db.exec('rollback to savepoint original_scope');
// Exact original decimals beyond IEEE-754 precision are never transported as Number.
await db.exec('savepoint exact_precision');await as(id(1));
const precisionData={id:id(740),revision:0,project_id:id(10),opening_id:null,label:'Exact decimal',type_label:'Window',facts:{},dimension_observation:{width:'0.10000000000000000000000000001',height:1,unit:'mm',source:'estimated'},expected_fact_revision:0};
const precisionJson=JSON.stringify(precisionData).replace('"width":"0.10000000000000000000000000001"','"width":0.10000000000000000000000000001');
await q("select custom_work_command($1,'unit',$2::jsonb)",[id(sequence++),precisionJson]);await as(id(2));
const pv=(await readView(740)).review;check(pv.observation.widthDecimal==='0.10000000000000000000000000001','Canonical raw SQL decimal reaches wire without rounding');
await command('verify_dimensions',{widthDecimal:'0.10000000000000000000000000001',heightDecimal:'1',unit:'mm',source:'measured',sourceReference:null},740);
check((await readView(740)).review.dimensionVerification.state==='verified','Exact high-precision original verifies');
await refuse('select work_unit_review_command($1,1,$2::jsonb)',[id(sequence++),JSON.stringify({action:'verify_dimensions',basis:(await readView(740)).review.basis,data:{widthDecimal:'0.1',heightDecimal:'1',unit:'mm',source:'measured',sourceReference:null}})],'23514');
await as(id(2),'postgres');await db.exec('rollback to savepoint exact_precision');

// Missing fact is an available unit with no authorable basis.
await as(id(1));await q("select custom_work_command($1,'unit',$2::jsonb)",[id(sequence++),JSON.stringify({id:id(750),revision:0,project_id:id(10),opening_id:null,label:'No observed dimensions',type_label:'Window',facts:{}})]);
await as(id(2));const missing=(await readView(750)).review;check(missing.basis===null&&Object.values(missing.capabilities).every(x=>x===false),'Missing fact remains available without fabricated basis or authority');
// Actual canonical work and payroll callbacks: no review writer runs in them.
await as(id(4),'postgres');await db.exec('savepoint actual_work');await db.exec('select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1');
await db.query("insert into toolbox_completions(profile_id,signed_at,typed_name) values($1,clock_timestamp(),'Synthetic worker')",[id(4)]);
await as(id(4));
const now=(await q('select clock_timestamp() stamp')).stamp;const at=seconds=>new Date(now.getTime()+seconds*1000).toISOString();
const shift=(await q('select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0,1)) value',[id(10),id(sequence++),at(-600),at(0)])).value;
const started=(await q("select custom_work_command($1,'start',$2::jsonb) value",[id(sequence++),JSON.stringify({id:id(760),shift_id:shift.id,unit_id:id(30),expected_session_id:null,at:at(-500),kind:'unit',participation:'install',stage:'Installing',description:'Synthetic work'})])).value;
await as(id(2));view=await readView();check(view.review.work.activeCount>0&&!view.review.qc.qcAccepted&&!view.review.capabilities.submit,'Canonical active custom work fences current approval and submission');
await as(id(4));await q('select start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)',[shift.id,'rest',id(sequence++),at(-400),at(0)]);
await as(id(2));view=await readView();check(view.review.work.pendingCount>0&&!view.review.capabilities.submit,'Closed during break retains server resume intent and cannot pass');
await as(id(2),'postgres');const reviewCountBefore=(await q('select count(*)::int n from work_unit_review_events')).n;
await db.exec('savepoint corrupted_review');
// Broken pointer and exhausted private counter must never become a payroll refusal.
await db.query('update work_unit_review_current set review_revision=9007199254740991,latest_event_id=$1 where unit_id=$2',[id(999999),id(30)]);
await as(id(4));await q('select end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,0)',[shift.id,id(sequence++),at(-300),at(0)]);
await as(id(2),'postgres');check((await q('select count(*)::int n from custom_work_sessions where unit_id=$1 and ended_at is null',[id(30)])).n===1,'Resume succeeds despite exhausted/broken private review state');
await db.query('delete from work_unit_review_current where unit_id=$1',[id(30)]);
await as(id(4));await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0)) value',[shift.id,id(sequence++),at(-200),at(0)]);
await as(id(2),'postgres');const finalShift=await q('select break_seconds,clock_out_at from time_shifts where id=$1',[shift.id]);
check(finalShift.break_seconds===100&&new Date(finalShift.clock_out_at).toISOString()===at(-200),'Clock-out succeeds with missing pointer and preserves exact payroll boundaries');
check((await q('select count(*)::int n from work_unit_review_events')).n===reviewCountBefore,'Break/resume/out never create review events');
await db.exec('rollback to savepoint corrupted_review');await as(id(4));
await q('select end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,0)',[shift.id,id(sequence++),at(-300),at(0)]);
await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0)) value',[shift.id,id(sequence++),at(-200),at(0)]);
await as(id(2));await command('submit',{note:null});await command('pass',{note:null});check((await readView()).review.qc.qcAccepted,'Actual complete custom break/resume/out history supports fresh accepted QC');
const beforeShiftABA=(await readView()).review.basis.scopeToken;await as(id(2),'postgres');await db.query("update time_shifts set status='voided' where id=$1",[shift.id]);await db.query("update time_shifts set status='submitted' where id=$1",[shift.id]);await as(id(2));check((await readView()).review.basis.scopeToken!==beforeShiftABA&&!(await readView()).review.qc.qcAccepted,'Relevant shift void/restore ABA remains in affected unit lifecycle');
await as(id(2),'postgres');await db.exec('rollback to savepoint actual_work');
// A source row delete/reinsert changes the retained sequence even if values match.
await db.exec('savepoint delete_reinsert');const phase=(await q('select to_jsonb(p) value from opening_phases p where id=$1',[id(600)])).value;
const beforeDelete=(await readView()).review.basis.scopeToken;
await db.query('delete from opening_phases where id=$1',[id(600)]);await db.query('insert into opening_phases select (jsonb_populate_record(null::opening_phases,$1::jsonb)).*',[JSON.stringify(phase)]);
await as(id(2));check((await readView()).review.basis.scopeToken!==beforeDelete&&!(await readView()).review.qc.qcAccepted,'Same-value source delete/reinsert never restores old pass');
await as(id(2),'postgres');await db.exec('rollback to savepoint delete_reinsert');

// A baseline cannot pretend to recover missing pre-install intermediate history.
await db.exec('savepoint legacy_baseline');await db.query("insert into work_activity_source_history(source_kind,source_id,transaction_id,tx_order,before_value,after_value,legacy_baseline) select source_kind,source_id,pg_current_xact_id(),0,before_value,after_value,true from work_activity_source_history where source_kind='custom_work_units' and source_id=$1 limit 1",[id(30)]);await as(id(2));check((await readView()).review.qc.lifecycle==='unproven'&&!(await readView()).review.qc.qcAccepted,'Legacy baseline cannot certify missing pre-install lifecycle');await as(id(2),'postgres');await db.exec('rollback to savepoint legacy_baseline');

// Current/original opening visibility and exact fact changes are independent.
await as(id(2),'postgres');await db.exec('savepoint original_opening_move');
await db.query("insert into projects(id,job_code,name) values($1,'REVIEW-THIRD','Synthetic third')",[id(12)]);
await as(id(1));const moveBasis=(await readView()).review.basis;const moveFacts=(await q('select facts from custom_work_units where id=$1',[id(30)])).facts;
await q("select custom_work_command($1,'link',$2::jsonb)",[id(sequence++),JSON.stringify({id:id(30),revision:moveBasis.unitRevision,project_id:id(11),opening_id:null,label:'Relinked',type_label:'Window',facts:moveFacts,reason:'Synthetic original opening'})]);
await as(id(2),'postgres');await db.query('update project_openings set project_id=$1 where id=$2',[id(12),id(20)]);
await as(id(2));for(const j of [11,12])await q('select work_grant_job_capability($1,$2,$3,$4)',[id(sequence++),id(j),id(3),'dimensions_edit']);
await as(id(3));check((await readView()).review.capabilities.verifyDimensions,'Original opening moved to third visible granted job remains authorized');
await as(id(2),'postgres');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(12)]);await as(id(3));check((await readView()).availability==='unavailable','Hidden current job of original opening makes entire scope unavailable');
await as(id(2),'postgres');await db.exec('rollback to savepoint original_opening_move');
await db.exec('savepoint changed_fact');await as(id(1));
const factBasis=(await readView()).review.basis;const existingFacts=(await q('select facts from custom_work_units where id=$1',[id(30)])).facts;
const changed={id:id(30),revision:factBasis.unitRevision,project_id:id(10),opening_id:id(20),label:'Unit 30',type_label:'Window',facts:{},dimension_observation:{width:37,height:48,unit:'in',source:'measured'},expected_fact_revision:factBasis.factRevision};
await q("select custom_work_command($1,'unit',$2::jsonb)",[id(sequence++),JSON.stringify(changed)]);await as(id(2));
view=await readView();check(view.review.dimensionVerification.state==='noncurrent'&&!view.review.qc.qcAccepted,'Replacing observation invalidates old corroboration and old QC independently');
await as(id(1));const cleared={...changed,revision:view.review.basis.unitRevision,expected_fact_revision:view.review.basis.factRevision,dimension_observation:null,dimension_observation_reason:'Synthetic reset'};
await q("select custom_work_command($1,'unit',$2::jsonb)",[id(sequence++),JSON.stringify(cleared)]);await as(id(2));view=await readView();check(view.review.observation===null&&Object.values(view.review.capabilities).every(x=>x===false),'Explicit null reset cannot manufacture observation or QC authority');
await as(id(2),'postgres');await db.exec('rollback to savepoint changed_fact');
await db.exec('savepoint exhausted_source');await db.query("insert into work_unit_fact_context_epochs(scope_kind,scope_id,epoch) values('opening',$1,9007199254740991) on conflict(scope_kind,scope_id) do update set epoch=excluded.epoch",[id(20)]);
await as(id(2));view=await readView();check(view.review.qc.lifecycle==='unproven'&&!view.review.qc.qcAccepted&&!view.review.capabilities.verifyDimensions,'Exhausted source token cannot certify QC or corroboration');
await as(id(2),'postgres');await db.exec('rollback to savepoint exhausted_source');
await db.exec('savepoint retained_purge');const originalUnit=(await q('select to_jsonb(u) value from custom_work_units u where id=$1',[id(30)])).value;
const retainedBefore=(await q('select count(*)::int n from work_unit_review_events where unit_id=$1',[id(30)])).n;
await db.query('delete from custom_work_units where id=$1',[id(30)]);await as(id(2));check((await readView()).availability==='unavailable','Purged operational unit exposes no retained private review projection');
check((await q('select work_unit_review_command_receipt($1) value',[verification.cid])).value.availability==='unavailable','Historical receipt stays unavailable after source purge');
await as(id(2),'postgres');check((await q('select count(*)::int n from work_unit_review_events where unit_id=$1',[id(30)])).n===retainedBefore,'Operational purge preserves all immutable private review events');
await db.query('insert into custom_work_units select (jsonb_populate_record(null::custom_work_units,$1::jsonb)).*',[JSON.stringify(originalUnit)]);await as(id(2));check((await readView()).availability==='unavailable','Recreated physical UUID never inherits prior fact or approval');
await as(id(2),'postgres');await db.exec('rollback to savepoint retained_purge');

for(const row of (await db.query(read('scripts/verify-work-unit-review-installed.sql'))).rows)check(row.passed,row.check_name);
if(process.env.WORK_UNIT_REVIEW_WIRE_OUT){assert.ok(JSON.stringify(wire).length<2000000,'Bounded wire corpus');writeFileSync(process.env.WORK_UNIT_REVIEW_WIRE_OUT,JSON.stringify({reviewSha256:hash(read('supabase/migrations/20261108440000_work_unit_review.sql')),scope:'Actual source-matched synthetic SQL RPC results; not provider evidence',calls:wire},null,2));}
await db.exec('rollback');await db.close();console.log(JSON.stringify({checks,reviewSha256:hash(read('supabase/migrations/20261108440000_work_unit_review.sql')),scope:'Source-matched sequential PGlite; not genuine-role or wait proof'}));
