// Local volume characterization only. PGlite is not genuine role/wait proof.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runContributorProof} from './verify-work-unit-contributors.mjs';
assert.equal(createHash('sha256').update(readFileSync(new URL('./verify-work-unit-contributors.mjs',import.meta.url))).digest('hex'),'ad5b0b99222f29a8305c27a00f8d947662fd7fc94114fcd8f41fc16e8cab2d9a');
assert.equal(process.argv.length,2);
const volume=String.raw`
const matrix=(process.env.WORK_UNIT_METADATA_VOLUME_TIERS??'0:1,0:10,0:100,1000:1,1000:10,1000:100,10000:1,10000:10,10000:100').split(',').map(x=>x.split(':').map(Number));
assert.ok(matrix.every(([r,u])=>[0,1000,10000].includes(r)&&[1,10,100].includes(u)));
const volumeReport={sourceSha256:hash(metadataSql),scope:'Source-matched local PGlite; no genuine role or concurrent wait evidence',status:'running',matrix,baseline:null,tiers:[],seedBatches:[],timeoutsSeconds:{statement:20,lock:12}};
const vp=()=>{if(process.env.WORK_UNIT_METADATA_VOLUME_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_VOLUME_OUT,JSON.stringify(volumeReport,null,2)+'\n');};
await as(id(2),'postgres');await db.exec("set statement_timeout='20s';set lock_timeout='12s'");
volumeReport.baseline=(await q("select jsonb_build_object('history',(select count(*) from work_activity_source_history),'live',(select count(*) from _work_unit_review_live_sources),'transitions',(select count(*) from personal_activity_transition_sources)) value")).value;vp();
const volumeParent=(await q('select id from personal_activity_transitions where source_shift_id=$1 order by revision_after limit 1',[shift.id])).id;
const volumePhase=id(70000);await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values($1,$2,'flashing','submitted',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',0)",[volumePhase,id(20)]);
let vr=0,vc=0;
try{
 for(const [rows,size] of matrix){
  const changes=rows/10;await as(id(2),'postgres');
  for(let lo=vr+1;lo<=rows;lo+=100){const hi=Math.min(rows,lo+99);const statements=[['project_openings',"insert into project_openings(id,project_id,opening_code) select md5('cohort-local-opening-'||g)::uuid,$1,'COHORT-LOCAL-'||g from generate_series($2::int,$3::int)g",[id(11),lo,hi]],['opening_phases',"insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) select md5('cohort-local-phase-'||g)::uuid,md5('cohort-local-opening-'||g)::uuid,'flashing','submitted',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',60 from generate_series($1::int,$2::int)g",[lo,hi]],['transition_sources',"insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) select $1,$2,'phase',md5('cohort-local-phase-'||g)::uuid,'phase_participation','{}',jsonb_build_object('opening_id',md5('cohort-local-opening-'||g)::uuid,'project_id',$3::uuid) from generate_series($4::int,$5::int)g",[volumeParent,id(1),id(11),lo,hi]]];
   for(const [table,sql,args]of statements){volumeReport.pendingSeed={table,lo,hi};vp();const begin=performance.now();const result=await db.query('with inserted as ('+sql+' returning 1) select count(*)::int count from inserted',args);assert.equal(result.rows[0].count,hi-lo+1);volumeReport.seedBatches.push({table,lo,hi,count:result.rows[0].count,wallMs:performance.now()-begin});delete volumeReport.pendingSeed;vp();}
  }
  for(let n=vc+1;n<=changes;n++)await db.query('update opening_phases set minutes=$1 where id=$2',[n,volumePhase]);vr=rows;vc=changes;
  const census=(await q("select jsonb_build_object('openings',(select count(*) from project_openings where project_id=$1 and opening_code like 'COHORT-LOCAL-%'),'phases',(select count(*) from opening_phases p join project_openings o on o.id=p.opening_id where o.project_id=$1 and o.opening_code like 'COHORT-LOCAL-%'),'transitions',(select count(*) from personal_activity_transition_sources where transition_id=$2 and source_kind='phase'),'targetChanges',(select count(*) from work_activity_source_history where source_kind='opening_phases' and source_id=$3 and before_value<>'{}' and after_value<>'{}' and before_value->'minutes' is distinct from after_value->'minutes')) value",[id(11),volumeParent,volumePhase])).value;assert.deepEqual(census,{openings:rows,phases:rows,transitions:rows,targetChanges:changes});volumeReport.census=census;vp();
  await db.exec('savepoint metadata_volume_units');await as(id(2));
  for(let n=1;n<size;n++)await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(80000+n),JSON.stringify({id:id(81000+n),revision:0,project_id:id(10),opening_id:null,label:'Volume unit '+n,type_label:'Unknown',facts:{}})]);
  const samples=[],serverObservations=[];volumeReport.pendingTier={rows,size,samples,serverObservations};vp();
  for(let n=0;n<20;n++){const begin=performance.now();const result=(await q('select work_unit_cohorts_read($1,1) value',[id(10)])).value;const ms=performance.now()-begin;assert.equal(result.availability,'available');assert.equal(result.cohort.units.length,size);samples.push(ms);serverObservations.push({asOf:result.cohort.asOf,unitCount:result.cohort.units.length,replyBytes:Buffer.byteLength(JSON.stringify(result))});vp();assert.ok(ms<=20000,'Local RPC wall limit exceeded; PGlite statement_timeout is not reliable wait evidence');}
  const explain=(await db.query('explain(analyze,buffers,format json) select work_unit_cohorts_read($1,1)',[id(10)])).rows;
  const sorted=[...samples].sort((a,b)=>a-b);volumeReport.tiers.push({rows,size,census,samplesMs:samples,serverObservations,medianMs:(sorted[9]+sorted[10])/2,p95Ms:sorted[18],maxMs:sorted[19],rpcExplain:explain});delete volumeReport.pendingTier;vp();console.log('COHORT_VOLUME',JSON.stringify({rows,size,medianMs:(sorted[9]+sorted[10])/2,p95Ms:sorted[18],maxMs:sorted[19]}));
  await db.exec('rollback to savepoint metadata_volume_units');await as(id(2),'postgres');
 }
 volumeReport.status='passed';vp();
}catch(e){volumeReport.status='failed';volumeReport.failure={message:e.message,code:e.code};vp();throw e;}
`;
await runContributorProof(readFileSync(new URL('./fixtures/work-unit-metadata-cohorts-checks.mjs',import.meta.url),'utf8')+'\n'+volume);
