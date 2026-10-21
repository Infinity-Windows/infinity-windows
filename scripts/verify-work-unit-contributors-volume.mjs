// Disposable sequential volume; actual role/lock evidence requires the PG harness.
import {runContributorProof} from './verify-work-unit-contributors.mjs';
const volume=String.raw`
const report={sourceSha256:hash(contributors),verifierSha256:hash(read('scripts/verify-work-unit-contributors.mjs')),volumeHarnessSha256:hash(read('scripts/verify-work-unit-contributors-volume.mjs')),scope:'Source-matched PGlite sequential only; no genuine login, wait or throughput claim',seedBatchSize:100,tiers:[],seedBatches:[]};
const persistVolume=()=>{if(process.env.WORK_UNIT_CONTRIBUTORS_VOLUME_OUT)writeFileSync(process.env.WORK_UNIT_CONTRIBUTORS_VOLUME_OUT,JSON.stringify(report,null,2)+'\n');};
await as(id(2),'postgres');
report.baselineCensus=(await q("select jsonb_build_object('retainedHistory',(select count(*) from work_activity_source_history),'liveSources',(select count(*) from _work_unit_review_live_sources),'transitionSources',(select count(*) from personal_activity_transition_sources)) value")).value;
await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values($1,$2,'flashing','submitted',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',0)",[id(12000),id(20)]);
const parentTx=(await q('select id from personal_activity_transitions where source_shift_id=$1 order by revision_after limit 1',[shift.id])).id;
let previousRows=0,previousChanges=0;
for(const [rows,changes] of [[0,0],[1000,100],[10000,1000]]){
 await as(id(2),'postgres');
 for(let lo=previousRows+1;lo<=rows;lo+=100){const hi=Math.min(lo+99,rows),t=performance.now();
 await db.query("insert into project_openings(id,project_id,opening_code) select md5('contributors-live-opening-'||g)::uuid,$1,'CONTRIBUTORS-U-'||g from generate_series($2::int,$3::int)g",[id(11),lo,hi]);
 await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) select md5('contributors-live-phase-'||g)::uuid,md5('contributors-live-opening-'||g)::uuid,'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',60 from generate_series($1::int,$2::int)g",[lo,hi]);
 await db.query("insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) select $1,$2,'phase',md5('contributors-live-phase-'||g)::uuid,'phase_participation','{}',jsonb_build_object('opening_id',md5('contributors-live-opening-'||g)::uuid,'project_id',$3::uuid) from generate_series($4::int,$5::int)g",[parentTx,id(1),id(11),lo,hi]);
 report.seedBatches.push({first:lo,last:hi,rowsPerTable:hi-lo+1,wallMs:performance.now()-t});persistVolume();
 }
 for(let n=previousChanges+1;n<=changes;n++)await db.query('update opening_phases set minutes=$1 where id=$2',[n,id(12000)]);
 const counts=(await q("select jsonb_build_object('openings',(select count(*) from project_openings where project_id=$1 and opening_code like 'CONTRIBUTORS-U-%'),'phases',(select count(*) from opening_phases p join project_openings o on o.id=p.opening_id where o.project_id=$1 and o.opening_code like 'CONTRIBUTORS-U-%'),'transitions',(select count(*) from personal_activity_transition_sources s join opening_phases p on p.id=s.source_id join project_openings o on o.id=p.opening_id where s.transition_id=$2 and o.project_id=$1 and o.opening_code like 'CONTRIBUTORS-U-%'),'changes',(select count(*) from work_activity_source_history where source_kind='opening_phases' and source_id=$3 and before_value<>'{}'::jsonb and after_value<>'{}'::jsonb and before_value->'minutes' is distinct from after_value->'minutes')) value",[id(11),parentTx,id(12000)])).value;
 assert.deepEqual(counts,{openings:rows,phases:rows,transitions:rows,changes});
 await db.exec('analyze work_activity_source_history;analyze personal_activity_transition_sources;analyze opening_phases');
 const lookupExplain=(await db.query("explain(analyze,buffers,format json) select source_id from work_activity_source_history where source_kind='custom_work_sessions' and before_value->>'unit_id'=$1",[id(30)])).rows;
 await as(id(2));const samples=[];
 for(let n=0;n<10;n++){const t=performance.now(),answer=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;assert.equal(answer.availability,'available');assert.equal(answer.contributors.unitKnownMicros,fixedTotal);samples.push(performance.now()-t);report.currentMeasurement={rows,changes,samplesMs:samples};persistVolume();}
 samples.sort((a,b)=>a-b);const tier={unrelatedRows:rows,targetChanges:changes,verifiedSeedCounts:counts,calls:10,samplesMs:samples,medianMs:(samples[4]+samples[5])/2,p95Ms:samples[9],maxMs:samples[9],lookupExplain};report.tiers.push(tier);delete report.currentMeasurement;persistVolume();console.log('CONTRIBUTORS_VOLUME',JSON.stringify(tier));
 previousRows=rows;previousChanges=changes;
}
report.status='passed';persistVolume();
`;
await runContributorProof(volume);
