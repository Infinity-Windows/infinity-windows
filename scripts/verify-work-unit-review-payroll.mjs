// Run the unchanged source-matched complete payroll regression with review
// installed before any fixture calls. No provider connection or SQL adaptation.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const path=new URL('./verify-work-activity-engine-schema-runtime.mjs',import.meta.url);
const original=readFileSync(path,'utf8');
const needle="check((await q('select not capture_enabled disabled from work_activity_authority_generation where singleton')).disabled,'Complete DDL leaves capture disabled');";
assert.equal(original.split(needle).length,2,'Exact existing installation seam required');
const addition="\nawait db.exec(readFileSync(new URL('../supabase/migrations/20261108440000_work_unit_review.sql',import.meta.url),'utf8').replace(/rollback;\\s*$/,'commit;'));\n";
const source=original.replace(needle,needle+addition).replaceAll('import.meta.url',JSON.stringify(path.href));
console.log(JSON.stringify({fixtureSha256:createHash('sha256').update(original).digest('hex'),adaptation:'Only install held review candidate after actual cutover and before original regression assertions'}));
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
