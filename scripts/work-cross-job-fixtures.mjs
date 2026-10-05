// Invoked only by the disposable verifier after exact old-source admission.
export async function run(db,q,assert,catalogSql){
 const labels=[],wire=[];let checks=0;const check=(v,s)=>{assert.ok(v,s);checks++;labels.push(s);console.log('PASS',checks,s)};
 const id=n=>'00000000-0000-4000-8000-'+String(470000+n).padStart(12,'0');let seq=1000;
 const as=async(who,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[who]);await db.exec('set role '+role)};
 await db.exec('set check_function_bodies=on');
 const defs=(await db.query("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and (starts_with(proname,'_work_cross_job_') or starts_with(proname,'work_cross_job_') or proname in('_work_activity_resume','_work_activity_shift_lifecycle','_work_activity_row_before','_work_activity_operation_exit','work_activity_command','_work_activity_claim_clock_setup'))")).rows;
 for(const d of defs)await db.exec(d.definition);
 check(defs.length>15,'All new and critical replaced function declarations compile with body checks enabled');
 await db.exec('begin');
 await db.query('insert into auth.users(id) values($1),($2)',[id(1),id(2)]);
 await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Cross-job worker','owner',false),($2,'Cross-job other','owner',false)",[id(1),id(2)]);
 await db.query("insert into projects(id,job_code,name) values($1,'CROSS-A','Synthetic A'),($2,'CROSS-B','Synthetic B')",[id(10),id(11)]);
 await as(id(1));
 for(const [code,scope] of [['cross_general','general'],['cross_specific','specific']])await q("select work_publish_activity_version($1,$2,0,$3,$4,$4,false,'[]')",[id(seq++),code,scope,code]);
 await as(id(1),'postgres');const definitions=(await db.query("select d.code,d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code like 'cross_%' order by d.code")).rows;
 await as(id(1));await q("select work_publish_menu_version($1,'cross_menu',0,'Cross','Cross',$2::jsonb)",[id(seq++),JSON.stringify(definitions.map((d,i)=>({definitionId:d.definition_id,versionId:d.version_id,position:i,enabled:true})))]);
 await as(id(1),'postgres');const menu=(await q("select v.id from work_capture_menus m join work_capture_menu_versions v on v.menu_id=m.id where m.code='cross_menu'")).id;
 for(const project of [id(10),id(11)]){await as(id(1));await q('select work_select_job_menu($1,$2,$3,0)',[id(seq++),project,menu]);}
 await as(id(1),'postgres');const selections=(await db.query('select project_id,id,revision from work_job_menu_selections where project_id=any($1)',[[id(10),id(11)]])).rows;
 await db.exec('select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1');
 await db.query("insert into toolbox_completions(profile_id,signed_at,typed_name) values($1,clock_timestamp(),'Synthetic signature')",[id(1)]);
 const times={};for(const [name,minutes] of Object.entries({clock:70,finish:65,a:60,b:40,late:45,normal:30,returned:20,out:10}))times[name]=(await q(`select _work_activity_iso(clock_timestamp()-interval '${minutes} minutes') value`)).value;
 await as(id(1));const disabled=(await q("select work_activity_command($1,2,'{}') value",[id(seq++)])).value;check(disabled.availability==='unavailable','Held v2 command refuses before activation');
 await as(id(1),'postgres');
 // Only this disposable database enables synthetic fixtures. Authored migration
 // contains literal false and terminal ROLLBACK, with no activation route.
 await db.exec('create or replace function _work_cross_job_enabled() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select true$$');
 await db.exec("create temporary table cross_job_paid_updates(shift_id uuid);create function pg_temp.cross_job_paid_audit() returns trigger language plpgsql security definer set search_path=pg_temp,public as $$begin insert into pg_temp.cross_job_paid_updates values(new.id);return new;end$$;create trigger zzz_cross_job_paid_audit after update on time_shifts for each row execute function pg_temp.cross_job_paid_audit();");
 await db.exec("create type cross_job_fixture_enum as enum('first','second');create domain cross_job_fixture_domain as integer check(value>0);create type cross_job_fixture_composite as(value integer);create sequence cross_job_fixture_sequence;create foreign data wrapper cross_job_fixture_fdw no handler no validator;create server cross_job_fixture_server foreign data wrapper cross_job_fixture_fdw;create foreign table cross_job_fixture_foreign(value integer) server cross_job_fixture_server;");
 const fixtureDigest=(await q(`select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') digest from (${catalogSql}) c`)).digest;
 // Explicit privileged test-construction bypass. Authored migration seeds only
 // the reviewed constant and exposes no update/configuration route.
 await db.exec('alter table work_cross_job_contract disable trigger work_cross_job_contract_immutable');
 await db.query('update work_cross_job_contract set expected_catalog_sha256=$1',[fixtureDigest]);
 await db.exec('alter table work_cross_job_contract enable trigger work_cross_job_contract_immutable');
 check((await q('select _work_cross_job_coverage() ok')).ok,'Synthetic activation still uses an exact source catalog, never a true coverage stub');
 let shift,head,sequence,device,generation;
 const start=async(anchor=id(10),version=2)=>{
  await as(id(1));shift=(await q('select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,clock_timestamp(),0,$4::int)) value',[anchor,id(seq++),times.clock,version])).value;
  device=id(seq++);generation=id(seq++);head=null;sequence=0;
  return shift;
 };
 const snapshot=async(version=2)=>(await q(`select ${version===2?'work_cross_job_snapshot':'work_activity_snapshot'}($1) value`,[device])).value;
 const act=async(intent,tap=times.a,expected='applied',version=2)=>{
  const snap=await snapshot(version);assert.ok(snap.state,JSON.stringify(snap));
  const payload={deviceId:device,clientGeneration:generation,clientSequence:sequence,predecessorCommandId:head,expectedRevision:snap.state.revision,basis:{observationId:snap.observation.id},shiftRef:snap.observation.shiftRef,tappedAt:tap,clockCheckedAt:new Date().toISOString(),clockSkewMs:0,intent};
  if(version===2)Object.assign(payload,{expectedAllocationId:snap.state.shift.allocationId,boundaryMode:'trusted_original_tap'});
  const commandId=id(seq++);const result=(await q('select work_activity_command($1,$2,$3::jsonb) value',[commandId,version,JSON.stringify(payload)])).value;
  wire.push({commandId,protocolVersion:version,payload,result});assert.equal(result.receipt?.status,expected,JSON.stringify(result));head=commandId;sequence++;
  return {commandId,payload,result};
 };
 const establish=()=>act({kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null},times.a,'noop');
 const intent=(project=id(10))=>{const s=selections.find(s=>s.project_id===project);return {kind:'switch',projectId:project,selectionId:s.id,selectionRevision:s.revision,menuVersionId:menu,definitionVersionId:definitions.find(d=>d.code==='cross_general').version_id,scope:'general',unit:null,machineKind:null,values:{}}};
 await as(id(1),'postgres');await db.exec('savepoint scenarios');
 async function setup(anchor){await start(anchor);await establish();const before=(await q('select to_jsonb(s) row from time_shifts s where id=$1',[shift.id])).row;
 await as(id(1),'postgres');const updatesBefore=(await q('select count(*)::int n from pg_temp.cross_job_paid_updates where shift_id=$1',[shift.id])).n;await as(id(1));
 await act({kind:'finish_setup',projectId:id(10),costCodeId:null},times.finish);
 await as(id(1),'postgres');assert.equal((await q('select count(*)::int n from pg_temp.cross_job_paid_updates where shift_id=$1',[shift.id])).n,updatesBefore,'No physical UPDATE including no-op setup');await as(id(1));
 const after=(await q('select to_jsonb(s) row from time_shifts s where id=$1',[shift.id])).row;assert.deepEqual(after,before);check(true,'V2 setup leaves entire physical paid row unchanged');
 await act(intent(),times.a);return before;}
 await setup(id(10));
 const physical=(await q('select to_jsonb(s) row from time_shifts s where id=$1',[shift.id])).row;
 await as(id(1),'postgres');const transferUpdates=(await q('select count(*)::int n from pg_temp.cross_job_paid_updates where shift_id=$1',[shift.id])).n;await as(id(1));
 const switchB=await act(intent(id(11)),times.b);
 await as(id(1),'postgres');assert.equal((await q('select count(*)::int n from pg_temp.cross_job_paid_updates where shift_id=$1',[shift.id])).n,transferUpdates,'No physical UPDATE including no-op handoff');await as(id(1));
 assert.deepEqual((await q('select to_jsonb(s) row from time_shifts s where id=$1',[shift.id])).row,physical);check(true,'Cross-job handoff leaves entire physical paid row byte-equivalent');
 const replay=(await q('select work_activity_command($1,2,$2::jsonb) value',[switchB.commandId,JSON.stringify(switchB.payload)])).value;assert.deepEqual(replay,switchB.result);check(true,'Same immutable command replay returns original receipt');
 await as(id(1),'postgres');const current=await q('select s.project_id,m.project_id metadata_project,b.project_id binding_project,t.protocol_version from personal_activity_state p join custom_work_sessions s on s.id=p.active_source_id join work_session_capture_metadata m on m.session_id=s.id join work_cross_job_bindings b on b.source_id=s.id join personal_activity_transitions t on t.id=p.last_transition_id where p.profile_id=$1',[id(1)]);
 check(current.project_id===id(11)&&current.metadata_project===id(11)&&current.binding_project===id(11)&&current.protocol_version===2,'B source, metadata, allocation binding and generation agree');
 await as(id(1));await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.normal]);
 await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned]);
 await as(id(1),'postgres');let state=await q('select active_source_id,choice_required from personal_activity_state where profile_id=$1',[id(1)]);
 check(state.active_source_id!==null&&!state.choice_required,'Normal B break-return actually resumes a source');
 check((await q('select project_id from custom_work_sessions where id=$1',[state.active_source_id])).project_id===id(11),'Normal B return stays B with physical A anchor');
 await as(id(1));await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text)) value',[shift.id]);
 await as(id(1),'postgres');check((await q('select bool_and(review_required=false) ok from custom_work_sessions where shift_id=$1',[shift.id])).ok,'Normal custom B clock-out after resume adds no source review');
 await as(id(1),'postgres');await db.exec('rollback to savepoint scenarios');
 await setup(null);await act(intent(id(11)),times.b);
 await as(id(1),'postgres');const beforeLate=(await q('select count(*)::int n from custom_work_sessions where profile_id=$1',[id(1)])).n;
 await as(id(1));const late=(await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.late])).value;
 const returned=(await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned])).value;
 await as(id(1),'postgres');state=await q('select active_source_id,choice_required,resume_token from personal_activity_state where profile_id=$1',[id(1)]);
 check(state.active_source_id===null&&state.choice_required&&state.resume_token===null,'Late-break return leaves no source or resume token and requires deliberate choice');
 check((await q('select count(*)::int n from custom_work_sessions where profile_id=$1',[id(1)])).n===beforeLate,'Late return creates neither B nor A/null replacement timer');
 const paid=(await q('select to_jsonb(s) row from time_shifts s where id=$1',[shift.id])).row;
 check(paid.review_reason===null&&paid.project_id===null,'Allocation dispute does not flag payroll or retag null physical anchor');
 const last=(await q('select _work_activity_iso(last_punch_at) stamp from time_shifts where id=$1',[shift.id])).stamp;check(last===times.returned,'Paid return retains trusted original timestamp');
 await as(id(1));const refreshed=await snapshot();check(refreshed.state.choiceRequired&&refreshed.state.activity===null,'Refreshed state never revives discarded B');

 await as(id(1),'postgres');await db.exec('rollback to savepoint scenarios');
 for(const kind of ['unit','task','service','phase']){
  await setup(id(10));await act(intent(id(11)),times.b);await act({kind:'stop'},times.b);
  await as(id(1),'postgres');
  const openingId=id(seq++),visitId=id(seq++);
  await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,$3)",[openingId,id(11),'CROSS-'+kind]);
  if(kind==='service')await db.query('insert into service_visits(id,project_id,created_by) values($1,$2,$3)',[visitId,id(11),id(1)]);
  const operation=(await q("select _work_activity_operation_enter('cross_job_fixture') id")).id;
  const data={opening_id:openingId,role:'install',visit_id:visitId,kind:kind==='phase'?'flashing':'idle',stage:'Repair',description:'Synthetic service'};
  const source=(await q("select _work_cross_job_source($1,s,h.allocation_id,$2,$3::jsonb,$4::timestamptz,'switch') id from time_shifts s join work_cross_job_heads h on h.shift_id=s.id where s.id=$5",[id(1),kind,JSON.stringify(data),times.b,shift.id])).id;
  await q('select _work_activity_operation_exit($1)',[operation]);
  check(!!source,kind+' direct v2 writer creates an allocation-bound source');
  await db.exec('savepoint source_born');
  await as(id(1));await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.normal]);
  await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned]);
  await as(id(1),'postgres');const resumed=await q('select active_source_kind,active_source_id,choice_required from personal_activity_state where profile_id=$1',[id(1)]);
  check(resumed.active_source_kind===kind&&!!resumed.active_source_id&&!resumed.choice_required,kind+' normal B paid return resumes actual same-kind source');
  check((await q('select count(*)::int n from work_cross_job_bindings where source_id=$1 and project_id=$2 and resumed_from_history_id is not null',[resumed.active_source_id,id(11)])).n===1,kind+' resumed binding preserves B and actual closure ancestry');
  await db.exec('rollback to savepoint source_born');
  await as(id(1));await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.late]);
  await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned]);
  await as(id(1),'postgres');const lateSource=await q('select active_source_id,choice_required,resume_token from personal_activity_state where profile_id=$1',[id(1)]);
  check(lateSource.active_source_id===null&&lateSource.choice_required&&lateSource.resume_token===null,kind+' future-start source never resumes after delayed break and paid return');
  check((await q('select count(*)::int n from work_cross_job_bindings where shift_id=$1 and source_kind=$2 and resumed_from_history_id is not null',[shift.id,kind])).n===0,kind+' delayed return creates zero replacement binding');
  await db.exec('rollback to savepoint scenarios');
 }

 // Callback-before-lifecycle clock-out boundaries, including future B and zero.
 const paidOut=async(tap)=>{await as(id(1));return (await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),tap])).value;};
 for(const kind of ['custom','service'])for(const scenario of ['normal','closed_before','closed_after','future_start','zero_edge']){
  await setup(id(10));await act(intent(id(11)),times.b);
  if(kind==='service'){
   await act({kind:'stop'},times.b);await as(id(1),'postgres');const visit=id(seq++);
   await db.query('insert into service_visits(id,project_id,created_by) values($1,$2,$3)',[visit,id(11),id(1)]);
   const op=(await q("select _work_activity_operation_enter('cross_job_fixture') id")).id;
   await q("select _work_cross_job_source($1,s,h.allocation_id,'service',$2::jsonb,$3::timestamptz,'switch') from time_shifts s join work_cross_job_heads h on h.shift_id=s.id where s.id=$4",[id(1),JSON.stringify({visit_id:visit,kind:'idle',stage:'Repair',description:'Synthetic clockout'}),times.b,shift.id]);
   await q('select _work_activity_operation_exit($1)',[op]);
  }
  await as(id(1),'postgres');const source=(await q('select active_source_id id from personal_activity_state where profile_id=$1',[id(1)])).id;
  const before=(await q('select to_jsonb(s) value from time_shifts s where id=$1',[shift.id])).value;
  const end=scenario==='closed_after'?times.returned:times.normal;
  if(scenario.startsWith('closed_')){
   if(kind==='custom'){await as(id(1));await act({kind:'stop'},end);}
   else{await as(id(1),'postgres');const op=(await q("select _work_activity_operation_enter('cross_job_fixture') id")).id;await q("select _work_activity_close_all($1,$2::timestamptz,'stop')",[id(1),end]);await q('select _work_activity_operation_exit($1)',[op]);}
  }
  const tap=scenario==='future_start'?times.late:scenario==='zero_edge'?times.b:scenario==='closed_after'?times.normal:times.out;
  const paid=await paidOut(tap);await as(id(1),'postgres');
  const row=await q(`select review_required,_work_activity_iso(started_at) started,_work_activity_iso(ended_at) ended from ${kind==='custom'?'custom_work_sessions':'service_time_sessions'} where id=$1`,[source]);
  check(row.review_required===(scenario==='closed_after'||scenario==='future_start'),kind+' '+scenario+' clock-out has exact source review disposition');
  if(scenario==='zero_edge')check(row.started===row.ended&&row.ended===tap,kind+' zero-edge closure retains equal original boundary');
  const paidBoundary=await q('select _work_activity_iso(clock_out_at) out,_work_activity_iso(last_punch_at) punch from time_shifts where id=$1',[shift.id]);
  check(paidBoundary.out===tap&&paidBoundary.punch===tap&&paid.project_id===before.project_id&&paid.clock_in_at===before.clock_in_at,kind+' '+scenario+' paid clock-out retains original tap and physical origin');
  await db.exec('rollback to savepoint scenarios');
 }

 await setup(id(10));await act(intent(id(11)),times.b);await as(id(1),'postgres');
 const activeForStatus=(await q('select active_source_id id from personal_activity_state where profile_id=$1',[id(1)])).id;
 await db.query("update time_shifts set status='approved',break_started_at=$1,break_type='rest' where id=$2",[times.normal,shift.id]);
 check((await q('select review_required=false ok from custom_work_sessions where id=$1',[activeForStatus])).ok,'Combined status and break-start edit preserves strict false review boolean');
 await db.exec('rollback to savepoint scenarios');
 await setup(id(10));await as(id(1),'postgres');
 const ambiguousShift=id(seq++);
 await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,status) values($1,$2,$3,$4,'open')",[ambiguousShift,id(1),id(10),times.clock]);
 await db.exec('savepoint ambiguous_birth');let ambiguousError;
 try{await q("select _work_cross_job_birth_guard('custom',null,$1::jsonb)",[JSON.stringify({id:id(seq++),profile_id:id(1),shift_id:shift.id,started_at:times.b,ended_at:null})]);}catch(e){ambiguousError=e;}
 await db.exec('rollback to savepoint ambiguous_birth');check(ambiguousError?.code==='23514','Mixed legacy/v2 multiple open paid shifts explicitly refuse source birth');
 await db.exec('rollback to savepoint scenarios');

 // Full attestation refusals must be exercised with v2 actually enabled.
 await setup(id(10));const latest=await act(intent(id(11)),times.b);await as(id(1),'postgres');
 const tableDefinition=(await q("select pg_get_functiondef('_work_cross_job_table(text)'::regprocedure) definition")).definition;
 const tableBody=(await q("select prosrc from pg_proc where oid='_work_cross_job_table(text)'::regprocedure")).prosrc;
 const corruptContract=sql=>'alter table work_cross_job_contract disable trigger work_cross_job_contract_immutable;'+sql+';alter table work_cross_job_contract enable trigger work_cross_job_contract_immutable';
 const guardMutations=[
  ['coverage_body',"create or replace function _work_cross_job_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select true$$"],
  ['coverage_metadata','alter function _work_cross_job_coverage() cost 101'],
  ['dependency_body',tableDefinition.replace(tableBody,tableBody+'\n-- Unreviewed source drift\n')],
  ['dependency_metadata','alter function _work_cross_job_table(text) leakproof'],
  ['dependency_acl','grant execute on function _work_cross_job_resume_basis(personal_activity_state,time_shifts,timestamptz) to authenticated'],
  ['enum_definition',"alter type cross_job_fixture_enum rename value 'second' to 'changed'"],
  ['domain_constraint','alter domain cross_job_fixture_domain add constraint cross_fixture_tighter check(value<100)'],
  ['composite_type','alter type cross_job_fixture_composite alter attribute value type bigint'],
  ['sequence_semantics','alter sequence cross_job_fixture_sequence increment by 7'],
  ['foreign_table_options',"alter foreign table cross_job_fixture_foreign options(add unreviewed 'changed')"],
  ['missing_contract',corruptContract('delete from work_cross_job_contract')],
  ['wrong_contract',corruptContract("update work_cross_job_contract set expected_catalog_sha256=repeat('0',64)")],
  ['extra_contract',"alter table work_cross_job_contract drop constraint work_cross_job_contract_proof_key_check;"+corruptContract("insert into work_cross_job_contract values('extra',repeat('0',64))")]
 ];
 for(const [name,sql] of guardMutations){
  await db.exec('savepoint guard_drift');await db.exec(sql);await as(id(1));
  check((await q('select work_activity_command($1,2,$2::jsonb) value',[latest.commandId,JSON.stringify(latest.payload)])).value.availability==='unavailable',name+' rejects public v2 command replay while enabled');
  check((await snapshot()).availability==='unavailable',name+' rejects public v2 snapshot while enabled');
  check((await q('select work_cross_job_receipt($1) value',[latest.commandId])).value.availability==='unavailable',name+' rejects public v2 receipt while enabled');
  await db.exec('savepoint rejected_start');let refused;
  try{await q('select clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,clock_timestamp(),0,2)',[id(10),id(seq++),times.clock]);}catch(e){refused=e;}
  await db.exec('rollback to savepoint rejected_start');check(refused?.code==='23514',name+' rejects public v2 physical start while enabled');
  await q("select start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)",[shift.id,id(seq++),times.normal]);
  await q('select end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)',[shift.id,id(seq++),times.returned]);
  await paidOut(times.out);await as(id(1),'postgres');
  check((await q('select _work_activity_iso(clock_out_at) stamp from time_shifts where id=$1',[shift.id])).stamp===times.out,name+' leaves paid break return and clock-out unblocked');
  await db.exec('rollback to savepoint guard_drift');
 }
 for(const sql of ["update work_cross_job_contract set expected_catalog_sha256=repeat('0',64)",'delete from work_cross_job_contract',"insert into work_cross_job_contract values('cross_job_kernel_2',repeat('0',64))",'truncate work_cross_job_contract']){
  await db.exec('savepoint immutable_contract');let failed;try{await db.exec(sql);}catch(e){failed=e;}await db.exec('rollback to savepoint immutable_contract');check(!!failed,'Immutable expected proof refuses '+sql.split(' ')[0]);
 }
 await db.exec('rollback to savepoint scenarios');

 // An inner save failure must not roll back deletion of an older resume tuple.
 await setup(null);await act(intent(id(11)),times.b);await as(id(1),'postgres');
 const activeBefore=(await q('select to_jsonb(s) value from personal_activity_state s where profile_id=$1',[id(1)])).value;
 await as(id(1));
 await q("select start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)",[shift.id,id(seq++),times.normal]);
 await as(id(1),'postgres');check((await q('select count(*)::int n from work_cross_job_resume where profile_id=$1',[id(1)])).n===1,'Stale-cache failure fixture begins with actual saved provenance');
 await db.exec("create or replace function _work_cross_job_history(p_kind text,p_id uuid) returns work_activity_source_history language plpgsql stable security definer set search_path=public,pg_temp as $$begin raise exception using errcode='23514',message='Synthetic failed save';end$$");
 check(!(await q('select _work_cross_job_save(jsonb_populate_record(null::personal_activity_state,$1::jsonb),$2,$3::timestamptz,$4) ok',[JSON.stringify(activeBefore),shift.id,times.normal,id(seq++)])).ok,'Injected inner save failure is contained');
 check((await q('select count(*)::int n from work_cross_job_resume where profile_id=$1',[id(1)])).n===0,'Failed save leaves no stale cached resume tuple');
 await as(id(1));await q('select end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)',[shift.id,id(seq++),times.returned]);await as(id(1),'postgres');
 check((await q('select active_source_id is null and resume_token is null and resume_source_kind is null and resume_source_id is null and resume_definition_version_id is null and resume_shift_id is null and resume_from_revision is null and resume_after_break_transition_id is null and resume_authority_revision is null and choice_required ok from personal_activity_state where profile_id=$1',[id(1)])).ok,'Paid return after failed save clears source and complete resume state');
 await db.exec('rollback to savepoint scenarios');

 // Specific follows the same B-aware writer and resumes on a null physical anchor.
 await setup(null);await as(id(1));
 const unitId=id(seq++);
 await q("select custom_work_command($1,'unit',$2::jsonb)",[id(seq++),JSON.stringify({id:unitId,revision:0,project_id:id(11),opening_id:null,label:'Cross-specific unit',type_label:'Window',facts:{},dimension_observation:{width:36,height:48,unit:'in',source:'estimated'},expected_fact_revision:0})]);
 await as(id(1),'postgres');const unitBasis=(await q('select _work_activity_command_basis(_work_activity_unit_basis($1,$2)) value',[unitId,id(1)])).value;
 await as(id(1));const specific={...intent(id(11)),scope:'specific',unit:unitBasis,definitionVersionId:definitions.find(d=>d.code==='cross_specific').version_id};
 await act(specific,times.b);
 await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.normal]);
 await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned]);
 await as(id(1),'postgres');const specificResume=await q('select s.unit_id,s.project_id,m.project_id metadata_project from personal_activity_state p join custom_work_sessions s on s.id=p.active_source_id join work_session_capture_metadata m on m.session_id=s.id where p.profile_id=$1',[id(1)]);
 check(specificResume.unit_id===unitId&&specificResume.project_id===id(11)&&specificResume.metadata_project===id(11),'Specific B resumes through same writer with physical null anchor');
 await db.exec('rollback to savepoint scenarios');
 // An existing source that changes and changes back has a new retained head.
 for(const control of ['source_aba','allocation_aba','missing_closure','forged_effective_start','wrong_break','expired_toolbox','permission_change','writer_failure']){
  await setup(null);await act(intent(id(11)),times.b);
  await as(id(1));await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.normal]);
  await as(id(1),'postgres');const saved=await q('select * from work_cross_job_resume where profile_id=$1',[id(1)]);assert.ok(saved.closure_history_id,control);
  const countBefore=(await q('select count(*)::int n from custom_work_sessions where profile_id=$1',[id(1)])).n;
  if(control==='source_aba'){
   await db.query("update custom_work_sessions set ended_at=ended_at-interval '1 microsecond' where id=$1",[saved.source_id]);
   await db.query("update custom_work_sessions set ended_at=ended_at+interval '1 microsecond' where id=$1",[saved.source_id]);
  }else if(control==='allocation_aba')await db.query('update work_cross_job_heads set allocation_id=(select predecessor_id from work_cross_job_allocations where id=$1) where shift_id=$2',[saved.allocation_id,shift.id]);
  else if(control==='missing_closure')await db.query('update work_cross_job_resume set closure_history_id=$1 where profile_id=$2',[id(seq++),id(1)]);
  else if(control==='forged_effective_start')await db.query("update work_cross_job_resume set effective_started_at=effective_started_at-interval '1 minute' where profile_id=$1",[id(1)]);
  else if(control==='wrong_break')await db.query("update work_cross_job_resume set break_started_at=break_started_at+interval '1 minute' where profile_id=$1",[id(1)]);
  else if(control==='expired_toolbox')await db.query("update toolbox_completions set signed_at=clock_timestamp()-interval '1 day' where profile_id=$1",[id(1)]);
  else if(control==='permission_change')await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(11)]);
  else if(control==='writer_failure'){
   await db.exec("create function pg_temp.cross_job_fixture_fail() returns trigger language plpgsql as $$begin raise exception using errcode='23514',message='Synthetic resumed writer failure';end$$;create trigger zzz_cross_job_fixture_fail after insert on custom_work_sessions for each row execute function pg_temp.cross_job_fixture_fail();");
  }
  await as(id(1));await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned]);
  await as(id(1),'postgres');const rejected=await q('select active_source_id,choice_required,resume_token from personal_activity_state where profile_id=$1',[id(1)]);
  check(rejected.active_source_id===null&&rejected.choice_required&&rejected.resume_token===null,control+' preserves paid return and refuses unsafe auto-resume');
  check((await q('select count(*)::int n from custom_work_sessions where profile_id=$1',[id(1)])).n===countBefore,control+' leaves no partial replacement source');
  check((await q('select count(*)::int n from work_cross_job_write_frames')).n===0,control+' leaves no partial source frame');
  await db.exec('rollback to savepoint scenarios');
 }
 // Setup break-return remains setup; there is still no selected job event.
 await start(null);await as(id(1));
 await q("select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value",[shift.id,id(seq++),times.normal]);
 await q('select to_jsonb(end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)) value',[shift.id,id(seq++),times.returned]);
 await as(id(1),'postgres');const setupResume=await q('select active_source_kind,active_source_id from personal_activity_state where profile_id=$1',[id(1)]);
 check(setupResume.active_source_kind==='setup'&&!!setupResume.active_source_id,'Setup break-return resumes setup without manufacturing a job');
 check((await q('select count(*)::int n from work_cross_job_allocations where shift_id=$1',[shift.id])).n===0,'Setup return creates no allocation event');

 await as(id(1),'postgres');await db.exec('rollback to savepoint scenarios');
 await setup(id(10));const queuedSnap=await snapshot();const firstId=id(seq++),secondId=id(seq++);
 const queuedBase={deviceId:device,clientGeneration:generation,clientSequence:sequence,predecessorCommandId:head,expectedRevision:queuedSnap.state.revision,basis:{observationId:queuedSnap.observation.id},shiftRef:queuedSnap.observation.shiftRef,tappedAt:times.b,clockCheckedAt:new Date().toISOString(),clockSkewMs:0,boundaryMode:'trusted_original_tap',expectedAllocationId:queuedSnap.state.shift.allocationId};
 const first=Object.freeze({...queuedBase,intent:intent(id(11))});
 const second=Object.freeze({...queuedBase,clientSequence:sequence+1,predecessorCommandId:firstId,expectedRevision:queuedSnap.state.revision+1,expectedAllocationId:firstId,intent:intent(id(10))});
 const originalIntents=JSON.stringify([first,second]);
 await as(id(1),'postgres');await db.exec('savepoint queued_original');await as(id(1));
 const early=(await q('select work_activity_command($1,2,$2::jsonb) value',[secondId,JSON.stringify(second)])).value;
 check(early.receipt.status==='conflict','Second queued intent arriving before predecessor is held with an immutable conflict receipt');
 const predecessorLater=(await q('select work_activity_command($1,2,$2::jsonb) value',[firstId,JSON.stringify(first)])).value;assert.equal(predecessorLater.receipt.status,'applied');
 const stillHeld=(await q('select work_activity_command($1,2,$2::jsonb) value',[secondId,JSON.stringify(second)])).value;
 assert.deepEqual(stillHeld,early);check(true,'A held descendant never auto-rebases or acquires a replacement tap after its predecessor applies');
 await as(id(1),'postgres');await db.exec('rollback to savepoint queued_original');await db.exec('savepoint wrong_typed_predecessor');await as(id(1));
 let wrongType;try{await q('select work_activity_command($1,2,$2::jsonb) value',[id(seq++),JSON.stringify({...first,expectedAllocationId:{kind:'command',id:first.predecessorCommandId}})]);}catch(e){wrongType=e;}
 assert.equal(wrongType?.code,'23514');await db.exec('rollback to savepoint wrong_typed_predecessor');await as(id(1),'postgres');check(true,'A command-reference object cannot masquerade as the typed allocation UUID field');await as(id(1));

 const one=(await q('select work_activity_command($1,2,$2::jsonb) value',[firstId,JSON.stringify(first)])).value;
 assert.equal(one.receipt.status,'applied',JSON.stringify(one));
 const two=(await q('select work_activity_command($1,2,$2::jsonb) value',[secondId,JSON.stringify(second)])).value;
 check(two.receipt.status==='applied'&&JSON.stringify([first,second])===originalIntents,'Two pre-frozen queued transfers apply serially without rebasing, including equal original taps');
 const changed=(await q('select work_activity_command($1,2,$2::jsonb) value',[firstId,JSON.stringify({...first,tappedAt:times.normal})])).value;
 check(changed.availability==='unavailable'&&changed.receipt===null,'Same command UUID with a changed original tap refuses without replacing its receipt');
 const same=(await q('select work_activity_command($1,2,$2::jsonb) value',[firstId,JSON.stringify(first)])).value;assert.deepEqual(same,one);check(true,'Original queued command replay remains byte-equivalent after a rejected payload reuse');

 await as(id(1),'postgres');const zero=await q('select a.effective_at=b.effective_at same_boundary,a.id=b.predecessor_id chained from work_cross_job_allocations a join work_cross_job_allocations b on b.id=$2 where a.id=$1',[firstId,secondId]);
 check(zero.same_boundary&&zero.chained,'Rapid transfer preserves ordered zero-length allocation audit');
 const census=(await q('select person_record_counts($1) value',[id(1)])).value;
 check(census['work_cross_job_shifts.profile_id']===1&&census['work_cross_job_allocations.profile_id']>=4,'Retained-person census includes physical allocation registration and immutable events');
 check((await q('select _work_totals_coverage() or _work_unit_review_coverage() or _work_unit_contributors_coverage() ok')).ok===false,'V1 report guards explicitly fence a v2-bearing database');

 await as(id(2));const foreign=(await q('select work_cross_job_receipt($1) value',[firstId])).value;
 check(foreign.availability==='unavailable'&&foreign.receipt===null&&foreign.allocation===null,'Foreign command receipt discloses no allocation or identity');
 await as(id(1),'postgres');await db.exec('savepoint retained_purge');
 const retainedCount=(await q('select count(*)::int n from work_cross_job_allocations where shift_id=$1',[shift.id])).n;
 await db.query('delete from time_shifts where id=$1',[shift.id]);
 check((await q('select count(*)::int n from work_cross_job_allocations where shift_id=$1',[shift.id])).n===retainedCount,'Operational shift purge preserves immutable allocation evidence');
 await as(id(1));const purged=(await q('select work_cross_job_receipt($1) value',[firstId])).value;
 check(purged.availability==='unavailable'&&purged.receipt===null,'Purged source cannot regain ordinary receipt visibility');
 await as(id(1),'postgres');await db.exec('rollback to savepoint retained_purge');
 for(const sql of ['update work_cross_job_allocations set profile_id=$1','update work_cross_job_bindings set profile_id=$1','update work_cross_job_shifts set profile_id=$1']){
  await db.exec('savepoint immutable_merge');let error;try{await db.query(sql,[id(2)]);}catch(e){error=e;}
  check(!!error,'Generic person merge cannot rewrite retained '+sql.split(' ')[1]);await db.exec('rollback to savepoint immutable_merge');
 }
 await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(11)]);await as(id(1));
 const hidden=(await q('select work_cross_job_receipt($1) value',[secondId])).value;
 check(hidden.availability==='unavailable'&&hidden.receipt===null&&hidden.allocation===null,'Hidden original B dependency conceals later A receipt');
 await as(id(1),'postgres');await db.exec('rollback');
 return {checks,labels,wire,scope:'held functional construction',remaining:['all-six public entry and expanded domain-negative closure','genuine roles/races/volume','reader/export/cached-client fences','all42 acceptance closure']};
}
