// Disposable source-based checks for the cutover under construction.
// A prefix-only mode is explicitly development evidence, never closure proof.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where,detail:e.detail,sql:e.fixtureSql},null,2));process.exit(1);});
const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('supabase/migrations/20261108410000_work_activity_engine_cutover.sql',root),'utf8');
const directory=mkdtempSync(join(tmpdir(),'forge-activity-cutover-'));
let schema;
try {
 const path=join(directory,'schema.sql');
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./verify-work-activity-engine-substrate-reveal.mjs',import.meta.url))],{env:{...process.env,WORK_ACTIVITY_SCHEMA_OUT:path},encoding:'utf8',timeout:120000});
 assert.equal(r.status,0,r.stderr);schema=readFileSync(path,'utf8');
} finally {rmSync(directory,{recursive:true,force:true});}
const {PGlite}=await import(process.env.PGLITE_MODULE??'@electric-sql/pglite');
const db=new PGlite();
const query=db.query.bind(db);db.query=async(sql,...args)=>{try{return await query(sql,...args);}catch(error){error.fixtureSql=sql;throw error;}};
const executedSchema=[];const execute=db.exec.bind(db);
db.exec=async(sql,...args)=>{const result=await execute(sql,...args);if(sql.trim().toLowerCase()!=='rollback')executedSchema.push(sql);return result;};
await db.exec(schema);
const clockSource=readFileSync(new URL('supabase/migrations/20261028000000_clock_integrity.sql',root),'utf8');
const clockType=clockSource.match(/create type public\.clock_time_pick as \([^;]+;/i);assert.ok(clockType);await db.exec(clockType[0]);

// The substrate deliberately did not install the service system. For these
// private lifecycle checks use its actual three source CREATE TABLE bodies;
// only unrelated referenced identity tables are reduced fixture stubs.
await db.exec(`create table windows(id uuid primary key);create table service_cases(id uuid primary key);create table project_messages(id uuid primary key);
 alter table task_sessions add column project_id uuid,add column state text default 'on_task';
 alter table opening_phases add column opening_id uuid,add column started_at timestamptz default now(),add column kind text default 'flashing',add column paused_seconds int default 0,add column submitted_at timestamptz;
 alter table time_shifts add column cost_code_id uuid,add column break_type text,add column last_punch_at timestamptz,add column client_id uuid,add column review_reason text,
 add column clock_in_photo text,add column clock_in_lat double precision,add column clock_in_lng double precision,
 add column clock_out_photo text,add column clock_out_lat double precision,add column clock_out_lng double precision,
 add column note text,add column job_mode text,add column injured boolean,add column injury_note text,add column time_confirmed boolean,
 add column signed_at timestamptz,add column closed_reason text,add column edited_note text,
 add column approved_by uuid,add column approved_at timestamptz,add column rejected_by uuid,add column rejected_at timestamptz,add column reject_reason text;
 alter table time_shifts alter column id set default gen_random_uuid(),alter column clock_in_at set default now(),alter column status set default 'open';
 alter table unit_sessions add column block_issue_id uuid;
 alter table project_openings add column status text default 'pending';
 create table cost_codes(id uuid primary key);
 create table toolbox_completions(id uuid primary key default gen_random_uuid(),profile_id uuid,signed_at timestamptz);
 create table company_settings(id int primary key,paid_time_from_start_day_on date);`);
const serviceSource=readFileSync(new URL('supabase/migrations/20261017000000_servicing_visits.sql',root),'utf8');
for(const table of ['service_visits','service_visit_units','service_time_sessions']){
 const match=serviceSource.match(new RegExp('create table public\\.'+table+' \\([\\s\\S]*?\\n\\);'));
 assert.ok(match,'Actual source table '+table);await db.exec(match[0]);
}

const gateSource=readFileSync(new URL('supabase/migrations/20261031000000_new_front_door.sql',root),'utf8');
for(const name of ['_toolbox_signed_today','_toolbox_gate_open','_unit_work_gate','_prep_time_gate']){
 const found=gateSource.match(new RegExp('create or replace function public\\.'+name+'\\([\\s\\S]*?\\n\\$\\$;','i'));
 assert.ok(found,'Actual toolbox gate '+name);await db.exec(found[0]);
}
const loadFunctions=async(file,names)=>{
 const text=readFileSync(new URL('supabase/migrations/'+file,root),'utf8');
 const pattern=/^create (?:or replace )?function (?:public\.)?([a-z_][a-z0-9_]*)\([\s\S]*?\bas\s+(\$[a-z0-9_]*\$)/gim;
 for(const m of text.matchAll(pattern)){
  if(!names.includes(m[1]))continue;
  const end=text.indexOf(m[2],m.index+m[0].length);assert.ok(end>=0);
  await db.exec(text.slice(m.index,end+m[2].length)+';');
 }
};
await loadFunctions('20261028000000_clock_integrity.sql',['clock_in','clock_out','start_break','end_break','_clock_review_sentence','_flag_shift_for_review']);
await loadFunctions('20261031000000_new_front_door.sql',['clock_in']);
await loadFunctions('20260945000000_time_autoclose_reason.sql',['_close_dangling_shift']);
await loadFunctions('20260820000000_unit_sessions.sql',['_end_open_session','_close_stale_sessions']);
await loadFunctions('20261012000000_timecard_descriptions_and_weekly_approval.sql',['guard_timecard_role_boundary']);
const editTable=readFileSync(new URL('supabase/migrations/20260810000000_team_timecards.sql',root),'utf8').match(/create table if not exists time_shift_edits \([\s\S]*?\n\);/i);
assert.ok(editTable);await db.exec(editTable[0]);

let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const refuse=async(sql,args=[],code='23514')=>{let error;try{await db.query(sql,args);}catch(e){error=e;}assert.ok(error,'Unexpected success: '+sql);assert.equal(error.code,code,error.message);checks++;};
let self=false;try{await refuse('select 1');}catch{self=true;}check(self,'Negative check refuses unexpected success');
const assembly=source.includes('-- ASSEMBLY_GUARD:');
if(assembly){
 let error;try{await db.exec(source);}catch(e){error=e;}
 check(error?.message==='Activity cutover assembly is incomplete; installation is refused.','Incomplete migration fails closed: '+error?.message);
 await db.exec('rollback');
 check((await one("select to_regprocedure('public._work_activity_object(jsonb,text[])') is null absent")).absent,'Failed installation leaves no prefix objects');
 assert.ok(process.argv.includes('--development-prefix'),'Cutover is incomplete; only explicit --development-prefix can inspect private helpers');
 await db.exec('begin;'+source.split('-- DEVELOPMENT_PRIVATE_PREFIX:')[1].split('-- INSTALLED_ENTRY_ASSEMBLY:')[0]+'commit;');
}else{await db.exec(source);}
// Execute precisely the generated installed-definition replacement loop for
// the actual source routines in this fixture. The other installed roots and
// their complete schema/ACL guard remain a separate real-schema acceptance.
const entrySection=source.split('-- INSTALLED_ENTRY_ASSEMBLY:')[1];
const recordPattern=/\('((?:[^']|'')+)'::text,\$(activity_body_\d+)\$([\s\S]*?)\$\2\$::text,(true|false),'([a-f0-9]{64})'::text,'([a-f0-9]{64})'::text,'([a-z_][a-z0-9_]*)'::text,'((?:[^']|'')*)'::text\)/g;
const allEntries=[...entrySection.matchAll(recordPattern)].map(m=>({identity:m[1].replaceAll("''","'"),body:m[3],convertInvokerPayroll:m[4]==='true',expectedBodySha256:m[5],newBodySha256:m[6],name:m[7],arguments:m[8].replaceAll("''","'"),sql:m[0]}));
assert.equal(allEntries.length,212,'Every readable installed entry is parsed');
const exercised=[];
for(const entry of allEntries){
 const exists=await one('select p.prosrc body from pg_proc p where p.pronamespace=\'public\'::regnamespace and p.proname=$1 and pg_get_function_identity_arguments(p.oid)=$2',[entry.name,entry.arguments]);
 if(!exists)continue; // Missing domains remain explicitly outside this fixture.
 assert.equal(createHash('sha256').update(exists.body).digest('hex'),entry.expectedBodySha256,'Fixture matches exact installed source body '+entry.identity);
 exercised.push(entry);
}
await db.exec('-- INSTALLED_ENTRY_ASSEMBLY:'+entrySection.slice(0,entrySection.indexOf('$activity_entries$;')+'$activity_entries$;'.length).replace(/-- ENTRY_VALUES_BEGIN[\s\S]*?-- ENTRY_VALUES_END/,()=>'-- ENTRY_VALUES_BEGIN\n'+exercised.map(e=>e.sql).join(',\n')+'\n-- ENTRY_VALUES_END'));
check(exercised.length===29,'All 29 present actual-source entry routines install the generated seam; 183 domains remain absent');
// The reduced historical fixture disables body checks for unavailable domains.
// Explicitly compile every authored PL/pgSQL cutover body now its declarations
// exist; do not mistake creating an unchecked function for syntax validation.
const authoredNames=[...source.split('-- DEVELOPMENT_PRIVATE_PREFIX:')[1].split('-- INSTALLED_ENTRY_ASSEMBLY:')[0].matchAll(/create (?:or replace )?function public\.([a-z_][a-z0-9_]*)\(/g)].map(m=>m[1]);
const definitions=(await db.query("select pg_get_functiondef(p.oid) definition from pg_proc p join pg_language l on l.oid=p.prolang where p.pronamespace='public'::regnamespace and p.proname=any($1) and l.lanname='plpgsql' order by p.oid",[authoredNames])).rows;
await db.exec('set check_function_bodies=on');
for(const row of definitions)await db.exec(row.definition);
await db.exec('set check_function_bodies=off');
check(definitions.length>40,'All authored PL/pgSQL cutover declarations compile with body checks enabled');

for(const v of [null,[],{a:1,b:2}])await refuse('select _work_activity_object($1,ARRAY[\'a\'])',[v]);
await db.query('select _work_activity_object($1,ARRAY[\'a\'])',[{a:null}]);checks++;
for(const v of [null,1,'not-a-uuid','00000000-0000-4000-8000-000000000001x'])await refuse('select _work_activity_uuid($1)',[JSON.stringify(v)]);
check((await one('select _work_activity_uuid($1) v',[JSON.stringify('ABCDEF00-0000-0000-0000-000000000001')])).v==='abcdef00-0000-0000-0000-000000000001','UUID normalization does not impose invented version bits');
for(const v of [null,'1',-1,0.5,9007199254740992])await refuse('select _work_activity_integer($1)',[JSON.stringify(v)]);
check(Number((await one("select _work_activity_integer('9007199254740991') v")).v)===9007199254740991,'Maximum safe revision accepted');
for(const v of ['infinity','2026-01-01','2026-13-01T00:00:00Z','0000-01-01T00:00:00Z','2026-01-01T00:00:00.1234567Z'])await refuse('select _work_activity_instant($1)',[JSON.stringify(v)]);
check((await one('select _work_activity_iso(_work_activity_instant($1)) v',[JSON.stringify('2026-10-04T01:02:03.45-06:00')])).v==='2026-10-04T07:02:03.450000Z','Timestamp offset canonicalizes exactly');
const base={label_en:'Synthetic field',label_es:'Campo sintetico',required:true};
const fields=[{...base,id:'text',type:'text'},{...base,id:'count',type:'number',unit:'count',min:0,max:10},{...base,id:'truth',type:'boolean'},{...base,id:'one',type:'single_select',options:[{id:'a',label_en:'A',label_es:'A'}]},{...base,id:'many',type:'multi_select',options:[{id:'a',label_en:'A',label_es:'A'},{id:'b',label_en:'B',label_es:'B'}]}];
const valid={text:' 😀 ',count:0,truth:false,one:'a',many:['b','a']};
assert.deepEqual((await one('select _work_activity_answers($1,$2) v',[fields,valid])).v,valid);checks++;
for(const patch of [{text:null},{text:'\u00a0\ufeff\u2000'},{text:'😀'.repeat(501)},{count:'1'},{count:-1},{count:1.1},{count:11},{truth:'false'},{truth:null},{one:'label A'},{many:[]},{many:['a','a']},{many:['foreign']},{many:[false]},{unknown:'x'}])await refuse('select _work_activity_answers($1,$2)',[fields,{...valid,...patch}]);
const missing={...valid};delete missing.truth;await refuse('select _work_activity_answers($1,$2)',[fields,missing]);
check((await one('select _work_activity_answers($1,$2) v',[fields,{...valid,text:'😀'.repeat(500)}])).v.text.length===1000,'500 Unicode codepoints remain lossless');
const numeric=[{...base,id:'n',type:'number'}];
await refuse('select _work_activity_answers($1,$2::jsonb)',[numeric,'{"n":1e309}']);
await refuse('select _work_activity_answers($1,$2::jsonb)',[fields,'{"text":"\\u0000"}'],'22P05');
await refuse('select _work_activity_answers($1,$2::jsonb)',[fields,'{"text":"\\ud800"}'],'22P02');
// Use the exact explicit trigger statements authored in the migration. The
// isolated fixture only has a subset of the complete installed table graph.
const triggerStatements=source.split('-- INSTALLED_TRIGGER_ASSEMBLY:')[1].split('\n').filter(x=>x.startsWith('create trigger '));
let triggerCount=0;
for(const statement of triggerStatements){
 const table=statement.match(/ on public\.([a-z_]+)/i)?.[1];assert.ok(table);
 if((await one('select to_regclass($1) present',['public.'+table])).present){await db.exec(statement);triggerCount++;}
}
check(triggerCount>30,'Actual migration trigger statements installed on the available fixture graph');
// Existing review callbacks retain their original trigger names/order.
if(!(await one("select exists(select 1 from pg_trigger where tgrelid='time_shifts'::regclass and tgname='service_shift') present")).present) await db.exec('create trigger service_shift after update on time_shifts for each row execute function service_follow_shift();');
// Exact installed direct-timing policies and grants for the two retained
// REST write paths. These use the real partner helper and original timecard
// boundary trigger; this fixture does not substitute a permissive predicate.
await db.exec(`alter table time_shifts enable row level security;alter table task_sessions enable row level security;
 grant select,insert,update,delete on time_shifts,task_sessions to authenticated;
 create policy "cutover fixture installed timing access" on time_shifts for all to authenticated using ((not is_partner_user()) and true) with check ((not is_partner_user()) and true);
 create policy "cutover fixture installed task access" on task_sessions for all to authenticated using ((not is_partner_user()) and true) with check ((not is_partner_user()) and true);`);
if(process.env.WORK_ACTIVITY_CUTOVER_SCHEMA_OUT){
 const serialized=executedSchema.join('\n;\n')+'\n;\n';
 await db.close();
 // db.exec accepts a complete final statement without a semicolon, including
 // pg_get_functiondef output. Separately executed chunks need real separators
 // when exported as one psql/import script. Round-trip the exact artifact in a
 // second fresh database before handing it to the real-backend harness.
 const roundTrip=new PGlite();
 try {await roundTrip.exec(serialized);} finally {await roundTrip.close();}
 writeFileSync(process.env.WORK_ACTIVITY_CUTOVER_SCHEMA_OUT,serialized);
 console.log('Exported and round-trip imported disposable development cutover fixture before synthetic profiles or source rows. This is not the complete installed schema.');process.exit(0);
}
const privateAuthorityGuard=source.match(/do \$activity_private_authority\$[\s\S]*?\$activity_private_authority\$;/)?.[0];assert.ok(privateAuthorityGuard);
await db.exec('grant select(profile_id) on personal_activity_state to authenticated');
await refuse(privateAuthorityGuard);
await db.exec('revoke select(profile_id) on personal_activity_state from authenticated');
await db.exec('alter table work_configuration_commands disable row level security');
await refuse(privateAuthorityGuard);
await db.exec('alter table work_configuration_commands enable row level security');
await db.exec(privateAuthorityGuard);checks++;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),crew=id(2),qa=id(3),job=id(10),hidden=id(11),unit=id(20),request=id(21);
await db.query("insert into profiles(id,role,is_test) values($1,'owner',false),($2,'installer',false),($3,'foreman',true)",[owner,crew,qa]);
await db.query('insert into projects(id,is_test) values($1,false),($2,true)',[job,hidden]);
const as=async(uid,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);await db.exec('set role '+role);};
await as(owner);
await db.query('select custom_work_command($1,\'unit\',$2)',[request,{id:unit,revision:0,project_id:job,label:'Synthetic fact unit',facts:{},dimension_observation:{width:1,height:2,unit:'ft',source:'estimated'},expected_fact_revision:0}]);
await refuse('select _work_activity_unit_basis($1,$2)',[unit,owner],'42501');
await db.exec('reset role');
const basis=(await one('select _work_activity_unit_basis($1,$2) v',[unit,owner])).v;
check(basis?.eligibleForCapture===true&&basis.fact.dimensions.widthIn===12&&basis.fact.estimated===true,'Actual canonical observation supplies current normalized basis without asserting verification');
check(basis.fact.dimensions.original.width===1&&basis.fact.dimensions.original.unit==='ft','Original provenance remains attached');
await as(crew,'postgres');check((await one('select _work_activity_unit_basis($1,$2) v',[unit,owner])).v===null,'Forged actor parameter cannot widen projection');
await as(qa,'postgres');check((await one('select _work_activity_unit_basis($1,$2) v',[unit,qa])).v===null,'QA cannot read real-job basis');
await as(owner,'postgres');await db.query('update profiles set access_revoked_at=clock_timestamp() where id=$1',[owner]);
check((await one('select _work_activity_unit_basis($1,$2) v',[unit,owner])).v===null,'Revoked actor receives no fact identity');
await db.query('update profiles set access_revoked_at=null where id=$1',[owner]);
await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[job]);
check((await one('select _work_activity_unit_basis($1,$2) v',[unit,owner])).v===null,'Deleted source receives no fact identity');

// Exercise the installed callback subset using synthetic source rows.
// The reduced fixture does not prove the complete installed route graph.
await db.query('update projects set deleted_at=null where id=$1',[job]);
const shift=id(30),oldSession=id(31),nextSession=id(32);
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,status,break_seconds) values($1,$2,$3,'2026-10-04T12:00:00Z','open',1800)",[shift,owner,job]);
await db.query("insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,shift_status) values($1,$2,$3,$4,'idle',$5,'2026-10-04T12:00:00Z','open')",[oldSession,owner,shift,job,'😀'.repeat(4000)]);
const transitionsBeforeClose=(await one('select count(*)::int n from personal_activity_transitions where profile_id=$1',[owner])).n;
await db.exec('begin');
const op=(await one("select _work_activity_operation_enter('fixture_close') id")).id;
await db.query("select _work_activity_close_all($1,'2026-10-04T13:00:00Z','stop')",[owner]);
await db.query('select _work_activity_operation_exit($1)',[op]);
await db.exec('commit');
const closed=await one('select ended_at,description,revision from custom_work_sessions where id=$1',[oldSession]);
check(closed.ended_at?.toISOString()==='2026-10-04T13:00:00.000Z'&&closed.description==='😀'.repeat(4000)&&closed.revision===2,'Large legal legacy notes survive exact bounded closure');
check((await one('select count(*)::int n from personal_activity_transitions where profile_id=$1',[owner])).n===transitionsBeforeClose+1,'One completed operation has exactly one personal transition');
check((await one('select count(*)::int n from work_activity_operations')).n===0&&(await one('select count(*)::int n from work_activity_expected_mutations')).n===0,'Operation and exact allowances are empty after commit');
check((await one("select after_evidence#>>'{state,revision}' revision from personal_activity_transitions where profile_id=$1 order by revision_after desc limit 1",[owner])).revision===String(transitionsBeforeClose+1),'Transition state evidence carries the resulting revision');
await as(owner);
await refuse("select _work_activity_operation_enter('forged')",[],'42501');
await refuse('select * from work_activity_operations',[],'42501');
await db.exec('reset role');
await db.exec('begin');await db.query("select _work_activity_operation_enter('unfinished')");
await refuse('commit');await db.exec('rollback');
check((await one('select count(*)::int n from work_activity_operations')).n===0,'Deferred guard rolls back an unfinished operation');

await as(owner);
for(const isolation of ['repeatable read','serializable']){
 await db.exec('begin isolation level '+isolation);
 await refuse('select public.work_activity_snapshot($1)',[id(50)],'25001');
 await db.exec('rollback');
}
await as(crew);
for(const query of ['select _close_dangling_shift($1)','select _end_open_session($1,\'stop\',null,null)','select _close_stale_sessions($1)']) await refuse(query,[owner],'42501');
await as(owner);
const publicBasis=(await one('select work_activity_unit_basis($1) v',[unit])).v;
check(publicBasis.availability==='available'&&publicBasis.unit.id===unit&&publicBasis.protocolVersion===1,'Exact public basis envelope uses actual source authority');
const absentReceipt=(await one('select work_activity_command_receipt($1) v',[id(9999)])).v;
assert.deepEqual(absentReceipt,{protocolVersion:1,availability:'unavailable',receipt:null});checks++;
const snapshot=(await one('select work_activity_snapshot($1) v',[id(50)])).v;
check(snapshot.capability.mode==='closing_only'&&snapshot.capability.reasonCode==='starts_disabled','Default coordinator starts remain disabled');
check(Object.values(snapshot.state.actions).every(v=>typeof v==='boolean'),'Snapshot action fields are Boolean even without an active source');
await as(qa);
check((await one('select work_activity_unit_basis($1) v',[unit])).v.availability==='unavailable','Public basis redacts every real-source identity from QA');
await as(owner,'postgres');
// Central callback runs in the same source statement, after its row evidence
// and before statement completion. These direct-source cases supplement the
// seventeen actual transformed legacy/canonical routines installed above.

await db.query('insert into toolbox_completions(profile_id,signed_at) values($1,clock_timestamp())',[owner]);
const breaksShift=id(101),breaksPerson=id(100),breaksSource=id(102);
await db.query("insert into profiles(id,role,is_test) values($1,'owner',false)",[breaksPerson]);
await as(breaksPerson,'postgres');
await db.query('insert into toolbox_completions(profile_id,signed_at) values($1,clock_timestamp())',[breaksPerson]);
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,status,break_seconds) values($1,$2,$3,clock_timestamp()-interval '70 minutes','open',300)",[breaksShift,breaksPerson,job]);
await db.query("insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,shift_status) values($1,$2,$3,$4,'idle','Legacy General remains available',clock_timestamp()-interval '60 minutes','open')",[breaksSource,breaksPerson,breaksShift,job]);
await db.exec('begin');const breakRoot=(await one("select _work_activity_operation_enter('start_break') id")).id;
await db.query("update time_shifts set break_started_at=clock_timestamp()-interval '10 minutes',last_punch_at=clock_timestamp()-interval '10 minutes',break_type='rest' where id=$1",[breaksShift]);
await db.query('select _work_activity_operation_exit($1)',[breakRoot]);await db.exec('commit');
const paused=await one('select * from personal_activity_state where profile_id=$1',[breaksPerson]);
check(paused.active_source_id===null&&paused.resume_source_id===breaksSource&&paused.resume_after_break_transition_id===paused.last_transition_id,'Break saves exactly the clean pre-break source and resulting transition');
check((await one('select end_reason from custom_work_sessions where id=$1',[breaksSource])).end_reason==='break','Break closes the actual source with its break disposition');
await db.exec('begin');const returnRoot=(await one("select _work_activity_operation_enter('end_break') id")).id;
await db.query("update time_shifts set break_started_at=null,break_type=null,last_punch_at=clock_timestamp(),break_seconds=900 where id=$1",[breaksShift]);
await db.query('select _work_activity_operation_exit($1)',[returnRoot]);await db.exec('commit');
const resumedState=await one('select * from personal_activity_state where profile_id=$1',[breaksPerson]);
check(resumedState.active_source_kind==='custom'&&resumedState.active_source_id!==breaksSource&&resumedState.resume_token===null,'Actual canonical custom command opens one new legacy interval after paid break');
check((await one('select break_seconds from time_shifts where id=$1',[breaksShift])).break_seconds===900,'Activity resume never recomputes or doubles payroll break seconds');
check((await one('select count(*)::int n from custom_work_sessions where profile_id=$1 and ended_at is null',[breaksPerson])).n===1,'Break return leaves one active source');

// Public immutable command protocol, exercising the actual canonical session
// writer and published configuration rather than a timing or permission mock.
await as(breaksPerson);
const device=id(500),generation=id(501),establishId=id(502);
const observed=(await one('select work_activity_snapshot($1) v',[device])).v;
const envelope={deviceId:device,clientGeneration:generation,clientSequence:0,predecessorCommandId:null,expectedRevision:observed.state.revision,
 basis:{observationId:observed.observation.id},shiftRef:observed.observation.shiftRef,tappedAt:new Date().toISOString(),clockCheckedAt:null,clockSkewMs:null,
 intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}};
const rpc=async(command,payload)=> (await one('select work_activity_command($1,1,$2) v',[command,payload])).v;
const established=await rpc(establishId,envelope);
check(established.receipt.status==='noop'&&established.receipt.beforeRevision===observed.state.revision,'Sequence zero establishes a real stream without a personal transition');
assert.deepEqual(await rpc(establishId,envelope),established);checks++;
assert.deepEqual(await rpc(establishId,{...envelope,tappedAt:'2026-01-01T00:00:00Z'}),{protocolVersion:1,availability:'unavailable',receipt:null});checks++;
await as(owner);assert.deepEqual(await rpc(establishId,envelope),{protocolVersion:1,availability:'unavailable',receipt:null});checks++;
await as(breaksPerson);
const stopId=id(503),stop={...envelope,clientSequence:1,predecessorCommandId:establishId,intent:{kind:'stop'},tappedAt:new Date().toISOString()};
const stopped=await rpc(stopId,stop);
check(stopped.receipt.status==='applied'&&stopped.receipt.afterRevision===observed.state.revision+1,'Stop commits exactly one personal transition through the owned legacy source');
assert.deepEqual(await rpc(stopId,stop),stopped);checks++;
await as(breaksPerson,'postgres');
check((await one('select count(*)::int n from custom_work_sessions where profile_id=$1 and ended_at is null',[breaksPerson])).n===0,'Public stop leaves no live legacy interval');
check((await one('select break_seconds from time_shifts where id=$1',[breaksShift])).break_seconds===900,'Public stop changes no payroll minutes');
await as(breaksPerson);
const fullActivityLabel='😀'.repeat(120);
await db.query("select work_publish_activity_version($1,'engine_general',0,'general',$2,'Tarea general',false,'[]')",[id(510),fullActivityLabel]);
await as(breaksPerson,'postgres');
const definition=await one("select d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code='engine_general'");
await as(breaksPerson);
await db.query("select work_publish_menu_version($1,'engine_menu',0,'Engine menu','Menu',$2)",[id(511),[{definitionId:definition.definition_id,versionId:definition.version_id,position:0,enabled:true}]]);
await as(breaksPerson,'postgres');const menu=await one("select v.id from work_capture_menus m join work_capture_menu_versions v on v.menu_id=m.id where m.code='engine_menu'");
await as(breaksPerson);await db.query('select work_select_job_menu($1,$2,$3,0)',[id(512),job,menu.id]);
await as(breaksPerson,'postgres');const selection=await one('select id,revision from work_job_menu_selections where project_id=$1 order by revision desc limit 1',[job]);
await db.exec('begin;select _work_activity_gate();update work_activity_authority_generation set revision=revision+1,capture_enabled=true;commit;');
await as(breaksPerson);
const fresh=(await one('select work_activity_snapshot($1) v',[device])).v;
const startId=id(513),start={...stop,clientSequence:2,predecessorCommandId:stopId,expectedRevision:stopped.receipt.afterRevision,basis:{observationId:fresh.observation.id},tappedAt:new Date().toISOString(),
 intent:{kind:'switch',projectId:job,selectionId:selection.id,selectionRevision:selection.revision,menuVersionId:menu.id,definitionVersionId:definition.version_id,scope:'general',unit:null,machineKind:null,values:{}}};
const started=await rpc(startId,start);
check(started.receipt.status==='applied'&&started.receipt.afterRevision===stopped.receipt.afterRevision+1,'Eligible published General starts through one canonical source transaction');
await as(breaksPerson,'postgres');
const captured=await one('select m.*,s.description,s.stage from work_session_capture_metadata m join custom_work_sessions s on s.id=m.session_id where m.profile_id=$1',[breaksPerson]);
check(captured.definition_version_id===definition.version_id&&captured.selection_id===selection.id&&captured.description===fullActivityLabel&&captured.stage==='Idle time','General source pins immutable versions and all 120 label codepoints while preserving Classic Idle time stage');
check((await one('select count(*)::int n from personal_activity_transitions t join custom_work_commands c on c.id=t.source_request_id where t.command_id=$1',[startId])).n===1,'Canonical nested custom receipt is durably linked to the activity transition');
await as(breaksPerson);
assert.deepEqual(await rpc(startId,start),started);checks++;
const stale={...start,clientSequence:3,predecessorCommandId:startId,tappedAt:new Date().toISOString()};
const conflicted=await rpc(id(514),stale);
check(conflicted.receipt.status==='conflict'&&conflicted.receipt.reasonCode==='state_changed','Stale expected revision yields an immutable terminal conflict');
check((await one('select work_activity_snapshot($1) v',[device])).v.stream.status==='blocked','Admitted conflict blocks descendants without rewriting their payload');

// Reaffirmation explicitly retires the blocked generation; it cannot repair
// or replay a descendant under that old generation with a new identity.
const reaffirm=async(deviceId,newGeneration,commandId)=>{
 const snap=(await one('select work_activity_snapshot($1) v',[deviceId])).v;
 const value={deviceId,clientGeneration:newGeneration,clientSequence:0,predecessorCommandId:null,expectedRevision:snap.state.revision,
  basis:{observationId:snap.observation.id},shiftRef:snap.observation.shiftRef,tappedAt:new Date().toISOString(),clockCheckedAt:null,clockSkewMs:null,
  intent:{kind:'establish_stream',previousGeneration:snap.observation.currentGeneration,previousHeadCommandId:snap.observation.currentHeadCommandId}};
 const result=await rpc(commandId,value);check(result.receipt.status==='noop','Fresh exact previous generation/head establishes reaffirmation');return value;
};
await db.query("select work_publish_activity_version($1,'engine_specific',0,'specific',$3,'Tarea especifica',false,$2)",[id(520),[{...base,id:'done',type:'boolean'},{...base,id:'count',type:'number',unit:'count',min:0}],fullActivityLabel]);
await as(breaksPerson,'postgres');const specificDef=await one("select d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code='engine_specific'");
await as(breaksPerson);
await db.query("select work_publish_menu_version($1,'engine_menu',1,'Engine menu','Menu',$2)",[id(521),[{definitionId:specificDef.definition_id,versionId:specificDef.version_id,position:0,enabled:true}]]);
await as(breaksPerson,'postgres');const specificMenu=await one("select v.id from work_capture_menus m join work_capture_menu_versions v on v.menu_id=m.id where m.code='engine_menu' order by v.version desc limit 1");
await as(breaksPerson);await db.query('select work_select_job_menu($1,$2,$3,1)',[id(522),job,specificMenu.id]);
await as(breaksPerson,'postgres');const specificSelection=await one('select id,revision from work_job_menu_selections where project_id=$1 order by revision desc limit 1',[job]);
const ub=(await one('select _work_activity_command_basis(_work_activity_unit_basis($1,$2)) v',[unit,breaksPerson])).v;
await as(breaksPerson);const nextEnvelope=await reaffirm(device,id(523),id(524));
const specificIntent={kind:'switch',projectId:job,selectionId:specificSelection.id,selectionRevision:specificSelection.revision,menuVersionId:specificMenu.id,definitionVersionId:specificDef.version_id,scope:'specific',unit:ub,machineKind:null,values:{done:false,count:0}};
const specificPayload={...nextEnvelope,clientSequence:1,predecessorCommandId:id(524),intent:specificIntent,tappedAt:new Date().toISOString()};
const specificResult=await rpc(id(525),specificPayload);
check(specificResult.receipt.status==='applied','Specific capture accepts actual canonical raw dimensions and required false/zero values');
await as(breaksPerson,'postgres');
const specificMeta=await one('select m.*,s.stage,s.description from work_session_capture_metadata m join custom_work_sessions s on s.id=m.session_id where m.profile_id=$1 and m.unit_id=$2',[breaksPerson,unit]);
check(specificMeta.fact_revision===ub.factRevision&&specificMeta.unit_facts.raw_observation.unit==='ft'&&specificMeta.unit_facts.estimated===true,'Specific immutable metadata preserves exact estimated original provenance without claiming verified dimensions');
assert.deepEqual(specificMeta.answers,{done:false,count:0});checks++;
check(specificMeta.stage==='😀'.repeat(100)&&specificMeta.description===fullActivityLabel,'Specific Classic stage respects its 100-character bound while full 120-codepoint label remains lossless');
check((await one('select count(*)::int n from custom_work_sessions where profile_id=$1 and ended_at is null',[breaksPerson])).n===1,'Switch atomically closes General and leaves only the new Specific source');
check((await one('select break_seconds from time_shifts where id=$1',[breaksShift])).break_seconds===900,'Specific switch never changes payroll break totals');
await as(breaksPerson);
const oldDescendant=await rpc(id(526),{...stale,clientSequence:4,predecessorCommandId:id(514),expectedRevision:specificResult.receipt.afterRevision});
check(oldDescendant.receipt.status==='conflict','Retired generation cannot resurrect its stale descendant');
// A source permission ABA invalidates an already observed start even when
// the public job identity and personal revision return to the same values.
const currentSnap=(await one('select work_activity_snapshot($1) v',[device])).v;
await as(breaksPerson,'postgres');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[job]);await db.query('update projects set deleted_at=null where id=$1',[job]);
await as(breaksPerson);
const aba=await rpc(id(527),{...specificPayload,clientSequence:2,predecessorCommandId:id(525),expectedRevision:specificResult.receipt.afterRevision,basis:{observationId:currentSnap.observation.id},tappedAt:new Date().toISOString()});
check(aba.receipt.status==='conflict'&&aba.receipt.reasonCode==='state_changed','Permission revocation/restoration fences the earlier observation');

// Explicit paid-setup adapter and unchanged keyed payroll arithmetic. Actual
// source payroll bodies above were transformed by the same assembly loop.
await as(owner,'postgres');const clockPerson=id(600),clockId=id(601);
await db.query("insert into profiles(id,role,is_test) values($1,'installer',false)",[clockPerson]);
// The actual paid tap intentionally precedes today's toolbox signature.
await as(clockPerson);
const clockAt=(await one("select to_char(clock_timestamp()-interval '1 hour','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') t")).t;
const clockArgs=[job,null,null,null,null,null,null,clockId,clockAt,new Date().toISOString(),0,1];
await refuse('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer)',clockArgs.slice(0,11),'P0001');
await as(clockPerson,'postgres');
check((await one('select count(*)::int n from time_shifts where profile_id=$1',[clockPerson])).n===0,'Unsigned retained eleven-argument clock refuses without payroll writes');
await as(clockPerson);
const paid=await one('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer,$12::integer)',clockArgs);
await as(clockPerson,'postgres');
const setup=await one('select * from work_setup_sessions where profile_id=$1',[clockPerson]);
check(setup?.shift_id===paid.id&&setup.clock_client_id===clockId&&setup.started_at.toISOString()===paid.clock_in_at.toISOString(),'Twelve-argument clock adapter opens setup at the actual original paid punch');
check((await one('select count(*)::int n from personal_activity_transitions where profile_id=$1',[clockPerson])).n===1,'Clock-in plus initial setup is one person transition');
const clockState=await one('select * from personal_activity_state where profile_id=$1',[clockPerson]);
check(clockState.active_source_kind==='setup'&&clockState.active_source_id===setup.id,'Setup is the one current personal allocation');
await as(clockPerson);await one('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer,$12::integer)',clockArgs);
await as(clockPerson,'postgres');check((await one('select count(*)::int n from work_setup_sessions where profile_id=$1',[clockPerson])).n===1,'Keyed clock replay never duplicates or retroactively invents setup');
await as(clockPerson);
const breakTap=(await one("select to_char(clock_timestamp()-interval '10 minutes','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') t")).t;
await db.query('select public.start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,$6::integer)',[paid.id,'rest',id(602),breakTap,new Date().toISOString(),0]);
const finishTap=(await one("select to_char(clock_timestamp(),'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') t")).t;
const endArgs=[paid.id,id(603),finishTap,new Date().toISOString(),0];
const breakResult=(await one('select public.end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5::integer) v',endArgs)).v;
check(breakResult.outcome==='ended'&&breakResult.shift.break_seconds===600,'Actual keyed end_break keeps its original rounded second arithmetic');
await one('select public.end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5::integer) v',endArgs);
await as(clockPerson,'postgres');
check((await one('select break_seconds from time_shifts where id=$1',[paid.id])).break_seconds===600,'Replayed break end deducts no second interval');
check((await one('select count(*)::int n from work_setup_sessions where profile_id=$1 and ended_at is null',[clockPerson])).n===1,'An eligible setup resumes once after the actual paid break return');
// Setup finishes on the SAME payroll row, after real toolbox completion.
await as(clockPerson);
const setupEnvelope=await reaffirm(id(610),id(611),id(612));
const finishSetup={...setupEnvelope,clientSequence:1,predecessorCommandId:id(612),intent:{kind:'finish_setup',projectId:job,costCodeId:null},tappedAt:new Date().toISOString()};
const noToolbox=await rpc(id(613),finishSetup);
check(noToolbox.receipt.status==='refused'&&noToolbox.receipt.reasonCode==='toolbox_required','Paid setup cannot become normal work before the actual toolbox is signed');
await as(clockPerson,'postgres');
check((await one('select count(*)::int n from work_setup_sessions where profile_id=$1 and ended_at is null',[clockPerson])).n===1,'Refused finish leaves paid setup and payroll untouched');
await db.query('insert into toolbox_completions(profile_id,signed_at) values($1,clock_timestamp())',[clockPerson]);
const paidBeforeFinish=(await one('select to_jsonb(t) v from time_shifts t where id=$1',[paid.id])).v;
await as(clockPerson);const confirmedSetup=await reaffirm(id(610),id(614),id(615));
const finishedSetup=await rpc(id(616),{...finishSetup,...confirmedSetup,clientSequence:1,predecessorCommandId:id(615),intent:finishSetup.intent,tappedAt:new Date().toISOString()});
check(finishedSetup.receipt.status==='applied','After signing toolbox, explicit reaffirmed finish closes setup');
await as(clockPerson,'postgres');
const paidAfterFinish=(await one('select to_jsonb(t) v from time_shifts t where id=$1',[paid.id])).v;
assert.deepEqual(paidAfterFinish,paidBeforeFinish);checks++;
check((await one('select count(*)::int n from work_setup_sessions where profile_id=$1 and ended_at is null',[clockPerson])).n===0,'Finished setup leaves no open setup interval');
check((await one('select count(*)::int n from time_shifts where profile_id=$1',[clockPerson])).n===1,'Finishing setup never creates a parallel payroll shift');
const beforeFuture=(await one('select to_jsonb(t) v from time_shifts t where id=$1',[paid.id])).v;
await db.query("update time_shifts set last_punch_at=clock_timestamp()+interval '1 hour' where id=$1",[paid.id]);
const futureStored=(await one('select to_jsonb(t) v from time_shifts t where id=$1',[paid.id])).v;
await as(clockPerson);
const futureOut=await one('select * from public.clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0)',[paid.id,id(604),new Date().toISOString(),new Date().toISOString()]);
check(futureOut.status==='needs_finish'&&futureOut.clock_out_at===null&&futureOut.break_seconds===600,'Corrupt future payroll evidence retains totals and refuses to invent a finish');
await as(clockPerson,'postgres');
const reviewAction=await one('select outcome,review_reason from time_clock_actions where client_id=$1',[id(604)]);
check(reviewAction.outcome==='requires_review'&&reviewAction.review_reason==='stored_punch_after_arrival','Future stored punch has its own durable truthful keyed outcome');
check((await one('select last_punch_at from time_shifts where id=$1',[paid.id])).last_punch_at.toISOString()===new Date(futureStored.last_punch_at).toISOString(),'Future original last punch remains intact');
check((await one('select count(*)::int n from work_setup_sessions where profile_id=$1 and ended_at is null',[clockPerson])).n===0,'Needs-finish closes private setup without claiming payroll clock-out');
// Receipt reads acknowledge immutable payroll evidence, never the current
// mutable shift row returned by a legacy replay.
await as(clockPerson);
const retainedClock=(await one('select work_activity_clock_receipt($1) v',[clockId])).v;
check(retainedClock.availability==='available'&&retainedClock.receipt.receiptProtocol==='setup_v1'&&retainedClock.receipt.retention==='retained','Actual new setup receipt is privately retained');
check(retainedClock.receipt.action==='clock_in'&&retainedClock.receipt.outcome==='clocked_in'&&retainedClock.receipt.shiftId===paid.id,'Receipt keeps its original outcome after later break and review changes');
check(retainedClock.receipt.activityTransition?.afterRevision===1,'Clock receipt links the exact initial personal transition');
const retainedEnd=(await one('select work_activity_clock_receipt($1) v',[id(603)])).v;
check(retainedEnd.receipt.outcome==='ended'&&retainedEnd.receipt.receiptProtocol==='legacy','Dependent keyed payroll outcome is retained without relabeling its protocol');
const retainedReview=(await one('select work_activity_clock_receipt($1) v',[id(604)])).v;
check(retainedReview.receipt.outcome==='requires_review'&&retainedReview.receipt.reviewReason==='stored_punch_after_arrival','Receipt reports permanent attention rather than an invented completed out');
await refuse('select * from work_activity_clock_receipts',[],'42501');
await as(owner);
assert.deepEqual((await one('select work_activity_clock_receipt($1) v',[clockId])).v,(await one('select work_activity_clock_receipt($1) v',[id(699)])).v);checks++;
await as(clockPerson);
const changedClock=[...clockArgs];changedClock[5]='Changed immutable note';
await refuse('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer,$12::integer)',changedClock);
await as(clockPerson,'postgres');
await refuse("update work_activity_clock_receipts set outcome='clocked_out' where client_id=$1",[clockId]);
await refuse('delete from work_activity_clock_receipts where client_id=$1',[clockId]);
await refuse('truncate table work_activity_clock_receipts');
// Model the original ledger's allowed purge independently of retained evidence.
await db.query('delete from time_clock_actions where shift_id=$1',[paid.id]);
await as(clockPerson);
const afterLedgerPurge=(await one('select work_activity_clock_receipt($1) v',[clockId])).v;
check(afterLedgerPurge.receipt.sourcePresent===false&&afterLedgerPurge.receipt.outcome==='clocked_in','Retained acknowledgement survives original ledger deletion');
await refuse('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer,$12::integer)',clockArgs,'42501');
await refuse('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer)',clockArgs.slice(0,11),'42501');
await refuse('select public.end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5::integer)',endArgs,'42501');
await as(clockPerson,'postgres');
check((await one('select count(*)::int n from time_shifts where profile_id=$1',[clockPerson])).n===1,'Replay after deletion creates no replacement paid shift');
// Two genuine source tables cascade from the same payroll parent. Historical
// closed intervals are deliberate: deletion is not a fabricated live punch.
await db.query("insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,ended_at,end_reason,shift_status) values($1,$2,$3,$4,'idle','Cascade fixture',clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '20 minutes','stop','needs_finish')",[id(617),clockPerson,paid.id,job]);
await db.query('insert into service_visits(id,project_id,created_by) values($1,$2,$3)',[id(618),job,clockPerson]);
await db.query("insert into service_time_sessions(id,visit_id,project_id,shift_id,profile_id,kind,stage,started_at,ended_at,end_reason) values($1,$2,$3,$4,$5,'idle','prep',clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '20 minutes','stop')",[id(619),id(618),job,paid.id,clockPerson]);
await db.query('delete from time_shifts where id=$1',[paid.id]);
check((await one('select (select count(*) from custom_work_sessions where id=$1)+(select count(*) from service_time_sessions where id=$2) n',[id(617),id(619)])).n===0,'Actual multi-relation source cascades complete under one private root');
await as(clockPerson);
const afterShiftPurge=(await one('select work_activity_clock_receipt($1) v',[clockId])).v;
assert.deepEqual(afterShiftPurge,afterLedgerPurge);checks++;
await as(clockPerson,'postgres');
check((await one('select (select count(*) from work_activity_operations)+(select count(*) from work_activity_operation_people)+(select count(*) from work_activity_operation_events)+(select count(*) from work_activity_statement_frames) n')).n===0,'FK cascade completion leaves no orphan private operation or statement frames');
await as(clockPerson);
await refuse('select * from public.clock_in($1::uuid,$2::uuid,$3::text,$4::double precision,$5::double precision,$6::text,$7::text,$8::uuid,$9::timestamptz,$10::timestamptz,$11::integer,$12::integer)',clockArgs,'42501');
// Narrow legacy source counters cannot stop the payroll safety lane. These
// assertions use actual keyed start_break and its same-transaction callbacks.
const maxPerson=id(700),maxShift=id(701),maxSession=id(702);
await as(owner,'postgres');
await db.query("insert into profiles(id,role,is_test) values($1,'owner',false)",[maxPerson]);
await as(maxPerson,'postgres');
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,last_punch_at,status,break_seconds) values($1,$2,$3,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour','open',123)",[maxShift,maxPerson,job]);
await db.query("insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,shift_status,revision) values($1,$2,$3,$4,'idle','Counter boundary',clock_timestamp()-interval '50 minutes','open',2147483647)",[maxSession,maxPerson,maxShift,job]);
await as(maxPerson);
const maxBreak=await one('select * from public.start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)',[maxShift,'rest',id(703),new Date().toISOString(),new Date().toISOString()]);
check(maxBreak.break_started_at!==null&&maxBreak.break_seconds===123,'Exhausted custom counter does not block actual keyed paid break or rewrite prior deduction');
await as(maxPerson,'postgres');
const maxClosed=await one('select revision,ended_at,review_required from custom_work_sessions where id=$1',[maxSession]);
check(maxClosed.revision===2147483647&&maxClosed.ended_at!==null&&maxClosed.review_required,'Exhausted custom source closes once without wrapping its revision');
const maxEvidence=await one("select before_evidence,after_evidence from work_activity_safety_events where profile_id=$1 and source_id=$2 and reason='source_revision_exhausted'",[maxPerson,maxSession]);
check(maxEvidence.before_evidence.revision===2147483647&&maxEvidence.before_evidence.ended_at===null&&maxEvidence.after_evidence.ended_at!==null,'Exceptional counter evidence retains the exact before/after source');
await as(maxPerson);
check((await one('select work_activity_snapshot($1) v',[id(704)])).v.capability.mode==='unavailable','Source exhaustion makes new capture unavailable');
await as(owner,'postgres');

// Existing/imported ledger availability is explicit; reads never backfill it.
await as(maxPerson,'postgres');
await db.query("insert into time_clock_actions(client_id,shift_id,profile_id,action,outcome,arrived_at) values($1,$2,$3,'clock_in','clocked_in',clock_timestamp())",[id(709),maxShift,maxPerson]);
check((await one('select count(*)::int n from work_activity_clock_receipts where client_id=$1',[id(709)])).n===0,'A non-payroll-root legacy receipt is not silently backfilled');
await as(maxPerson);
check((await one('select work_activity_clock_receipt($1) v',[id(709)])).v.receipt.retention==='legacy','Preexisting receipt availability is explicitly legacy, not promised retained');
await as(maxPerson,'postgres');
await db.query('delete from time_clock_actions where client_id=$1',[id(709)]);
await as(maxPerson);
check((await one('select work_activity_clock_receipt($1) v',[id(709)])).v.availability==='unavailable','Deleted legacy evidence does not manufacture an acknowledgement');
await as(owner,'postgres');
const servicePerson=id(710),serviceShift=id(711),visit=id(712),serviceSession=id(713);
await db.query("insert into profiles(id,role,is_test) values($1,'owner',false)",[servicePerson]);
await as(servicePerson,'postgres');
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,last_punch_at,status,break_seconds) values($1,$2,$3,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour','open',456)",[serviceShift,servicePerson,job]);
await db.query('insert into service_visits(id,project_id,created_by,revision,reviewed_by,reviewed_at) values($1,$2,$3,2147483647,$3,clock_timestamp())',[visit,job,servicePerson]);
await db.query("insert into service_time_sessions(id,visit_id,project_id,shift_id,profile_id,kind,stage,started_at) values($1,$2,$3,$4,$5,'idle','prep',clock_timestamp()-interval '50 minutes')",[serviceSession,visit,job,serviceShift,servicePerson]);
await as(servicePerson);
const serviceBreak=await one('select * from public.start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)',[serviceShift,'rest',id(714),new Date().toISOString(),new Date().toISOString()]);
check(serviceBreak.break_started_at!==null&&serviceBreak.break_seconds===456,'Exhausted visit review counter does not block the actual payroll break');
await as(servicePerson,'postgres');
const visitAfter=await one('select revision,reviewed_by,reviewed_at from service_visits where id=$1',[visit]);
check(visitAfter.revision===2147483647&&visitAfter.reviewed_by===null&&visitAfter.reviewed_at===null,'Exhausted visit invalidates review without wrapping its counter');
const serviceEvidence=await one("select after_evidence from work_activity_safety_events where profile_id=$1 and source_id=$2 and reason='source_revision_exhausted'",[servicePerson,serviceSession]);
check(serviceEvidence.after_evidence.exhaustedVisitCounter.before.reviewed_by===servicePerson&&serviceEvidence.after_evidence.exhaustedVisitCounter.after.reviewed_by===null,'Visit exception records its exact review before/after even when a later session event closes it');
check((await one('select ended_at from service_time_sessions where id=$1',[serviceSession])).ended_at!==null,'The service interval closes at the same payroll break');
// Shared phase progress is not automatically another worker's personal labor.
const phasePerson=id(800),phaseShift=id(801),phaseOpening=id(802),sharedPhase=id(803),phaseCustom=id(804);
await as(owner,'postgres');
await db.query("insert into profiles(id,role,is_test) values($1,'owner',false)",[phasePerson]);
await db.query("insert into project_openings(id,project_id,status) values($1,$2,'pending')",[phaseOpening,job]);
await as(phasePerson,'postgres');
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,last_punch_at,status,break_seconds) values($1,$2,$3,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour','open',0)",[phaseShift,phasePerson,job]);
await db.query("insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,shift_status) values($1,$2,$3,$4,'idle','Personal work',clock_timestamp()-interval '50 minutes','open')",[phaseCustom,phasePerson,phaseShift,job]);
await as(owner,'postgres');
await db.query("insert into opening_phases(id,opening_id,started_by,status,started_at,paused_at) values($1,$2,$3,'active',clock_timestamp()-interval '2 days',null)",[sharedPhase,phaseOpening,phasePerson]);
check((await one('select ended_at from custom_work_sessions where id=$1',[phaseCustom])).ended_at===null,'Another authorized worker updating shared phase progress does not close the starter personal activity');
check((await one('select active_source_id from personal_activity_state where profile_id=$1',[phasePerson])).active_source_id===phaseCustom,'Shared progress is not inferred as the starter personal claim');
await db.query('update opening_phases set paused_at=clock_timestamp() where id=$1',[sharedPhase]);
await db.query('update opening_phases set paused_at=null where id=$1',[sharedPhase]);
check((await one('select active_source_id from personal_activity_state where profile_id=$1',[phasePerson])).active_source_id===phaseCustom,'Foreign unpause also preserves the starter current activity');
await db.query('update opening_phases set paused_at=clock_timestamp() where id=$1',[sharedPhase]);
await as(phasePerson,'postgres');
const phaseBefore=await one('select clock_timestamp() t');
await db.query('update opening_phases set paused_at=null where id=$1',[sharedPhase]);
const phaseState=await one('select active_source_kind,active_source_id,effective_since from personal_activity_state where profile_id=$1',[phasePerson]);
check(phaseState.active_source_kind==='phase'&&phaseState.active_source_id===sharedPhase,'The actual starter own paid unpause becomes one personal phase participation');
check(phaseState.effective_since>=phaseBefore.t,'Resumed phase labor begins at actual unpause, never at its two-day-old shared start');
check((await one('select ended_at from custom_work_sessions where id=$1',[phaseCustom])).ended_at!==null,'Own unpause closes the prior personal source atomically');
// Exhausted shared-phase arithmetic cannot make the paid break return fail.
await as(phasePerson);
await one('select * from public.start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)',[phaseShift,'rest',id(805),new Date().toISOString(),new Date().toISOString()]);
await as(phasePerson,'postgres');
await db.query("update opening_phases set paused_seconds=2147483647,paused_at=clock_timestamp()-interval '5 minutes' where id=$1",[sharedPhase]);
// Restore the valid resume authority token after the administrative fixture edit.
await db.query('update personal_activity_state set resume_authority_revision=(select revision from work_activity_authority_generation where singleton) where profile_id=$1',[phasePerson]);
await as(phasePerson);
const exhaustedResume=await one('select public.end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,0) v',[phaseShift,id(806),new Date().toISOString(),new Date().toISOString()]);
check(exhaustedResume.v.outcome==='ended'&&exhaustedResume.v.shift.break_started_at===null,'An exhausted phase pause counter does not block actual paid break return');
await as(phasePerson,'postgres');
check((await one('select paused_at,paused_seconds from opening_phases where id=$1',[sharedPhase])).paused_seconds===2147483647,'Failed resume preserves the exhausted phase counter');
check((await one('select choice_required from personal_activity_state where profile_id=$1',[phasePerson])).choice_required===true,'Failed resume asks for a new choice while payroll runs');
// Separate statements in one transaction must not inherit a completed root.
const beforeIndependent=(await one('select revision from personal_activity_state where profile_id=$1',[phasePerson])).revision;
await db.exec('begin');
await db.query('update time_shifts set break_seconds=break_seconds+1 where id=$1',[phaseShift]);
check((await one('select count(*)::int n from work_activity_operations')).n===0,'First direct statement closes its own root before transaction commit');
await db.query('update time_shifts set break_seconds=break_seconds+1 where id=$1',[phaseShift]);
await db.exec('commit');
check((await one('select revision from personal_activity_state where profile_id=$1',[phasePerson])).revision===beforeIndependent+2,'Independent timing corrections have separate transitions in the same transaction');
await as(phasePerson,'postgres');
await db.query('update profiles set is_partner=true where id=$1',[phasePerson]);
await as(phasePerson);
await refuse('update time_shifts set break_seconds=break_seconds+1 where id=$1',[phaseShift],'42501');
await refuse('update task_sessions set ended_at=clock_timestamp() where profile_id=$1',[phasePerson],'42501');
await as(phasePerson,'postgres');
check((await one('select revision from personal_activity_state where profile_id=$1',[phasePerson])).revision===beforeIndependent+2,'Partner direct-write refusal changes no personal revision');
await db.query('update profiles set is_partner=false where id=$1',[phasePerson]);
await refuse('truncate table custom_work_sessions');
// A setup interval can still close with retained safety evidence when the
// global safe-integer revision is exhausted. No normal revision is invented.
const setupMaxPerson=id(900),setupMaxClock=id(901);
await as(owner,'postgres');
await db.query("insert into profiles(id,role,is_test) values($1,'installer',false)",[setupMaxPerson]);
await as(setupMaxPerson);
const setupMaxPaid=await one('select * from public.clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0,1)',[job,setupMaxClock,new Date().toISOString(),new Date().toISOString()]);
check((await one('select work_activity_clock_receipt($1) v',[setupMaxClock])).v.receipt.usedTapTime===true,'Trusted setup receipt retains its original paid tap');
await as(setupMaxPerson,'postgres');
await db.query('update personal_activity_state set revision=9007199254740991 where profile_id=$1',[setupMaxPerson]);
await as(setupMaxPerson);
const setupMaxBreak=await one('select * from public.start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)',[setupMaxPaid.id,'rest',id(902),new Date().toISOString(),new Date().toISOString()]);
check(setupMaxBreak.break_started_at!==null,'Global revision exhaustion cannot block paid break from setup');
await as(setupMaxPerson,'postgres');
const setupMaxClosed=await one('select ended_at,end_transition_id,end_safety_event_id from work_setup_sessions where profile_id=$1',[setupMaxPerson]);
check(setupMaxClosed.ended_at!==null&&setupMaxClosed.end_transition_id===null&&setupMaxClosed.end_safety_event_id!==null,'Exhausted setup closes against exact retained safety evidence');
check((await one('select revision from personal_activity_state where profile_id=$1',[setupMaxPerson])).revision===9007199254740991,'Setup safety closure never wraps its global revision');
await as(setupMaxPerson);
check((await one('select work_activity_clock_receipt($1) v',[id(902)])).v.receipt.activityTransition===null,'A retained safety-only payroll acknowledgement does not invent a normal activity transition');
// Untrusted original stamps retain payroll's existing review fallback without
// using that fallback arrival to invent automatic setup capture.
const uncheckedPerson=id(910),uncheckedClock=id(911);
await as(owner,'postgres');
await db.query("insert into profiles(id,role,is_test) values($1,'installer',false)",[uncheckedPerson]);
await as(uncheckedPerson);
const uncheckedPaid=await one('select * from public.clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,null::timestamptz,null::integer,1)',[job,uncheckedClock,new Date().toISOString()]);
check(uncheckedPaid.status==='open'&&uncheckedPaid.review_reason==='clock_unchecked','Unchecked original evidence preserves the actual paid payroll review fallback');
const uncheckedReceipt=(await one('select work_activity_clock_receipt($1) v',[uncheckedClock])).v.receipt;
check(uncheckedReceipt.receiptProtocol==='setup_v1'&&!uncheckedReceipt.usedTapTime&&uncheckedReceipt.reviewReason==='clock_unchecked','Setup-v1 identifies the actual twelve-arg receipt, not automatic setup success');
await as(uncheckedPerson,'postgres');
check((await one('select count(*)::int n from work_setup_sessions where profile_id=$1',[uncheckedPerson])).n===0,'An untrusted delayed stamp does not create automatic setup capture');
await as(uncheckedPerson);
const uncheckedSnapshot=(await one('select work_activity_snapshot($1) v',[id(912)])).v;
check(uncheckedSnapshot.state.status==='unclassified'&&uncheckedSnapshot.state.choiceRequired,'Current snapshot supplies the real paid-but-unclassified capture state');
// Rejected starts preserve the exact running source and payroll row. These
// actual RPC tests complement primitive validation; no source permission or
// canonical writer is replaced with a mock.
const admissionDevice=id(1000);
await as(breaksPerson,'postgres');
const admissionIntent={...specificIntent,unit:(await one('select _work_activity_command_basis(_work_activity_unit_basis($1,$2)) v',[unit,breaksPerson])).v};
const frozenWork=async()=>{
 await as(breaksPerson,'postgres');
 return (await one(`select jsonb_build_object('shift',(select to_jsonb(s) from time_shifts s where id=$1),
  'sources',(select jsonb_agg(to_jsonb(s) order by s.id) from custom_work_sessions s where profile_id=$2),
  'transitions',(select count(*) from personal_activity_transitions where profile_id=$2)) v`,[breaksShift,breaksPerson])).v;
};
const refusalCase=async(n,intent,reason,mutatePayload=async p=>p)=>{
 await as(breaksPerson);
 const anchor=await reaffirm(admissionDevice,id(n),id(n+1));
 const payload=await mutatePayload({...anchor,clientSequence:1,predecessorCommandId:id(n+1),intent,tappedAt:new Date().toISOString()});
 const before=await frozenWork();await as(breaksPerson);
 const refused=await rpc(id(n+2),payload);
 check(['conflict','refused'].includes(refused.receipt.status)&&refused.receipt.reasonCode===reason,`Actual command refuses ${reason}: ${JSON.stringify(refused)}`);
 assert.deepEqual(await frozenWork(),before);checks++;
 await as(breaksPerson);assert.deepEqual(await rpc(id(n+2),payload),refused);checks++;
 return refused;
};
await refusalCase(1010,{...admissionIntent,machineKind:'forklift'},'answers_invalid');
await refusalCase(1020,{...admissionIntent,values:{done:false,count:'0'}},'answers_invalid');
await refusalCase(1030,{...admissionIntent,values:{done:false,count:0,foreign:'value'}},'answers_invalid');
await refusalCase(1040,{...admissionIntent,unit:{...admissionIntent.unit,operationalRevision:admissionIntent.unit.operationalRevision+1}},'unit_changed');
await refusalCase(1050,{...admissionIntent,unit:{...admissionIntent.unit,originProjectEpoch:admissionIntent.unit.originProjectEpoch+1}},'unit_changed');
await refusalCase(1060,{...admissionIntent,projectId:id(99999)},'source_unavailable',async p=>({...p,expectedRevision:0}));
// Store an expired synthetic observation with all real own source/head tokens.
// Its age is fixture data; the server's clock and expiry predicate are actual.
const expiredObservation=async(payload,n)=>{
 await as(breaksPerson);
 const snap=(await one('select work_activity_snapshot($1) v',[admissionDevice])).v;
 await as(breaksPerson,'postgres');
 await db.query(`insert into work_activity_observations select (jsonb_populate_record(null::work_activity_observations,
  to_jsonb(o)||jsonb_build_object('id',$2::uuid,'issued_at',clock_timestamp()-interval '2 hours','expires_at',clock_timestamp()-interval '1 hour'))).*
  from work_activity_observations o where o.id=$1`,[snap.observation.id,id(n)]);
 return {...payload,basis:{observationId:id(n)}};
};
await refusalCase(1070,admissionIntent,'observation_expired',p=>expiredObservation(p,1073));
// Expiry blocks resurrection, but a causally valid stop can still close the
// current owned activity without a fresh start lease or changing payroll.
await as(breaksPerson);const stopAnchor=await reaffirm(admissionDevice,id(1080),id(1081));
const expiredStop=await expiredObservation({...stopAnchor,clientSequence:1,predecessorCommandId:id(1081),intent:{kind:'stop'},tappedAt:new Date().toISOString()},1082);
await as(breaksPerson);const expiredStopped=await rpc(id(1083),expiredStop);
check(expiredStopped.receipt.status==='applied','Expired start lease still permits an exact current-stream stop');
await as(breaksPerson,'postgres');
check((await one('select count(*)::int n from custom_work_sessions where profile_id=$1 and ended_at is null',[breaksPerson])).n===0,'Expired-lease stop closes the exact current source');
check((await one('select break_seconds from time_shifts where id=$1',[breaksShift])).break_seconds===900,'Expired-lease stop changes no payroll break total');
await as(owner,'postgres');
await db.query('update personal_activity_state set revision=9007199254740991 where profile_id=$1',[owner]);
await db.query("update time_shifts set clock_out_at='2026-10-04T14:00:00Z',last_punch_at='2026-10-04T14:00:00Z',status='submitted' where id=$1",[shift]);
check((await one("select count(*)::int n from work_activity_safety_events where profile_id=$1 and source_kind='shift' and source_id=$2",[owner,shift])).n===1,'Actual exhausted-revision source UPDATE retains exceptional shift evidence');
check((await one('select break_seconds,clock_out_at from time_shifts where id=$1',[shift])).break_seconds===1800,'Safety fallback preserves the existing payroll break total');
check((await one('select revision from personal_activity_state where profile_id=$1',[owner])).revision===9007199254740991,'Safety evidence never wraps or invents a normal revision');
await as(owner);
check((await one('select work_activity_snapshot($1) v',[id(50)])).v.capability.mode==='unavailable','Unreconciled safety evidence disables capture');
await refuse('select * from work_activity_safety_events',[],'42501');
await as(owner,'postgres');
await refuse('delete from work_activity_safety_events');
await db.close();
console.log(`PASS ${checks} ${assembly?'development-prefix private helper':'cutover'} assertions; no active-writer or concurrency proof`);
