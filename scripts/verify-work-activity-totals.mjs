// Source-matched disposable totals proof; genuine roles/waits are separate.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where,detail:e.detail,stack:e.stack}));process.exit(1)});
const root=new URL('../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
const moduleUrl=pathToFileURL(process.env.PGLITE_MODULE??'/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js');
const {PGlite}=await import(moduleUrl.href),{pgcrypto}=await import(new URL('./contrib/pgcrypto.js',moduleUrl)),{uuid_ossp}=await import(new URL('./contrib/uuid_ossp.js',moduleUrl));
const db=new PGlite({extensions:{pgcrypto,uuid_ossp}}),wire=[];
const q=async(sql,args=[])=>{const row=(await db.query(sql,args)).rows[0];if(sql.includes('work_activity_totals_read(')&&row?.value)wire.push({sql,args,result:row.value});return row};
const schema=read('scripts/fixtures/work-activity-engine-online-schema.sql'),engine=read('supabase/migrations/20261108410000_work_activity_engine_cutover.sql'),review=read('supabase/migrations/20261108440000_work_unit_review.sql');let totals=read('supabase/migrations/20261108450000_work_activity_totals.sql');
assert.equal(hash(schema),'ee41a980b19f76baa8637101b62703ecdf798a32eccbb0e9f074fbfd71c62471');assert.equal(hash(engine),'aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648');
await db.exec(schema);await db.exec('alter default privileges for role postgres in schema public grant execute on functions to service_role');
await db.exec(engine.slice(engine.indexOf('-- INSTALLED_SOURCE_GUARD:'),engine.indexOf('-- INSTALLED_GRAPH_GUARD:')));
await db.exec('begin;'+engine.slice(engine.indexOf('-- DEVELOPMENT_PRIVATE_PREFIX:')).replace(/rollback;\s*$/,'commit;'));
await db.exec(review.replace(/rollback;\s*$/,'commit;'));
const priorLookupIndexes=(await db.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events') order by tablename,indexname")).rows;
if(process.argv.includes('--inspect-catalog-version')){console.log(JSON.stringify((await db.query("select current_setting('server_version') version,current_setting('server_version_num') version_num,(select count(*)::int from pg_constraint where contype='n') catalog_not_null_rows,(select count(*)::int from pg_attribute where attnotnull and attnum>0 and not attisdropped) attribute_not_null_rows")).rows[0],null,2));await db.close();process.exit(0);}
if(process.argv.includes('--inspect-indexes')){console.log(JSON.stringify(priorLookupIndexes,null,2));await db.close();process.exit(0);}
// Reproduce the seven raw privileges observed on the provider's newly held
// safety table. This is a disposable ACL fixture, not a production grant.
await db.exec('grant all on table public.work_activity_safety_events to service_role');
const safetyPrivileges="array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']";
assert.equal((await q(`select bool_and(has_table_privilege('service_role','public.work_activity_safety_events',p)) yes from unnest(${safetyPrivileges}) p`)).yes,true);
const serviceDeniedFunctions=["public._work_activity_answers(jsonb,jsonb)", "public._work_activity_authority_changed()", "public._work_activity_authority_guard()", "public._work_activity_authority_revision()", "public._work_activity_bookkeeping_guard()", "public._work_activity_clock_replay_guard(uuid,text,uuid)", "public._work_activity_clock_review(uuid,uuid,text,timestamptz,timestamptz,integer)", "public._work_activity_close_all(uuid,timestamptz,text,text,uuid)", "public._work_activity_close_source(uuid,text,uuid,timestamptz,text)", "public._work_activity_command_basis(jsonb)", "public._work_activity_context_for(uuid,text,timestamptz)", "public._work_activity_ephemeral_commit_guard()", "public._work_activity_fact_snapshot(uuid)", "public._work_activity_finish(uuid,anyelement)", "public._work_activity_insert_source(uuid,text,jsonb,timestamptz,text)", "public._work_activity_instant(jsonb,boolean)", "public._work_activity_iso(timestamptz)", "public._work_activity_keep_clock_receipt()", "public._work_activity_live_sources(uuid)", "public._work_activity_operation_enter(text,jsonb,uuid,uuid)", "public._work_activity_payload(jsonb)", "public._work_activity_profile_delete_guard()", "public._work_activity_project_view(uuid,uuid)", "public._work_activity_refresh_state(uuid)", "public._work_activity_resume(public.personal_activity_state,public.time_shifts,timestamptz)", "public._work_activity_review_visit(uuid,timestamptz,text)", "public._work_activity_row_allowance(oid,text,jsonb,jsonb)", "public._work_activity_safety_guard()", "public._work_activity_source_view(public.personal_activity_state)", "public._work_activity_start_setup(public.time_shifts,uuid,uuid)", "public._work_activity_validate_switch(jsonb,uuid)", "public.clock_in(uuid,uuid,text,double precision,double precision,text,text,uuid,timestamptz,timestamptz,integer,integer)", "public.work_activity_command(uuid,integer,jsonb)", "public.work_activity_snapshot(uuid)"];
const serviceRoleClosureSql="select bool_and(has_function_privilege($1,f::regprocedure,'EXECUTE')) allowed from unnest($2::text[]) f";
assert.equal((await q(serviceRoleClosureSql,['service_role',serviceDeniedFunctions])).allowed,true,'Provider-default fixture starts with all34 observed function grants');
await db.exec(totals.replace(/rollback;\s*$/,'commit;'));
assert.equal((await q("select bool_and(not has_function_privilege('service_role',f::regprocedure,'EXECUTE')) denied from unnest($1::text[]) f",[serviceDeniedFunctions])).denied,true);
assert.equal((await q(serviceRoleClosureSql,['postgres',serviceDeniedFunctions])).allowed,true);
assert.equal((await q(serviceRoleClosureSql,['authenticated',serviceDeniedFunctions.slice(-3)])).allowed,true);
assert.equal((await q(`select bool_and(not has_table_privilege('service_role','public.work_activity_safety_events',p)) yes from unnest(${safetyPrivileges}) p`)).yes,true);
assert.equal((await q(`select bool_and(has_table_privilege('postgres','public.work_activity_safety_events',p)) yes from unnest(${safetyPrivileges}) p`)).yes,true);
const watchedTables=['time_shifts','personal_activity_state','personal_activity_transition_sources','personal_activity_transitions','work_activity_safety_events','work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs','custom_work_units','project_openings','service_visit_units','service_visits','summons','unit_redos','qc_checks','install_events','crew_work_records','crew_work_record_people','work_session_capture_metadata','custom_work_history','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','summon_helpers','work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events','work_setup_sessions','personal_activity_commands','work_activity_definitions','work_activity_definition_versions','work_capture_menus','work_capture_menu_versions','work_capture_menu_items','work_job_menu_selections'];
const watchedFunctions=(await db.query("select distinct proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (proname like '_work_activity_%' or proname like '_work_totals_%' or proname like '_work_config_%' or proname in ('work_activity_command','work_activity_snapshot','work_capture_immutable_record','work_publish_activity_version','work_publish_menu_version','work_select_job_menu','clock_in','clock_out','start_break','end_break','shift_cap_hours','work_activity_totals_read','_work_unit_review_coverage')) and proname<>'_work_totals_coverage' order by 1")).rows.map(x=>x.proname);
const sqlArray=xs=>'array['+xs.map(x=>"'"+x+"'").join(',')+']';
// PostgreSQL18 adds relation NOT NULL catalog rows; PostgreSQL17 stores the
// same invariant in attnotnull. Attest its semantic flags per column, not the
// version-specific duplicate name. NOT VALID / NO INHERIT remain fail-closed.
const catalogQuery=`select jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(${sqlArray(watchedFunctions)})),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(${sqlArray(watchedTables)}) and not t.tgisinternal),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'notNullValidated',coalesce(nn.validated,true),'notNullEnforced',coalesce(nn.enforced,true),'notNullNoInherit',coalesce(nn.no_inherit,false),'generated',a.attgenerated,'identity',a.attidentity) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join lateral (select bool_and(k.convalidated) validated,bool_and(coalesce((to_jsonb(k)->>'conenforced')::boolean,true)) enforced,bool_or(k.connoinherit) no_inherit from pg_constraint k where k.conrelid=a.attrelid and k.contype='n' and a.attnum=any(k.conkey)) nn on true where n.nspname='public' and c.relname=any(${sqlArray(watchedTables)})),
 'functionAccess',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'role',r.rolname,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE')) order by p.proname,pg_get_function_identity_arguments(p.oid),r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r where n.nspname='public' and p.proname=any(${sqlArray([...watchedFunctions,'_work_totals_coverage'])}) and r.rolname in('anon','authenticated','service_role')),
 'privateAccess',(select jsonb_agg(jsonb_build_object('table',c.relname,'role',r.rolname,'privilege',v.name,'allowed',has_table_privilege(r.oid,c.oid,v.name)) order by c.relname,r.rolname,v.name) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(name) where n.nspname='public' and c.relname=any(${sqlArray([...watchedTables,'_work_unit_review_live_sources'])}) and r.rolname in('anon','authenticated','service_role')),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and k.contype<>'n' and c.relname=any(${sqlArray(watchedTables)})),
 'policies',(select jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname) from pg_policies where schemaname='public' and tablename=any(${sqlArray(watchedTables)})),
 'view',pg_get_viewdef('public._work_unit_review_live_sources'::regclass,true),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'owner',pg_get_userbyid(c.relowner)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(${sqlArray(watchedTables)}))
) value`;
const catalog=(await q(catalogQuery)).value;
// SQL canonical hash must be calculated by PostgreSQL, never JSON.stringify.
const expected=(await q(`select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') digest from (${catalogQuery}) c`)).digest;
const contract=`-- Generated exact source/column/trigger coverage; unknown source shape fails closed.
create or replace function public._work_totals_coverage() returns boolean
language sql stable security definer set search_path=public,pg_temp as $coverage$
 select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='${expected}' from (${catalogQuery}) c
$coverage$;
revoke all on function public._work_totals_coverage() from public,anon,authenticated,service_role;
`;
if(process.argv.includes('--build-coverage')){
 const updated=totals.replace(/-- TOTALS_COVERAGE_BEGIN[\s\S]*?-- TOTALS_COVERAGE_END/,`-- TOTALS_COVERAGE_BEGIN\n${contract}-- TOTALS_COVERAGE_END`);
 writeFileSync(new URL('supabase/migrations/20261108450000_work_activity_totals.sql',root),updated);
 await db.exec(contract);
 totals=updated;
 console.log('Built coverage',expected,'candidate',hash(updated));
}else assert.ok(totals.includes(contract),'Coverage source drift: explicitly regenerate and review exact changes');
assert.equal((await q('select _work_unit_review_coverage() and _work_totals_coverage() yes')).yes,true,'Both actual catalog coverage guards must match');


if(process.env.WORK_ACTIVITY_TOTALS_CATALOG_OUT)writeFileSync(process.env.WORK_ACTIVITY_TOTALS_CATALOG_OUT,JSON.stringify({totalsSha256:hash(totals),reviewSha256:hash(review),catalogSqlDigest:expected,catalogQuery,metadata:catalog,priorLookupIndexes},null,2)+'\n');
const id=n=>'00000000-0000-4000-8000-'+String(250000+n).padStart(12,'0');let seq=1000;
const as=async(who,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[who]);await db.exec('set role '+role)};
let checks=0;const check=(yes,label)=>{assert.ok(yes,label);checks++;console.log('PASS',checks,label)};
await db.exec('begin');
await db.query('insert into auth.users(id) values($1),($2),($3)',[id(1),id(2),id(3)]);
await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Totals worker','owner',false),($2,'Totals reviewer','owner',false),($3,'Totals other','installer',false)",[id(1),id(2),id(3)]);
await db.query("insert into projects(id,job_code,name) values($1,'TOTALS-A','Synthetic A'),($2,'TOTALS-B','Synthetic B')",[id(10),id(11)]);
await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'TOTALS-UNIT')",[id(20),id(10)]);
await as(id(1));
const unitCreation=await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb))::text serialized",[id(seq++),JSON.stringify({id:id(30),revision:0,project_id:id(10),opening_id:id(20),label:'Totals synthetic',type_label:'Window',facts:{},dimension_observation:{width:36,height:48,unit:'in',source:'estimated'},expected_fact_revision:0})]);
check(JSON.parse(unitCreation.serialized)===id(30),'UUID-returning unit creation uses actual SQL JSON serialization for genuine harness');
for(const [code,scope] of [['totals_general','general'],['totals_specific','specific']])await q("select work_publish_activity_version($1,$2,0,$3,$4,$4,$5::boolean,'[]')",[id(seq++),code,scope,code,scope==='general']);
await as(id(1),'postgres');
const defs=(await db.query("select d.code,d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code like 'totals_%' order by d.code")).rows;
await as(id(1));await q("select work_publish_menu_version($1,'totals_menu',0,'Totals','Totals',$2::jsonb)",[id(seq++),JSON.stringify(defs.map((d,i)=>({definitionId:d.definition_id,versionId:d.version_id,position:i,enabled:true})))]);
await as(id(1),'postgres');const menu=(await q("select v.id from work_capture_menus m join work_capture_menu_versions v on v.menu_id=m.id where m.code='totals_menu'")).id;
await as(id(1));await q('select work_select_job_menu($1,$2,$3,0)',[id(seq++),id(10),menu]);
await as(id(1),'postgres');const selection=await q('select id,revision from work_job_menu_selections where project_id=$1',[id(10)]);
await db.exec('select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1');
await db.query("insert into toolbox_completions(profile_id,signed_at,typed_name) values($1,clock_timestamp(),'Synthetic signature')",[id(1)]);
await as(id(1));
const shift=(await q("select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1)) value",[id(10),id(seq++)])).value;
const device=id(50),generation=id(51);let head=id(seq++),sequence=0;
let snap=(await q('select work_activity_snapshot($1) value',[device])).value;
const envelope={deviceId:device,clientGeneration:generation,clientSequence:0,predecessorCommandId:null,expectedRevision:snap.state.revision,basis:{observationId:snap.observation.id},shiftRef:snap.observation.shiftRef,tappedAt:new Date().toISOString(),clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}};
let result=(await q('select work_activity_command($1,1,$2::jsonb) value',[head,JSON.stringify(envelope)])).value;assert.equal(result.receipt.status,'noop');
async function act(intent,at=null){snap=(await q('select work_activity_snapshot($1) value',[device])).value;const cid=id(seq++),payload={...envelope,clientSequence:++sequence,predecessorCommandId:head,expectedRevision:snap.state.revision,basis:{observationId:snap.observation.id},shiftRef:snap.observation.shiftRef,intent,tappedAt:at??new Date().toISOString(),clockCheckedAt:new Date().toISOString(),clockSkewMs:0};const res=(await q('select work_activity_command($1,1,$2::jsonb) value',[cid,JSON.stringify(payload)])).value;assert.equal(res.receipt.status,'applied',JSON.stringify(res));head=cid;return res;}
const finished=await act({kind:'finish_setup',projectId:id(10),costCodeId:null},(await q("select to_char((clock_timestamp()-interval '30 seconds') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') stamp")).stamp);
const readTotals=async(unit=null)=>(await q('select work_activity_totals_read($1,$2) value',[id(10),unit])).value;
const intent=scope=>({kind:'switch',projectId:id(10),selectionId:selection.id,selectionRevision:selection.revision,menuVersionId:menu,definitionVersionId:defs.find(d=>d.code==='totals_'+scope).version_id,scope,unit:null,machineKind:scope==='general'?'forklift':null,values:{}});
await act(intent('general'),finished.receipt.effectiveAt);
let value=await readTotals();
check(value.availability==='available','Authorized totals read returns selected scope');
check(value.totals.activities.length===1&&BigInt(value.totals.scopeKnownMicros)>0n,'Actual server capture supplies positive General microseconds');
check(value.totals.activities[0].machineSubsets.length===1&&value.totals.activities[0].machineSubsets[0].machineKind==='forklift'&&value.totals.activities[0].machineSubsets[0].microseconds===value.totals.scopeKnownMicros,'Machine operator is a subset of one activity clock, never a second timer');
await as(id(1),'postgres');const commandBasis=(await q('select _work_activity_command_basis(_work_activity_unit_basis($1,$2)) value',[id(30),id(1)])).value;await as(id(1));
await act({...intent('specific'),unit:commandBasis});
value=await readTotals(id(30));
check(value.availability==='available'&&value.totals.activities.length===1,'Specific totals derive actual unit capture');
check(value.totals.reconciliation.unclassifiedMicros==='0','Atomic setup-to-work boundary leaves no invented gap');
const partition=value.totals.reconciliation;
check(BigInt(partition.grossMicros)===BigInt(partition.classifiedMicros)+BigInt(partition.setupMicros)+BigInt(partition.unclassifiedMicros)+BigInt(partition.breakElapsedMicros),'Exact microsecond gross partition');
check(value.totals.cohort.eligible===false&&value.totals.cohort.exclusions.includes('dimensions_unverified'),'Estimated unverified active unit never enters trusted cohort');
await as(id(2));const otherView=await readTotals(id(30));
check(otherView.totals.activities.length===0&&otherView.totals.complete===false,'Another person receives no guessed current elapsed interval');
await as(id(1),'postgres');await db.exec('savepoint resumed_capture');await as(id(1));
await q("select to_jsonb(start_break($1::uuid,'rest'::text)) value",[shift.id]);
let duringBreak=await readTotals(id(30));
check(duringBreak.totals.complete&&duringBreak.totals.activities[0].personal.includesLive===false,'Actual break stops the source timer without guessing paused elapsed');
await q('select to_jsonb(end_break($1::uuid)) value',[shift.id]);
let afterResume=await readTotals(id(30));

check(afterResume.totals.complete&&afterResume.totals.activities[0].personal.includesLive,'Actual break return authorizes a new resumed source through immutable ancestry');
check(!afterResume.totals.reconciliation.issues.includes('capture_lineage_unproven'),'Resumed metadata requires its original applied capture command');
await as(id(1),'postgres');await db.exec('rollback to savepoint resumed_capture');
await as(id(1));await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text)) value',[shift.id]);
value=await readTotals(id(30));check(value.totals.complete&&value.totals.activities[0].personal.includesLive===false,'Closed captured shift has exact accumulated unit total');
const fixedTotal=value.totals.scopeKnownMicros;const secondRead=await readTotals(id(30));check(secondRead.totals.scopeKnownMicros===fixedTotal,'Historical elapsed never grows at a later read');
await as(id(2));value=await readTotals(id(30));check(value.totals.scopeKnownMicros===fixedTotal&&value.totals.personalKnownMicros==='0','Scope labor includes closed worker time once while personal remains actual actor');
await as(id(2),'postgres');await db.query("update time_shifts set status='approved' where id=$1",[shift.id]);await as(id(2));
async function reviewCommand(action,data){const r=(await q('select work_unit_review_read($1) value',[id(30)])).value;return (await q('select work_unit_review_command($1,1,$2::jsonb) value',[id(seq++),JSON.stringify({action,basis:r.review.basis,data})])).value;}
await reviewCommand('verify_dimensions',{widthDecimal:'36',heightDecimal:'48',unit:'in',source:'measured',sourceReference:null});await reviewCommand('submit',{note:null});await reviewCommand('pass',{note:null});
value=await readTotals(id(30));
check(value.totals.cohort.eligible,'Approved reconciled labor with independently verified dimensions and current QC is eligible');
check(value.totals.cohort.eligibleUnitIds.length===1&&value.totals.cohort.laborNumeratorMicros===value.totals.scopeKnownMicros&&value.totals.cohort.areaSquareFeetNumerator==='1728'&&value.totals.cohort.areaSquareFeetDenominator==='144','Identical single-unit cohort supplies labor numerator and area counted once');
for(const [label,sql,args] of [
 ['hidden job','update projects set deleted_at=clock_timestamp() where id=$1',[id(10)]],
 ['purged unit','delete from custom_work_units where id=$1',[id(30)]]]){
 await as(id(2),'postgres');await db.exec('savepoint hidden_control');await db.query(sql,args);await as(id(2));const hidden=await readTotals(id(30));check(hidden.availability==='unavailable'&&hidden.totals===null,label+' returns no IDs or counts');await as(id(2),'postgres');await db.exec('rollback to savepoint hidden_control');
}
await as(id(2),'postgres');await db.exec('savepoint break_scalar');await db.query('update time_shifts set break_seconds=break_seconds+1 where id=$1',[shift.id]);await as(id(2));value=await readTotals(id(30));
check(value.totals.reconciliation.policyAdjustmentMicros==='-1000000'&&!value.totals.cohort.eligible,'Unplaced scalar break deduction is an explicit excluded adjustment, never spread across activity');
await as(id(2),'postgres');await db.exec('rollback to savepoint break_scalar');await db.exec('savepoint missing_capture');
await db.exec('alter table custom_work_sessions disable trigger zz_work_activity_row');await db.query("update custom_work_sessions set ended_at=ended_at-interval '1 microsecond' where unit_id=$1",[id(30)]);await db.exec('alter table custom_work_sessions enable trigger zz_work_activity_row');await as(id(2));value=await readTotals(id(30));
check(!value.totals.complete&&!value.totals.cohort.eligible,'Missing terminal capture makes totals partial and excludes cohort');
await as(id(2),'postgres');await db.exec('rollback to savepoint missing_capture');
// Reconciliation is private payroll/review evidence, separate from activity totals.
await as(id(2),'postgres');await db.exec('savepoint reconciliation_privacy');await as(id(3));
let installer=await readTotals(id(30));
check(installer.totals.scopeKnownMicros===fixedTotal&&installer.totals.activities.length===1,'Installer retains authorized coworker activity scope totals');
check(installer.totals.reconciliation.scope==='personal'&&installer.totals.reconciliation.ledgerCount===0&&installer.totals.reconciliation.grossMicros===null&&installer.totals.reconciliation.payrollMicros===null&&installer.totals.reconciliation.issues.length===0,'Installer receives only own empty reconciliation, not coworker payroll');
const installerGeneral=await readTotals();check(BigInt(installerGeneral.totals.scopeKnownMicros)>0n&&installerGeneral.totals.reconciliation.scope==='personal'&&installerGeneral.totals.reconciliation.ledgerCount===0,'General activity totals remain visible without coworker reconciliation');
await as(id(2),'postgres');await db.query("insert into opening_phases(id,opening_id,kind,status,started_by,started_at,submitted_at,minutes) values($1,$2,'flashing','submitted',$3,now()-interval '2 hours',now()-interval '1 hour',60)",[id(91),id(20),id(1)]);
const privacyRevision=(await q('select revision from personal_activity_state where profile_id=$1',[id(1)])).revision;
await db.query('update personal_activity_state set revision=9007199254740991 where profile_id=$1',[id(1)]);
await db.query("update opening_phases set submitted_at=submitted_at+interval '1 second' where id=$1",[id(91)]);
check((await q('select count(*)::int n from work_activity_safety_events where source_id=$1 and profile_id=$2',[id(91),id(1)])).n===1,'Actual phase mutation creates coworker safety evidence under the engine guard');
await db.query("update personal_activity_state set revision=$1,integrity_state='clean' where profile_id=$2",[privacyRevision,id(1)]);
await as(id(3));installer=await readTotals(id(30));
check(installer.totals.reconciliation.scope==='personal'&&installer.totals.reconciliation.ledgerCount===0&&installer.totals.reconciliation.breakDeductionMicros==='0'&&installer.totals.reconciliation.issues.length===0&&!installer.totals.reconciliation.unresolvedScope,'Coworker safety and payroll-review evidence does not leak through installer reconciliation');
const privateGeneral=(await readTotals()).totals.reconciliation;check(privateGeneral.scope==='personal'&&privateGeneral.ledgerCount===0&&privateGeneral.grossMicros===null&&privateGeneral.payrollMicros===null&&privateGeneral.breakDeductionMicros==='0'&&privateGeneral.issues.length===0&&!privateGeneral.unresolvedScope,'General reconciliation hides every coworker payroll and safety field');
await as(id(2),'postgres');await db.query("update profiles set role='installer' where id=$1",[id(1)]);await as(id(1));const ownReconciliation=(await readTotals(id(30))).totals.reconciliation;
check(ownReconciliation.scope==='personal'&&ownReconciliation.ledgerCount===1&&ownReconciliation.issues.includes('source_safety')&&BigInt(ownReconciliation.grossMicros)>0n,'Installer keeps their own payroll and safety reconciliation');
await as(id(2),'postgres');await db.query("update profiles set role='foreman' where id=$1",[id(3)]);await as(id(2));await q("select work_grant_job_capability($1,$2,$3,'final_qc')",[id(seq++),id(10),id(3)]);await as(id(3));let foreman=(await readTotals(id(30))).totals.reconciliation;
check(foreman.scope==='authorized_scope'&&foreman.ledgerCount===1&&foreman.issues.includes('source_safety')&&BigInt(foreman.grossMicros)>0n,'Currently granted foreman receives permitted aggregate reconciliation');
await as(id(2));await q('select to_jsonb(edit_shift($1,$2,null,null,null,null,$3)) value',[shift.id,id(11),'Synthetic privacy allocation']);await as(id(3));foreman=(await readTotals(id(30))).totals.reconciliation;
check(foreman.scope==='personal'&&foreman.ledgerCount===0&&foreman.issues.length===0,'Final-QC grant on selected job does not authorize another current/original payroll job');
await as(id(2));await q("select work_grant_job_capability($1,$2,$3,'final_qc')",[id(seq++),id(11),id(3)]);await as(id(3));foreman=(await readTotals(id(30))).totals.reconciliation;
check(foreman.scope==='authorized_scope'&&foreman.ledgerCount===1&&foreman.issues.includes('source_safety'),'Foreman needs all retained/current dependent job grants for aggregate reconciliation');
await as(id(2),'postgres');await db.exec('rollback to savepoint reconciliation_privacy');
async function control(label,mutate,accept){await as(id(2),'postgres');await db.exec('savepoint control');await mutate();await as(id(2));const v=await readTotals(id(30));if(!accept(v)) console.log("CONTROL",label,JSON.stringify(v));check(accept(v),label);await as(id(2),'postgres');await db.exec('rollback to savepoint control');}
await control('Removing a required column constraint refuses totals',()=>db.exec('alter table work_job_menu_selections alter column revision drop not null'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Unvalidated NOT NULL refuses even with attnotnull still true',async()=>{await db.exec('alter table work_job_menu_selections alter column revision drop not null; alter table work_job_menu_selections add constraint fixture_revision_not_null not null revision not valid');assert.equal((await q("select attnotnull from pg_attribute where attrelid='work_job_menu_selections'::regclass and attname='revision'")).attnotnull,true);},v=>v.availability==='unavailable'&&v.totals===null);
await control('NO INHERIT NOT NULL refuses despite matching nullability',()=>db.exec('alter table work_job_menu_selections alter column revision drop not null; alter table work_job_menu_selections add constraint fixture_revision_not_null not null revision no inherit'),v=>v.availability==='unavailable'&&v.totals===null);
await control('A differently named fully validated NOT NULL retains identical semantics',()=>db.exec('alter table work_job_menu_selections alter column revision drop not null; alter table work_job_menu_selections add constraint fixture_revision_not_null not null revision'),v=>v.availability==='available'&&v.totals.cohort.eligible);
await control('Removing CHECK constraint refuses totals',()=>db.exec('alter table work_job_menu_selections drop constraint work_job_menu_selections_revision_check'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Removing foreign key refuses totals',()=>db.exec('alter table work_job_menu_selections drop constraint work_job_menu_selections_menu_version_id_fkey'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Restoring raw service-role safety privileges refuses totals',()=>db.exec('grant all on table work_activity_safety_events to service_role'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Restored private source-helper service EXECUTE refuses totals',()=>db.exec('grant execute on function _work_activity_fact_snapshot(uuid) to service_role'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Restored employee snapshot service EXECUTE refuses totals',()=>db.exec('grant execute on function work_activity_snapshot(uuid) to service_role'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Private helper ACL drift refuses before returning IDs or counts',()=>db.exec('grant execute on function _work_totals_shift(uuid,uuid,timestamptz) to authenticated'),v=>v.availability==='unavailable'&&v.totals===null);
await control('Capture-writer source drift refuses without weakening legacy payroll',async()=>{const body=(await q("select pg_get_functiondef('_work_activity_resume(personal_activity_state,time_shifts,timestamp with time zone)'::regprocedure) body")).body;await db.exec(body.replace('AS $function$','AS $function$\n-- fixture drift'));},v=>v.availability==='unavailable');
await control('Reviewed source interval edits do not become trusted elapsed',()=>db.query("update custom_work_sessions set ended_at=ended_at-interval '1 microsecond' where unit_id=$1",[id(30)]),v=>!v.totals.complete&&!v.totals.cohort.eligible);
await control('Historical payroll review state remains excluded after approval',async()=>{await db.query("update time_shifts set status='needs_finish' where id=$1",[shift.id]);await db.query("update time_shifts set status='approved' where id=$1",[shift.id]);},v=>!v.totals.cohort.eligible);
await control('Reopened accepted QC excludes unit while recorded labor remains visible',async()=>{await as(id(2));await reviewCommand('reopen',{note:'Synthetic correction'});},v=>v.totals.scopeKnownMicros===fixedTotal&&!v.totals.cohort.eligible);
await control('Retired activity identity retains its historical version and label',()=>db.query("update work_activity_definitions set retired_at=clock_timestamp() where id=$1",[defs[1].definition_id]),v=>v.totals.activities[0].retired&&v.totals.activities[0].definitionVersionId===defs[1].version_id);
await control('Authenticated payroll reallocation retains reviewed-source exclusion',async()=>{await as(id(2));await q('select to_jsonb(edit_shift($1,$2,null,null,null,null,$3)) value',[shift.id,id(11),'Synthetic allocation correction']);},v=>!v.totals.complete&&v.totals.reconciliation.issues.includes('source_interval_changed'));
await control('Foreign current payroll allocation is checked before original-job totals',async()=>{await as(id(2));await q('select to_jsonb(edit_shift($1,$2,null,null,null,null,$3)) value',[shift.id,id(11),'Synthetic allocation correction']);await as(id(2),'postgres');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(11)]);},v=>v.availability==='unavailable'&&v.totals===null);
await control('An unrelated reviewed shift on this job cannot invalidate the selected unit',()=>db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status,break_seconds) values($1,$2,$3,now()-interval '4 hours',now()-interval '3 hours','needs_finish',0)",[id(82),id(3),id(10)]),v=>v.totals.complete&&v.totals.cohort.eligible&&v.totals.scopeKnownMicros===fixedTotal);
await control('Unbound legacy work remains explicitly unknown instead of zero',()=>db.query("insert into task_sessions(id,opening_id,project_id,profile_id,state,started_at,ended_at) values($1,$2,$3,$4,'on_task',now()-interval '2 hours',now()-interval '1 hour')",[id(81),id(20),id(10),id(1)]),v=>!v.totals.complete&&v.totals.reconciliation.unresolvedScope&&!v.totals.cohort.eligible);
await as(id(2),'postgres');
const fingerprintSql="select encode(sha256(convert_to(jsonb_build_object('shifts',(select jsonb_agg(to_jsonb(s) order by id) from time_shifts s),'sessions',(select jsonb_agg(to_jsonb(s) order by id) from custom_work_sessions s),'state',(select jsonb_agg(to_jsonb(s) order by profile_id) from personal_activity_state s),'transitions',(select jsonb_agg(to_jsonb(s) order by id) from personal_activity_transitions s),'commands',(select jsonb_agg(to_jsonb(s) order by command_id) from personal_activity_commands s))::text,'UTF8')),'hex') digest";
const beforeRead=(await q(fingerprintSql)).digest;await as(id(2));await readTotals(id(30));await as(id(2),'postgres');check(beforeRead===(await q(fingerprintSql)).digest,'Read changes no shift session state transition or command evidence');
await as(id(2),'postgres');
const privateAcl=(await q("select bool_and(not has_function_privilege(r,p.oid,'EXECUTE')) denied from pg_proc p cross join unnest(array['anon','authenticated','service_role']) r where p.pronamespace='public'::regnamespace and p.proname like '_work_totals_%'")).denied;
check(privateAcl,'All private totals helpers deny anon authenticated and service roles');
check((await q("select has_function_privilege('authenticated','work_activity_totals_read(uuid,uuid)','EXECUTE') and not has_function_privilege('anon','work_activity_totals_read(uuid,uuid)','EXECUTE') and not has_function_privilege('service_role','work_activity_totals_read(uuid,uuid)','EXECUTE') yes")).yes,'Only authenticated callers can enter the fresh-actor RPC');
check((await q("select bool_and(not has_function_privilege('service_role',f::regprocedure,'EXECUTE')) denied from unnest($1::text[]) f",[serviceDeniedFunctions])).denied,'All34 provider-default service endpoints remain denied; owner/authenticated closure asserted at installation');
for(const [label,sql,args] of [
 ['private unit fact','select _work_activity_fact_snapshot($1)',[id(30)]],
 ['private person sources','select * from _work_activity_live_sources($1)',[id(1)]],
 ['employee snapshot','select work_activity_snapshot($1)',[id(6666)]],
 ['employee command',"select work_activity_command(null::uuid,0,'{}'::jsonb)",[]],
 ['new paid clock',"select clock_in(null::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,null::uuid,null::timestamptz,null::timestamptz,null::integer,0)",[]]
]){
 await as(id(1),'postgres');await db.exec('savepoint denied_service');await as(id(1),'service_role');let error=null;
 try{await db.query(sql,args);}catch(e){error=e.code;}
 await db.exec('rollback to savepoint denied_service');check(error==='42501','Eligible uid cannot enter '+label+' as service_role');
}
if(process.env.WORK_ACTIVITY_TOTALS_WIRE_OUT)writeFileSync(process.env.WORK_ACTIVITY_TOTALS_WIRE_OUT,JSON.stringify({totalsSha256:hash(totals),reviewSha256:hash(review),calls:wire},null,2)+'\n');
await db.exec('rollback');await db.close();console.log(JSON.stringify({checks,totalsSha256:hash(totals),reviewSha256:hash(review),scope:'Source-matched sequential PGlite only'}));
