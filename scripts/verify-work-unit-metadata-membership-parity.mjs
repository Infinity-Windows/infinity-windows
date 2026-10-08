// Compare the held source with the frozen cb6 membership algorithm and original 0844 review scenarios.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const originalPath=new URL('scripts/verify-work-unit-review.mjs',root);
let original=readFileSync(originalPath,'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'6e08a613c27beb6ac1f9c3cd2f98720dafcf3fbbfd11a3b029550114882b146d');
assert.equal(process.argv.length,2,'Frozen parent source must not be regenerated');
const metadata=readFileSync(new URL('supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql',root),'utf8');
const membershipReferenceBody=String.raw`
 with versions as materialized (
 select source_kind kind,source_id,b.value from public.work_activity_source_history h cross join lateral(values(h.before_value),(h.after_value)) b(value) where b.value<>'{}'
 union all select case e.source_kind when 'custom' then 'custom_work_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'service' then 'service_time_sessions' when 'phase' then 'opening_phases' when 'helper' then 'summon_helpers' end,e.source_id::text,b.value
 from public.personal_activity_transition_sources e cross join lateral(values(e.before_evidence),(e.after_evidence))b(value) where e.source_kind in ('custom','unit','task','service','phase','helper') and b.value<>'{}'
 union all select kind,source_id,value from public._work_unit_review_live_sources
 ), units as materialized(select u.id uid,u.opening_id from public.custom_work_units u where u.id=any(p_units)),
 roots as materialized(select u.uid,v.value from units u join versions v on v.kind='custom_work_units' and v.source_id=u.uid::text),
 mapped as materialized(select uid,value->>'opening_id' id from roots where value->>'opening_id' is not null union select uid,opening_id::text from units where opening_id is not null),
 windows as materialized(select distinct m.uid,v.value->>'assigned_window_id' id from mapped m join versions v on v.kind='project_openings' and v.source_id=m.id),
 service_units as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='service_visit_units' and v.value->>'work_unit_id'=u.uid::text
 union select m.uid,v.source_id from mapped m join versions v on v.kind='service_visit_units' and v.value->>'opening_id'=m.id
 union select w.uid,v.source_id from windows w join versions v on v.kind='service_visit_units' and v.value->>'window_id'=w.id),
 summons_for_unit as materialized(select distinct m.uid,v.source_id id from mapped m join versions v on v.kind='summons' and v.value->>'opening_id'=m.id),
 crew as materialized(select distinct u.uid,v.source_id id from units u join versions v on v.kind='crew_work_records' and v.value->>'unit_id'=u.uid::text),
 custom_sessions as materialized(
 select u.uid,v.source_id id from units u join versions v on v.kind='custom_work_sessions' and v.value->>'unit_id'=u.uid::text
 union select u.uid,v.value->>'session_id' from units u join versions v on v.kind='work_session_capture_metadata' and v.value->>'unit_id'=u.uid::text),
 visits as materialized(select distinct su.uid,v.value->>'visit_id' id from service_units su join versions v on v.kind='service_visit_units' and v.source_id=su.id),
 selected as materialized(
 select u.uid,v.kind,v.source_id from units u join versions v on v.kind='custom_work_units' and v.source_id=u.uid::text
 union select m.uid,v.kind,v.source_id from mapped m join versions v on v.kind='project_openings' and v.source_id=m.id
 union select m.uid,v.kind,v.source_id from mapped m join versions v on v.kind in('unit_sessions','task_sessions','opening_phases','unit_redos') and v.value->>'opening_id'=m.id
 union select m.uid,v.kind,v.source_id from mapped m join versions v on v.kind in('qc_checks','install_events') and v.value->>'project_opening_id'=m.id
 union select c.uid,v.kind,v.source_id from custom_sessions c join versions v on v.kind='custom_work_sessions' and v.source_id=c.id
 union select su.uid,v.kind,v.source_id from service_units su join versions v on v.kind='service_visit_units' and v.source_id=su.id
 union select su.uid,v.kind,v.source_id from service_units su join versions v on v.kind='service_time_sessions' and v.value->>'unit_id'=su.id
 union select vi.uid,v.kind,v.source_id from visits vi join versions v on v.kind='service_visits' and v.source_id=vi.id
 union select sm.uid,v.kind,v.source_id from summons_for_unit sm join versions v on v.kind='summons' and v.source_id=sm.id
 union select sm.uid,v.kind,v.source_id from summons_for_unit sm join versions v on v.kind='summon_helpers' and v.value->>'summon_id'=sm.id
 union select c.uid,v.kind,v.source_id from crew c join versions v on v.kind='crew_work_records' and v.source_id=c.id
 union select c.uid,v.kind,v.source_id from crew c join versions v on v.kind='crew_work_record_people' and v.value->>'record_id'=c.id
 union select u.uid,v.kind,v.source_id from units u join versions v on v.kind='work_session_capture_metadata' and v.value->>'unit_id'=u.uid::text
 union select c.uid,v.kind,v.source_id from custom_sessions c join versions v on v.kind='work_session_capture_metadata' and v.source_id=c.id
 union select c.uid,v.kind,v.source_id from custom_sessions c join versions v on v.kind='custom_work_history' and v.value->>'entity_id'=c.id
 union select u.uid,v.kind,v.source_id from units u join versions v on v.kind='custom_work_history' and v.value->>'entity_id'=u.uid::text
 and (v.value->>'action' not in('unit','link') or v.value#>'{before_value,facts,installation_complete}' is distinct from v.value#>'{after_value,facts,installation_complete}')
 ), grouped as(select u.uid,coalesce(jsonb_agg(jsonb_build_object('kind',s.kind,'id',s.source_id) order by s.kind,s.source_id) filter(where s.source_id is not null),'[]') sources
 from units u left join selected s on s.uid=u.uid group by u.uid)
 select case when (select count(*) from selected)>200000 or (select count(distinct(kind,source_id)) from selected)>20000 then null
 else coalesce(jsonb_object_agg(uid::text,sources),'{}') end from grouped
`;
assert.equal(createHash('sha256').update(membershipReferenceBody).digest('hex'),'ecccbdd660ed6b0ca2582b4e607b4447ed2f480ba8424c8e07baa8121cc697fc');
const referenceSql='create function pg_temp.metadata_members_reference(p_units uuid[]) returns jsonb language sql stable set search_path=public,pg_temp as $$'+membershipReferenceBody+'$$;revoke all on function pg_temp.metadata_members_reference(uuid[]) from public,anon,authenticated,service_role;';
const bodies=['_work_unit_metadata_members','_work_unit_metadata_live','_work_unit_metadata_scope','_work_unit_metadata_review'].map(name=>{const a=metadata.indexOf('create function public.'+name+'('),b=metadata.indexOf('\ncreate function ',a+1);assert.ok(a>0&&b>a);return metadata.slice(a,b);}).join('\n')+'\nrevoke all on function public._work_unit_metadata_members(uuid[]),public._work_unit_metadata_live(jsonb),public._work_unit_metadata_scope(uuid,uuid,jsonb),public._work_unit_metadata_review(uuid,jsonb) from public,anon,authenticated,service_role;\n'+referenceSql;
const seam="console.log('Installed exact review candidate',hash(review));";
assert.equal(original.split(seam).length,2);
original=original.replace(seam,()=>seam+'\nawait db.exec('+JSON.stringify(bodies)+'); membershipReady=true;');
original=original.replace('const wire=[];const db=','let membershipReady=false,membershipParityReads=0;const wire=[];const db=');
const ret='return row;};';assert.equal(original.split(ret).length,2);
original=original.replace(ret,String.raw`
if(membershipReady&&/select work_unit_review_read\(/.test(s)&&row?.value&&a[0]){
 const who=(await db.query('select current_user role,auth.uid() uid')).rows[0];await db.exec('reset role');
 try{if((await db.query('select _work_unit_review_coverage() ok')).rows[0].ok){
  const compared=(await db.query("with old as materialized(select pg_temp.metadata_members_reference(array[$2::uuid]) m), new as materialized(select _work_unit_metadata_members(array[$2::uuid]) m), original as materialized(select _work_unit_review_scope($1,$2) s), shared as materialized(select _work_unit_metadata_scope($1,$2,new.m->($2::uuid)::text) s from new) select old.m is not distinct from new.m members_equal, original.s is not distinct from shared.s scope_equal,_work_unit_review_view($1,original.s) is not distinct from _work_unit_metadata_review($1,shared.s) view_equal from old,new,original,shared",[who.uid,a[0]])).rows[0];
  assert.deepEqual(compared,{members_equal:true,scope_equal:true,view_equal:true},'Exact membership, ordered scope, original/current authority and final view parity');membershipParityReads++;
 }}finally{await db.exec('set role '+who.role);}
}
return row;};`);
const end="await db.exec('rollback');await db.close();";assert.equal(original.split(end).length,2);
original=original.replace(end,"assert.equal(membershipParityReads,168);console.log(JSON.stringify({metadataSourceSha256:"+JSON.stringify(createHash('sha256').update(metadata).digest('hex'))+",membershipParityReads,scope:'Frozen cb6 membership plus unchanged original review scenarios; full ordered membership / scope / view equality, sequential PGlite only'}));"+end);
original=original.replaceAll('import.meta.url',JSON.stringify(originalPath.href));
await import('data:text/javascript;base64,'+Buffer.from(original).toString('base64'));
