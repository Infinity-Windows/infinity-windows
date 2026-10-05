// Declared PG17 fixture profile simulated in PGlite. Never edits the genuine fixture.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
export const root=new URL('../',import.meta.url);
export const profile=JSON.parse(readFileSync(new URL('scripts/work-cross-job-profile.json',root),'utf8'));
export const once=(s,a,b)=>{assert.equal(s.split(a).length,2,a);return s.replace(a,()=>b)};
export const ownerSql='alter type public.clock_time_pick owner to supabase_admin;alter type public.crew_clock_result owner to supabase_admin;';
export const aclSql='revoke execute on function public._clock_pick_time_at(timestamptz,timestamptz,integer,timestamptz,timestamptz),public.work_activity_clock_receipt(uuid),public.work_activity_command_receipt(uuid),public.work_activity_unit_basis(uuid) from service_role;';
export const predecessorSql=()=>['20261108430000_work_activity_clock_capability.sql','20261108420000_work_activity_catalog.sql'].map(f=>readFileSync(new URL('supabase/migrations/'+f,root),'utf8'));
export function promoteTotalsSource(s,{historicalClock=false}={}){
 if(historicalClock){const historical=readFileSync(new URL('scripts/work-cross-job-historical-clock.sql',root),'utf8');s=once(s,"await db.exec(engine.slice(engine.indexOf('-- INSTALLED_SOURCE_GUARD:')",`await db.exec(${JSON.stringify(historical)});\nawait db.exec(engine.slice(engine.indexOf('-- INSTALLED_SOURCE_GUARD:')`)}
 s=once(s,'await db.exec(schema);',`await db.exec(schema);await db.exec(${JSON.stringify(ownerSql)});`);
 s=once(s,"await db.exec(review.replace(/rollback;\\s*$/,'commit;'));",`await db.exec(${JSON.stringify(aclSql)});await db.exec('alter default privileges for role postgres in schema public revoke execute on functions from service_role');\nfor(const sql of ${JSON.stringify(predecessorSql())})await db.exec(sql);await db.exec('alter default privileges for role postgres in schema public grant execute on functions to service_role');\nawait db.exec(review.replace(/rollback;\\s*$/,'commit;'));`);
 // Historical0845 coverage enumerated before0843 was included locally. Keep
 // that original verifier footprint; new full catalog independently pins843.
 s=once(s,"and proname<>'_work_totals_coverage' order by 1", "and proname<>'_work_totals_coverage' and proname<>'_work_activity_clock_contract_marker' order by 1");
 return s;
}
export function archiveCatalog(raw,digest){
 // raw is PostgreSQL jsonb::text. Never pass its integers through JS Number.
 return '{"environment":"Declared genuine PG17 fixture profile; PGlite simulation only","catalogSha256":'+JSON.stringify(digest)+',"canonicalCatalogText":'+JSON.stringify(raw)+',"metadata":'+raw+'}\n';
}
