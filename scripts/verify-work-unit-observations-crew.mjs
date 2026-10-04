// Actual canonical unit/crew seam in a disposable PGlite fixture. No network.
// Bootstrap comes from the current unit verifier, not duplicated helper stubs.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory=mkdtempSync(join(tmpdir(),'forge-unit-crew-'));
let schema;
try {
  const path=join(directory,'schema.sql');
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./verify-work-unit-observations.mjs',import.meta.url))],{
    env:{...process.env,WORK_UNIT_SCHEMA_OUT:path},encoding:'utf8',timeout:120000});
  assert.equal(r.status,0,r.stderr); schema=readFileSync(path,'utf8');
} finally { rmSync(directory,{recursive:true,force:true}); }
const { PGlite }=await import(process.env.PGLITE_MODULE??'@electric-sql/pglite');
const db=new PGlite();
const source=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const fn=(text,name)=>{
  const start=text.indexOf('create or replace function public.'+name+'(');
  assert.ok(start>=0,'Actual latest helper exists: '+name);
  const end=text.indexOf('$$;',start); assert.ok(end>start); return text.slice(start,end+3);
};
await db.exec(schema);
// Exact historical crew table/RLS DDL, then its latest actual read policy
// replacements. Unrelated person-count and contributor commands are not loaded.
const base=source('20261023000000_foreman_crew_unit_records.sql');
const cutoff=base.indexOf('create function public.record_crew_work('); assert.ok(cutoff>0);
await db.exec(base.slice(0,cutoff)+'commit;');
const latest=source('20261049000000_foreman_unit_contributors.sql');
const prefixEnd=latest.indexOf('create function public._stage_contributor_digest('); assert.ok(prefixEnd>0);
await db.exec(latest.slice(0,prefixEnd)+'commit;');
await db.exec(fn(latest,'record_crew_work'));
await db.exec('select attach_sandbox_guards();');
let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const [foreman,installer,job,unit,request,request2,failedUnit,failedRequest]=[1,2,3,4,5,6,7,8].map(id);
await db.query("insert into profiles(id,role,is_test) values($1,'foreman',true),($2,'installer',true)",[foreman,installer]);
await db.query('insert into projects(id,is_test) values($1,true)',[job]);
await db.query('insert into sandbox_projects(project_id) values($1)',[job]);
const snapshot=async()=>{
 const values={};
 for(const table of ['time_shifts','custom_work_sessions','unit_sessions','task_sessions']) values[table]=(await db.query(`select * from ${table} order by id`)).rows;
 return values;
};
// Nonempty historical rows make timing parity an actual preservation check.
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status,break_seconds) values($1,$2,$3,'2026-09-18T07:00Z','2026-09-18T15:00Z','submitted',1800)",[id(90),installer,job]);
await db.query("insert into unit_sessions(id,profile_id,opening_id,started_at,ended_at,end_reason) values($1,$2,$3,'2026-09-18T08:00Z','2026-09-18T09:00Z','stop')",[id(91),installer,id(99)]);
await db.query("insert into task_sessions(id,profile_id,opening_id,started_at,ended_at) values($1,$2,$3,'2026-09-18T09:00Z','2026-09-18T10:00Z')",[id(92),installer,id(99)]);
await db.query("insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,ended_at,end_reason,shift_status) values($1,$2,$3,$4,'idle','Original paid prep','2026-09-18T10:00Z','2026-09-18T11:00Z','stop','submitted')",[id(93),installer,id(90),job]);
const before=await snapshot();
const as=async uid=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);await db.exec('set role authenticated');};
const system=()=>db.exec('reset role');
const record=(cid,data)=>db.query('select record_crew_work($1,$2) as id',[cid,data]);
const read=async()=> (await db.query('select work_unit_fact_current_read($1) as value',[unit])).rows[0].value;
let data={unit:{id:unit,revision:0,project_id:job,label:'Synthetic crew unit',facts:{note:'Original detail'},dimension_observation:{width:1,height:2,unit:'ft',source:'measured'},expected_fact_revision:0},people:[foreman,installer],work_date:'2026-09-18',stage:'Installing',outcome:'assigned',whole_complete:false};
await as(foreman);
check((await record(request,data)).rows[0].id===unit,'Crew canonical save returns actual unit');
const first=await read(); check(first.revision===1&&first.widthIn===12&&first.heightIn===24&&first.observation.unit==='ft','Private original feet and normalized inches match');
await record(request,data); await system();
check((await db.query('select * from work_unit_fact_revisions where unit_id=$1',[unit])).rows.length===1,'Exact crew replay adds no fact');
check((await db.query('select payload from custom_work_commands where id=$1',[request])).rows[0].payload.action==='crew_record','Actual root receipt rewritten to original crew envelope');
check((await db.query('select command_id from work_unit_fact_revisions where unit_id=$1',[unit])).rows[0].command_id===request,'One original command ID survives nested receipt rewrite');
const facts=(await db.query('select facts from custom_work_units where id=$1',[unit])).rows[0].facts;
data={...data,unit:{...data.unit,revision:1,facts,expected_fact_revision:1},outcome:'finished',whole_complete:true};
await as(foreman); await record(request2,data); await system();
const final=(await db.query('select * from custom_work_units where id=$1',[unit])).rows[0];
check(final.facts.installation_complete==='Yes'&&final.facts.note==='Original detail','Whole complete applies final canonical facts without dropping unrelated detail');
check(final.untimed_work_present===true,'Legacy crew untimed-work behavior retained');
check((await db.query('select * from work_unit_fact_revisions where unit_id=$1',[unit])).rows.length===2,'Secondary untimed flag UPDATE adds no phantom fact revision');
check((await db.query('select payload from custom_work_commands where id=$1',[request2])).rows[0].payload.data.whole_complete===true,'Original whole-complete crew payload retained');
// A duplicate ledger id intentionally fails after the nested canonical save.
await db.query("insert into crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome) values($1,$2,$3,$4,'2026-09-18','Installing','assigned')",[failedRequest,job,unit,foreman]);
const failing={...data,unit:{...data.unit,id:failedUnit,revision:0,label:'Late crew refusal',facts:{},expected_fact_revision:0},outcome:'assigned',whole_complete:false};
await as(foreman);
let failed=false;
try{await record(failedRequest,failing);}catch(e){assert.equal(e.code,'23505');failed=true;}
check(failed,'Actual post-nested-save ledger collision refused'); await system();
for(const [table,key,value] of [['custom_work_units','id',failedUnit],['custom_work_commands','id',failedRequest],['custom_work_history','entity_id',failedUnit],['work_unit_fact_revisions','unit_id',failedUnit],['work_unit_fact_current','unit_id',failedUnit]])
 check((await db.query(`select * from ${table} where ${key}=$1`,[value])).rows.length===0,'Late crew failure rolls back '+table);
assert.deepEqual(await snapshot(),before);checks++;
await db.close(); console.log(`PASS ${checks} actual unit/crew receipt, atomicity and timing-parity checks; disposable fixtures only`);
