// Execute original review fixture unchanged, with exact owned adapter bodies
// and extra full-JSON parity observations after actual public review reads.
// This proves the adapter seam across review scenarios, not complete0848 roles.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const path=new URL('./verify-work-unit-review.mjs',import.meta.url),original=readFileSync(path,'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'6e08a613c27beb6ac1f9c3cd2f98720dafcf3fbbfd11a3b029550114882b146d');
assert.equal(process.argv.length,2,'No upstream source regeneration is permitted');
const metadata=readFileSync(new URL('../supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql',import.meta.url),'utf8');
const bodies=['_work_unit_metadata_members','_work_unit_metadata_scope','_work_unit_metadata_review'].map(name=>{const a=metadata.indexOf('create function public.'+name+'(');assert.ok(a>0);const b=metadata.indexOf('\ncreate function ',a+1);assert.ok(b>a);return metadata.slice(a,b);}).join('\n')+'\nrevoke all on function _work_unit_metadata_members(uuid[]),_work_unit_metadata_scope(uuid,uuid,jsonb),_work_unit_metadata_review(uuid,jsonb) from public,anon,authenticated,service_role;';
const seam="console.log('Installed exact review candidate',hash(review));";assert.equal(original.split(seam).length,2);
let source=original.replace(seam,()=>seam+'\nawait db.exec('+JSON.stringify(bodies)+'); metadataAdaptersReady=true;');
const qseam='const wire=[];const db=';assert.equal(source.split(qseam).length,2);source=source.replace(qseam,'let metadataAdaptersReady=false,metadataParityReads=0;const wire=[];const db=');
const ret='return row;};';assert.equal(source.split(ret).length,2);
source=source.replace(ret,String.raw`
if(metadataAdaptersReady&&/select work_unit_review_read\(/.test(s)&&row?.value&&a[0]){
 const who=(await db.query('select current_user role,auth.uid() uid')).rows[0];
 await db.exec('reset role');
 try{
  if((await db.query('select _work_unit_review_coverage() ok')).rows[0].ok){
   const compared=(await db.query("with original as materialized(select _work_unit_review_scope($1,$2) s), shared as materialized(select _work_unit_metadata_scope($1,$2,_work_unit_metadata_members(array[$2::uuid])->($2::uuid)::text) s) select original.s is not distinct from shared.s scope_equal,_work_unit_review_view($1,original.s) is not distinct from _work_unit_metadata_review($1,shared.s) view_equal from original,shared",[who.uid,a[0]])).rows[0];
   assert.equal(compared.scope_equal,true,'Full ordered source/manifest/token parity after review read');assert.equal(compared.view_equal,true,'Full view/null refusal parity after review read');metadataParityReads++;
  }
 }finally{await db.exec('set role '+who.role);}
}
return row;};`);
const end="await db.exec('rollback');await db.close();";assert.equal(source.split(end).length,2);source=source.replace(end,"assert.ok(metadataParityReads>=30,'Bounded source-parity observations actually executed');console.log(JSON.stringify({metadataAdapterSha256:"+JSON.stringify(createHash('sha256').update(metadata).digest('hex'))+",fullScopeAndViewParityReads:metadataParityReads,scope:'Exact owned helper bodies across original review fixture; sequential PGlite only'}));"+end);
source=source.replaceAll('import.meta.url',JSON.stringify(path.href));
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
