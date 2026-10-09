// Bounded disposable PGlite volume probe; loaded only by the matched fixture.
// Timing here includes PGlite transport. Genuine logins/waits require PG17.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
export async function runVolume({db,as,id,readView,command,sourceSha256,sourceSql,output}) {
 const sql=async(s,a=[]) => (await db.query(s,a)).rows[0];
 const stats=xs=>{const x=[...xs].sort((a,b)=>a-b);return {samples:x.length,medianMs:x[Math.floor(x.length/2)],p95Ms:x[Math.ceil(x.length*.95)-1],maxMs:x.at(-1)}};
 const closureSql=sourceSql.match(/with versions as materialized \([\s\S]*?into sourceids from selected;/)[0].replace('into sourceids ','').replaceAll('u.id','$1::uuid').replaceAll('u.opening_id','$2::uuid');
 const report={sourceSha256,scope:'Disposable source-matched sequential PGlite; SET ROLE is not a genuine login or a concurrency proof',tiers:[]};
 await as(id(2),'postgres');await db.exec('savepoint volume_probe');
 try {
  await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'VOLUME-FORMER'),($3,$2,'VOLUME-UNRELATED')",[id(91001),id(11),id(91002)]);
  await db.query("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values($1,$2,'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',0)",[id(91000),id(91001)]);
  await db.query('update opening_phases set opening_id=$1 where id=$2',[id(21),id(91000)]);
  await as(id(2));const isolated=await readView(30);let previousRows=0,previousMutations=0;
  for(const [unrelatedRows,targetMutations] of [[0,0],[1000,100],[10000,1000]]) {
   await as(id(2),'postgres');const seedStart=performance.now();
   // Two immutable rows per unrelated, deleted source: birth then tombstone.
   // These are direct synthetic history seeds, not operational production writes.
   await db.query(`with sources as(select g,md5('volume-source-'||g)::uuid sid,md5('volume-birth-'||g)::uuid birth,md5('volume-delete-'||g)::uuid death,
    jsonb_build_object('id',md5('volume-source-'||g)::uuid,'opening_id',$3::uuid,'kind','flashing','status','submitted','started_by',null,'started_at','2026-01-01T10:00:00Z','submitted_at','2026-01-01T11:00:00Z','minutes',60) material
    from generate_series($1::int/2+1,$2::int/2) g)
    insert into work_activity_source_history(id,source_kind,source_id,predecessor_id,transaction_id,tx_order,before_value,after_value)
    select birth,'opening_phases',sid::text,null,pg_current_xact_id(),g*2,'{}',material from sources
    union all select death,'opening_phases',sid::text,birth,pg_current_xact_id(),g*2+1,material,'{}' from sources`,[previousRows,unrelatedRows,id(91002)]);
   for(let n=previousMutations+1;n<=targetMutations;n++)await db.query('update opening_phases set minutes=$1 where id=$2',[n,id(91000)]);
   const seedMs=performance.now()-seedStart;previousRows=unrelatedRows;previousMutations=targetMutations;
   await as(id(2));const target=await readView(31);assert.equal(target.review.qc.lifecycle,'proven');
   assert.equal((await readView(30)).review.basis.scopeToken,isolated.review.basis.scopeToken,'Unrelated token unchanged at volume');
   assert.equal((await readView(30)).review.qc.qcAccepted,isolated.review.qc.qcAccepted,'Unrelated acceptance unchanged at volume');
   const times={read:[],command:[],receipt:[]};let last;
   for(let n=0;n<20;n++) {
    let stamp=performance.now();await readView(31);times.read.push(performance.now()-stamp);
    const basis=(await readView(31)).review.basis;stamp=performance.now();last=await command('submit',{note:null},31,basis);times.command.push(performance.now()-stamp);
    stamp=performance.now();const receipt=await sql('select work_unit_review_command_receipt($1) value',[last.cid]);times.receipt.push(performance.now()-stamp);assert.equal(receipt.value.availability,'available');
   }
   await command('pass',{note:null},31);assert.equal((await readView(31)).review.qc.qcAccepted,true);
   await as(id(2),'postgres');await db.exec('savepoint volume_hidden');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(11)]);
   await as(id(2));assert.equal((await readView(31)).availability,'unavailable','Hidden former binding refuses at volume');
   await as(id(2),'postgres');await db.exec('rollback to savepoint volume_hidden');
   const explain=(await db.query('explain (analyze,buffers,format json) select _work_unit_review_scope($1,$2)',[id(2),id(31)])).rows[0]['QUERY PLAN'];
   const closureExplain=(await db.query('explain (analyze,buffers,format json) '+closureSql,[id(31),id(21)])).rows[0]['QUERY PLAN'];
   const entry={unrelatedRows,targetMutations,seedMs,read:stats(times.read),command:stats(times.command),receipt:stats(times.receipt),explain,closureExplain,unrelatedIsolation:true,hiddenFormerBindingRefused:true};
   report.tiers.push(entry);writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({volumeTier:{...entry,closureExplain:'Retained in JSON artifact'}}));
  }
 } finally {await as(id(2),'postgres');await db.exec('rollback to savepoint volume_probe');}
 return report;
}
