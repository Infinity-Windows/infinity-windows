// Held, source-matched disposable proof. No provider or genuine concurrency claim.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),read=p=>readFileSync(new URL(p,root),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const baseline=read('scripts/verify-work-activity-totals.mjs');
assert.equal(hash(baseline),'5f806c9e162c50c2339de4e32eb17b2e1217a858842a7a8b44a6e6dce76821a4');
const {promoteTotalsSource,archiveCatalog,profile}=await import('./work-cross-job-profile.mjs');
const promoted=promoteTotalsSource(baseline,{historicalClock:true});
const prefix=promoted.slice(0,promoted.indexOf('const id=n=>')).replace("const root=new URL('../',import.meta.url)",`const root=new URL(${JSON.stringify(root.href)})`);
const {db,q}=await import('data:text/javascript;base64,'+Buffer.from(prefix+'\nexport {db,q};').toString('base64'));
const contributors=read('supabase/migrations/20261108460000_work_unit_contributors.sql');
assert.equal(hash(contributors),'ae6185e4b390b7cff8f3d7aca837688fda2756792bdf055ef8c3a1f290d438c5');
await db.exec(contributors.replace(/rollback;\s*$/,'commit;'));
assert.equal((await q('select _work_totals_coverage() and _work_unit_review_coverage() and _work_unit_contributors_coverage() ok')).ok,true);
const candidatePath=new URL('supabase/migrations/20261108470000_work_cross_job_capture.sql',root);
let candidate=readFileSync(candidatePath,'utf8');
const catalogSql=read('scripts/work-cross-job-catalog.sql').trim().replace(/;$/,'');
await db.exec('set search_path=public,pg_temp');
const oldCatalog=(await q(`select value::text raw from (${catalogSql}) c`)).raw;
const oldHash=(await q(`select encode(sha256(convert_to(v.value::text,'UTF8')),'hex') digest from (${catalogSql}) v`)).digest;
assert.equal(oldHash,profile.expectedOldCatalogSha256,'Declared source profile must match exactly');
if(process.argv.includes('--freeze-profile'))writeFileSync(new URL('scripts/work-cross-job-old-catalog.json',root),archiveCatalog(oldCatalog,oldHash));
if(process.argv.includes('--freeze-preflight')){
 assert.ok(candidate.includes('OLD_CATALOG_SHA256_PENDING'),'An existing source contract must never silently be refreshed');
 candidate=candidate.replace('OLD_CATALOG_SHA256_PENDING',oldHash).replace('-- OLD_CATALOG_QUERY',catalogSql);
 writeFileSync(candidatePath,candidate);
 writeFileSync(new URL('scripts/work-cross-job-old-catalog.json',root),archiveCatalog(oldCatalog,oldHash));
}
const preflight=candidate.slice(0,candidate.indexOf('-- CROSS_JOB_DDL_BEGIN'));
assert.ok(!/create\s+(?:or replace\s+)?(?:function|table|index|trigger)|alter\s+table|revoke\s|grant\s/i.test(preflight),'Preflight contains no DDL');
await db.exec(preflight+'rollback;');
let checks=1;
for(const mutation of ["create table work_cross_job_unknown(id int)","create function _work_cross_job_unknown() returns int language sql as 'select 1'","create function work_cross_job_command(text) returns int language sql as 'select 1'","grant execute on function _work_activity_resume(personal_activity_state,time_shifts,timestamptz) to authenticated","create index unknown_shift_index on time_shifts(profile_id)","alter table time_shifts disable trigger service_shift","grant select(profile_id) on personal_activity_state to authenticated"]){
 await db.exec('begin;'+mutation+';savepoint bad_source');let error;try{await db.exec(preflight.replace(/^.*?begin;/s,''));}catch(e){error=e;}
 assert.equal(error?.code,'55000',mutation);await db.exec('rollback to savepoint bad_source;rollback;');checks++;
}
const promotion=await import('./work-cross-job-promotion-fixtures.mjs');
const baselineWire=process.argv.includes('--freeze-coverage')?null:await promotion.beforeInstall(db,q,assert);
await db.exec(candidate.replace(/rollback;\s*$/,'commit;'));
const newCatalogSql=catalogSql;
const newHash=(await q(`select encode(sha256(convert_to(v.value::text,'UTF8')),'hex') digest from (${newCatalogSql}) v`)).digest;
if(process.argv.includes('--freeze-coverage')){
 const contractPath=new URL('scripts/work-cross-job-contract.json',root);const contract=JSON.parse(readFileSync(contractPath,'utf8'));
 assert.equal(contract.status,'PENDING_REVIEWED_REVISION_6_ASSEMBLY','Refresh requires an explicit source-contract review and pending marker');
 contract.status='FROZEN_REVIEWED_REVISION_6_ASSEMBLY';contract.expectedCatalogSha256=newHash;writeFileSync(contractPath,JSON.stringify(contract,null,2)+'\n');
 // Privileged bypass is test-construction ONLY, never migration/provider logic.
 await db.exec('alter table work_cross_job_contract disable trigger work_cross_job_contract_immutable');
 await db.query('update work_cross_job_contract set expected_catalog_sha256=$1',[newHash]);
 await db.exec('alter table work_cross_job_contract enable trigger work_cross_job_contract_immutable');
 const generated=spawnSync('python3',[fileURLToPath(new URL('scripts/build-work-cross-job-capture.py',root))],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 candidate=readFileSync(candidatePath,'utf8');
 writeFileSync(new URL('scripts/work-cross-job-new-catalog.json',root),archiveCatalog((await q(`select value::text raw from (${newCatalogSql}) c`)).raw,newHash));
}
assert.equal((await q('select _work_cross_job_coverage() and _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() ok')).ok,true,'All exact promoted guards match while v2 is inert');
for(const mutation of ["grant execute on function _work_cross_job_resume_basis(personal_activity_state,time_shifts,timestamptz) to authenticated","create index cross_job_unknown_idx on work_cross_job_bindings(profile_id)","alter table time_shifts disable trigger service_shift","grant select(profile_id) on work_cross_job_resume to authenticated"]){
 await db.exec('begin;'+mutation);assert.equal((await q('select _work_cross_job_coverage() or _work_totals_coverage() ok')).ok,false,mutation);await db.exec('rollback');checks++;
}
for(const mutation of ["create or replace function _work_cross_job_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select true$$","alter function _work_cross_job_coverage() cost 101","grant execute on function _work_cross_job_coverage() to authenticated","create or replace function _work_cross_job_table(p_kind text) returns text language sql immutable set search_path=public,pg_temp as $$select p_kind$$","alter function _work_cross_job_table(text) leakproof","create type cross_job_unreviewed_enum as enum('new')","create domain cross_job_unreviewed_domain as integer check(value>0)","alter sequence custom_work_history_id_seq increment by 3"]){
 await db.exec('begin;'+mutation);
 assert.equal((await q('select _work_unit_review_coverage() or _work_totals_coverage() or _work_unit_contributors_coverage() ok')).ok,false,'Every original report guard independently refuses '+mutation);
 await db.exec('rollback');checks++;
}
if(process.argv.includes('--freeze-only')){
 assert.ok(process.argv.includes('--freeze-coverage'),'Construction-only mode requires explicit coverage freeze');
 console.log(JSON.stringify({status:'CONTRACT_FROZEN_NOT_FUNCTIONAL_PROOF',checks,candidateSha256:hash(candidate),oldCatalogSha256:oldHash,newCatalogSha256:newHash}));
 await db.close();process.exit(0);
}
const promotionProof=await promotion.runPromotion(db,q,assert,catalogSql,baselineWire);
const {runRequestVersion}=await import('./work-cross-job-request-fixtures.mjs');const requestProof=await runRequestVersion(db,q,assert,catalogSql);
const {runFingerprint}=await import('./work-cross-job-fingerprint-fixtures.mjs');const fingerprintProof=await runFingerprint(db,q,assert,catalogSql);
if(process.argv.includes('--request-focus')){console.log(JSON.stringify({requestProof,fingerprintProof,promotionChecks:promotionProof.checks,guards:checks,fullFunctionalCorpus:false}));await db.close();process.exit(0)}
let functionalModule;
if(process.argv.includes('--sandbox-focus')){
 const full=readFileSync(new URL('./work-cross-job-fixtures.mjs',import.meta.url),'utf8');const start=full.indexOf(' await setup(id(10));\n const physical=');const end=full.indexOf(' // Checkpoint4 sandbox controls');assert.ok(start>0&&end>start);functionalModule=await import('data:text/javascript;base64,'+Buffer.from(full.slice(0,start)+full.slice(end)).toString('base64'));
}else functionalModule=await import('./work-cross-job-fixtures.mjs');
const functional=await functionalModule.run(db,q,assert,newCatalogSql);
if(process.env.WORK_CROSS_JOB_REPORT_OUT)writeFileSync(process.env.WORK_CROSS_JOB_REPORT_OUT,JSON.stringify({functional,promotionProof,requestProof,fingerprintProof,checks,oldCatalogSha256:oldHash,newCatalogSha256:newHash,candidateSha256:hash(candidate),activation:false,genuineRoles:false,genuineConcurrency:false},null,2)+'\n');
console.log(JSON.stringify({functional:{checks:functional.checks,scope:functional.scope,remaining:functional.remaining},status:'construction',checks,oldCatalogSha256:oldHash,candidateSha256:hash(candidate),activation:false,genuineRoles:false,genuineConcurrency:false}));
await db.close();
