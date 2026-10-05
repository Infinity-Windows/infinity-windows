// Execute the complete existing contributor+totals regression corpus against
// the NEW exact combined catalog, preserving every old file and assertion.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const originalUrl=new URL('./verify-work-unit-contributors.mjs',import.meta.url);
let source=readFileSync(originalUrl,'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'ad5b0b99222f29a8305c27a00f8d947662fd7fc94114fcd8f41fc16e8cab2d9a');
source=source.replace("const original=readFileSync(path,'utf8');","let original=readFileSync(path,'utf8');");
const originalPin="assert.equal(createHash('sha256').update(original).digest('hex'),'5f806c9e162c50c2339de4e32eb17b2e1217a858842a7a8b44a6e6dce76821a4');";
source=source.replace(originalPin,originalPin+`\noriginal=(await import(${JSON.stringify(new URL('./work-cross-job-profile.mjs',import.meta.url).href)})).promoteTotalsSource(original);`);
const seam='const contributorWire=[];';assert.equal(source.split(seam).length,2);
source=source.replace(seam,`await db.exec(read('supabase/migrations/20261108470000_work_cross_job_capture.sql').replace(/rollback;\\s*$/,'commit;'));\nassert.equal((await q('select _work_cross_job_coverage() and _work_totals_coverage() and _work_unit_review_coverage() and _work_unit_contributors_coverage() ok')).ok,true,'Exact combined guards retain v1 availability');\n${seam}`);
source=source.replace("const path=new URL('./verify-work-activity-totals.mjs',import.meta.url);",`const path=new URL(${JSON.stringify(new URL('./verify-work-activity-totals.mjs',import.meta.url).href)});`);
const {runContributorProof}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
await runContributorProof();
console.log('HELD_CROSS_JOB_V1_REGRESSION',JSON.stringify({sourceSha256:createHash('sha256').update(readFileSync(originalUrl)).digest('hex'),injectedCandidate:true,oldAssertionsPreserved:true,genuineRoleProof:false}));
