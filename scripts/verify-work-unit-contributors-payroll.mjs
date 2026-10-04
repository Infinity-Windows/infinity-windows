// Preserve all original payroll assertions; install held read-only contributors first.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const path=new URL('./verify-work-activity-engine-schema-runtime.mjs',import.meta.url);
const original=readFileSync(path,'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'86805ad91e30e3d5164f9b8f1ce360c8a34bb9bea50cb5b446f28693ad02ce63');
const needle="check((await q('select not capture_enabled disabled from work_activity_authority_generation where singleton')).disabled,'Complete DDL leaves capture disabled');";
assert.equal(original.split(needle).length,2);
const addition="\nfor(const file of ['20261108440000_work_unit_review.sql','20261108450000_work_activity_totals.sql','20261108460000_work_unit_contributors.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8').replace(/rollback;\\s*$/,'commit;'));\n";
const source=original.replace(needle,needle+addition).replaceAll('import.meta.url',JSON.stringify(path.href));
console.log(JSON.stringify({fixtureSha256:createHash('sha256').update(original).digest('hex'),adaptation:'Only install held review, totals and contributors candidates before unchanged regression assertions'}));
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
