// Disposable source-matched PGlite volume only. It cannot prove genuine waits.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const path=new URL('./verify-work-activity-totals.mjs',import.meta.url);
const original=readFileSync(path,'utf8');
const seam='if(process.env.WORK_ACTIVITY_TOTALS_WIRE_OUT)';
assert.equal(original.split(seam).length,2);
const volume=String.raw`
const report={totalsSha256:hash(totals),reviewSha256:hash(review),scope:'PGlite source-matched sequential, no genuine-role/race or production throughput claim',tiers:[]};
await as(id(2));const fixedGeneralTotal=(await readTotals()).totals.scopeKnownMicros;await as(id(2),'postgres');
await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'TOTALS-UNRELATED')",[id(21),id(11)]);
await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values($1,$2,'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',0)",[id(80),id(20)]);
await db.query("insert into task_sessions(id,project_id,profile_id,state,started_at,ended_at) values($1,$2,$3,'on_task',now()-interval '2 hours',now()-interval '1 hour')",[id(90),id(10),id(3)]);
const parentTx=(await q('select id from personal_activity_transitions where source_shift_id=$1 order by revision_after limit 1',[shift.id])).id;
let previousRows=0,previousChanges=0;
for(const [rows,changes] of [[0,0],[1000,100],[10000,1000]]){
 await as(id(2),'postgres');const seedStart=performance.now();
 if(rows>previousRows){
 await db.query("insert into project_openings(id,project_id,opening_code) select md5('totals-live-opening-'||g)::uuid,$1,'TOTALS-U-'||g from generate_series($2::int,$3::int)g",[id(11),previousRows+1,rows]);
 await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) select md5('totals-live-phase-'||g)::uuid,md5('totals-live-opening-'||g)::uuid,'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',60 from generate_series($2::int,$3::int)g where $1::uuid is not null",[id(21),previousRows+1,rows]);
 await db.query("insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) select $1,$2,'phase',md5('totals-live-phase-'||g)::uuid,'phase_participation','{}',jsonb_build_object('id',md5('totals-live-phase-'||g)::uuid,'opening_id',md5('totals-live-opening-'||g)::uuid,'project_id',$4::uuid) from generate_series($5::int,$6::int)g where $3::uuid is not null",[parentTx,id(1),id(21),id(11),previousRows+1,rows]);
 }
 if(changes>previousChanges)await db.exec("do $$begin for n in "+(previousChanges+1)+".."+changes+" loop update opening_phases set minutes=n where id='"+id(80)+"';update task_sessions set ended_at=ended_at+interval '1 microsecond' where id='"+id(90)+"';end loop;end$$;");
 const seedMs=performance.now()-seedStart;
 await db.exec('analyze work_activity_source_history;analyze personal_activity_transition_sources;analyze opening_phases');
 const plan=(await db.query("explain(analyze,buffers,format json) select source_id from work_activity_source_history where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings') and before_value->>'project_id'=$1",[id(10)])).rows;
 await as(id(2));
 for(const mode of ['unit','general']){
 const observations=[];
 for(let n=0;n<10;n++){const start=performance.now();const result=await readTotals(mode==='unit'?id(30):null);assert.equal(result.availability,'available');assert.equal(result.totals.scopeKnownMicros,mode==='unit'?fixedTotal:fixedGeneralTotal);observations.push(performance.now()-start);}
 observations.sort((a,b)=>a-b);
 const tier={mode,unrelatedLiveRows:rows,unrelatedTransitionSources:rows,unitTargetRetainedChanges:changes,generalTargetRetainedChanges:changes,seedMs,calls:observations.length,medianMs:(observations[4]+observations[5])/2,p95Ms:observations[9],maxMs:observations.at(-1),observationsMs:observations,lookupExplain:plan};report.tiers.push(tier);console.log('TOTALS_VOLUME',JSON.stringify(tier));
 }

 previousRows=rows;previousChanges=changes;
}
if(process.env.WORK_ACTIVITY_TOTALS_VOLUME_OUT)writeFileSync(process.env.WORK_ACTIVITY_TOTALS_VOLUME_OUT,JSON.stringify(report,null,2)+'\n');
`;
const source=original.replace(seam,()=>volume+'\n'+seam).replaceAll('import.meta.url',JSON.stringify(path.href));
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
