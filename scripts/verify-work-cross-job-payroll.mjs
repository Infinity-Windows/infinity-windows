// Retain all original payroll assertions. This does not claim genuine PG roles.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const path=new URL('./verify-work-activity-engine-schema-runtime.mjs',import.meta.url);
const original=readFileSync(path,'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'86805ad91e30e3d5164f9b8f1ce360c8a34bb9bea50cb5b446f28693ad02ce63');
const needle="check((await q('select not capture_enabled disabled from work_activity_authority_generation where singleton')).disabled,'Complete DDL leaves capture disabled');";
assert.equal(original.split(needle).length,2);
const addition="\nfor(const file of ['20261108440000_work_unit_review.sql','20261108450000_work_activity_totals.sql','20261108460000_work_unit_contributors.sql','20261108470000_work_cross_job_capture.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8').replace(/rollback;\\s*$/,'commit;'));\n";
let source=original.replace(needle,needle+addition);
source=source.replace('await db.exec(schema);',"await db.exec(schema);await db.exec('alter default privileges for role postgres in schema public grant execute on functions to service_role');");
source=source.replaceAll('import.meta.url',JSON.stringify(path.href));
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
