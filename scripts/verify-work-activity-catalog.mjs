// Selected-job read checks using actual substrate schema and actual private
// basis bodies. No active cutover, independent backend or production proof.
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where},null,2));process.exit(1);});
const root=new URL('../',import.meta.url),folder=mkdtempSync(join(tmpdir(),'forge-activity-catalog-'));
let schema;
try{
  const path=join(folder,'schema.sql');
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('./verify-work-activity-engine-substrate.mjs',import.meta.url))],{env:{...process.env,WORK_ACTIVITY_SCHEMA_OUT:path},encoding:'utf8',timeout:120000});
  assert.equal(run.status,0,run.stderr);schema=readFileSync(path,'utf8');
}finally{rmSync(folder,{recursive:true,force:true});}
const {PGlite}=await import(process.env.PGLITE_MODULE??'@electric-sql/pglite');
const db=new PGlite();await db.exec(schema);
const cutover=readFileSync(new URL('supabase/migrations/20261108410000_work_activity_engine_cutover.sql',root),'utf8');
for(const name of ['_work_activity_read_committed','_work_activity_iso','_work_activity_unit_basis']){
  const begin=cutover.indexOf('create function public.'+name+'(');assert.ok(begin>=0,'Actual private helper '+name);
  const end=cutover.indexOf('revoke all on function public.'+name+'(',begin);assert.ok(end>begin);
  const revokeEnd=cutover.indexOf(';',end);await db.exec(cutover.slice(begin,revokeEnd+1));
}
await db.exec(readFileSync(new URL('supabase/migrations/20261108420000_work_activity_catalog.sql',root),'utf8'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const OWNER=id(1),CREW=id(2),QA=id(3),PARTNER=id(4),REVOKED=id(5),JOB=id(10),OTHER=id(11),TEST=id(12),UNIT=id(20);
let checks=0;
const check=(v,message)=>{assert.ok(v,message);checks++;};
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const as=async(actor)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');};
const read=async(job=JOB,unit=null)=>(await one('select work_activity_catalog($1,$2) value',[job,unit])).value;
const refuse=async(sql,args=[],code='42501')=>{let error;try{await db.query(sql,args);}catch(e){error=e;}assert.ok(error,'Unexpected success');assert.equal(error.code,code,error.message);checks++;};
await db.query(`insert into profiles(id,role,is_test,is_partner,access_revoked_at) values($1,'owner',false,false,null),($2,'installer',false,false,null),($3,'installer',true,false,null),($4,'supervisor',false,true,null),($5,'owner',false,false,clock_timestamp())`,[OWNER,CREW,QA,PARTNER,REVOKED]);
await db.query('insert into projects(id,is_test) values($1,false),($2,false),($3,true)',[JOB,OTHER,TEST]);
await db.query('insert into sandbox_projects(project_id) values($1)',[TEST]);
await as(OWNER);
check((await read()).selection===null,'Authorized no menu is available without invented identities');
await refuse('select work_activity_catalog(null,null)',[],'23514');
const fields=[{id:'truth',label_en:'True?',label_es:'Verdad?',type:'boolean',required:true}];
await db.query('select work_publish_activity_version($1,$2,0,$3,$4,$5,false,$6)',[id(100),'planning','general','Planning','Planear',fields]);
await db.query('select work_publish_activity_version($1,$2,0,$3,$4,$5,true,$6)',[id(101),'machine','specific','Machine','Maquina',[]]);
await db.exec('reset role');
const definitions=(await db.query('select d.code,d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id order by d.code')).rows;
const items=definitions.map((d,i)=>({definitionId:d.definition_id,versionId:d.version_id,position:i,enabled:true}));
await as(OWNER);await db.query('select work_publish_menu_version($1,$2,0,$3,$4,$5)',[id(102),'main','Main','Principal',items]);
await db.exec('reset role');const menu=(await one("select id from work_capture_menu_versions where menu_id=(select id from work_capture_menus where code='main')")).id;
await as(OWNER);await db.query('select work_select_job_menu($1,$2,$3,0)',[id(103),JOB,menu]);
const current=(await read()).selection;
check(current.selectionId && current.selectionRevision===1 && current.menuVersionId===menu,'Actual immutable selection ID and revision returned');
check(current.activities.find(a=>a.scope==='general').typedFields[0].required===true,'Frozen required boolean schema returned unchanged');
check(current.activities.find(a=>a.scope==='general').eligibleNow===true,'General remains eligible without unit');
check(current.activities.find(a=>a.scope==='specific').ineligibleReason==='unit_required','Specific requires explicit unit selection');
await as(CREW);const crew=await read();check(crew.availability==='available' && crew.selection.selectionId===current.selectionId,'Installer receives same narrow job choices without management grant');
check(Object.keys(crew).sort().join(',')==='asOf,availability,projectId,protocolVersion,selection,totals,unit','Crew and owner envelope has exact same minimal shape');
check(crew.totals.availability==='unavailable' && !('paidSeconds' in crew),'Unknown totals never manufactured as zero');
for(const isolation of ['repeatable read','serializable']){
  await db.exec('begin isolation level '+isolation);
  try{await refuse('select work_activity_catalog($1,null)',[JOB],'25001');}
  finally{await db.exec('rollback');}
}
for(const actor of [PARTNER,REVOKED,null]){await as(actor);await refuse('select work_activity_catalog($1,null)',[JOB]);}
await as(QA);const hidden=await read(JOB);check(hidden.availability==='unavailable' && hidden.projectId===null && hidden.selection===null,'QA cannot read real job identities');check((await read(TEST)).availability==='available','QA can read sandbox job');
await as(OWNER);await db.query('select custom_work_command($1,\'unit\',$2)',[id(104),{id:UNIT,revision:0,project_id:JOB,label:'Synthetic unit',facts:{},dimension_observation:{width:2,height:3,unit:'ft',source:'estimated'},expected_fact_revision:0}]);
await as(CREW);const withUnit=await read(JOB,UNIT);
check(withUnit.unit.id===UNIT && withUnit.unit.fact.dimensions.original.width===2,'Actual current/raw unit basis included');
check(withUnit.selection.activities.find(a=>a.scope==='specific').eligibleNow===true,'Positive estimated original dimensions permit capture without claiming verified average');
check((await read(OTHER,UNIT)).availability==='unavailable' && (await read(JOB,id(999))).unit===null,'Mismatch and absent unit refuse before basis identifiers');
await db.exec('reset role');
const before=await one('select (select count(*) from personal_activity_state) states,(select count(*) from personal_activity_commands) commands');
await as(CREW);await read(JOB,UNIT);await db.exec('reset role');
assert.deepEqual(await one('select (select count(*) from personal_activity_state) states,(select count(*) from personal_activity_commands) commands'),before);checks++;
await as(OWNER);await db.query('select work_retire_activity($1,$2,1)',[id(105),'planning']);
const retired=await read(JOB,UNIT);check(retired.selection.eligibleNow===false && retired.selection.activities.every(a=>!a.eligibleNow),'One retired enabled child holds entire menu as command validator does');
await db.exec('reset role');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[JOB]);await as(CREW);check((await read()).projectId===null,'Deleted job has unavailable envelope');
await db.exec('reset role');
for(const role of ['public','anon'])check(!(await one('select has_function_privilege($1,\'public.work_activity_catalog(uuid,uuid)\',\'EXECUTE\') value',[role])).value,'Anonymous ACL closed');
check((await one("select has_function_privilege('authenticated','public.work_activity_catalog(uuid,uuid)','EXECUTE') value")).value,'Authenticated read ACL');
check((await one("select provolatile from pg_proc where oid='public.work_activity_catalog(uuid,uuid)'::regprocedure")).provolatile==='v','Read uses post-lock time and fresh source checks');
await db.close();console.log(`PASS ${checks} actual-source selected-job catalog checks; no active cutover, concurrency or production proof`);
