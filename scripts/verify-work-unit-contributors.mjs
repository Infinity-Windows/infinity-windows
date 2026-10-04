// Additive source-matched contributor proof. Prior fixture bytes are never edited.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export async function runContributorProof(extraChecks=''){
const path=new URL('./verify-work-activity-totals.mjs',import.meta.url);
const original=readFileSync(path,'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'5f806c9e162c50c2339de4e32eb17b2e1217a858842a7a8b44a6e6dce76821a4');
const seam='const id=n=>';assert.equal(original.split(seam).length,2);
const install=String.raw`
let contributors=read('supabase/migrations/20261108460000_work_unit_contributors.sql');
assert.equal(hash(totals),'e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140');
const namespacePreflight=contributors.slice(contributors.indexOf('do $namespace$'),contributors.indexOf('end $namespace$;')+'end $namespace$;'.length);
for(const ddl of ["create function work_unit_contributors_read(text) returns int language sql as 'select 1'", "create function _work_unit_contributors_unknown() returns int language sql as 'select 1'",'create table _work_unit_contributors_unknown(id int)']){
 await db.exec('begin;'+ddl+';savepoint refused_namespace');let err=null;try{await db.exec(namespacePreflight);}catch(e){err=e.code;}
 assert.equal(err,'55000','First metadata-only namespace preflight refuses '+ddl);await db.exec('rollback to savepoint refused_namespace');await db.exec('rollback');
}
await db.exec(contributors.replace(/rollback;\s*$/,'commit;'));
assert.equal((await q('select _work_totals_coverage() and _work_unit_review_coverage() ok')).ok,true,'Additive migration preserves frozen coverage');
const contributorFunctions=[...new Set([...watchedFunctions,'_work_totals_coverage','_work_unit_review_scope','_work_unit_review_view','_work_unit_review_authority','_work_unit_review_defect_projection','_ai_job_visible','service_job_access','_work_unit_fact_context_visible','_is_supervisor','is_test_profile','is_sandbox_project','is_partner_user','custom_work_internal','person_record_counts','_work_unit_contributors_shift','_work_unit_contributors_person','work_unit_contributors_read'])].sort();
const contributorTables=[...new Set([...watchedTables,'profiles','projects','sandbox_projects','work_job_management_grants'])];
let contributorCatalogQuery=catalogQuery
 .replaceAll(sqlArray([...watchedFunctions,'_work_totals_coverage']),sqlArray([...contributorFunctions,'_work_unit_contributors_coverage']))
 .replaceAll(sqlArray(watchedFunctions),sqlArray(contributorFunctions))
 .replaceAll(sqlArray([...watchedTables,'_work_unit_review_live_sources']),sqlArray([...contributorTables,'_work_unit_review_live_sources']))
 .replaceAll(sqlArray(watchedTables),sqlArray(contributorTables))
 .replace("select jsonb_build_object(","select jsonb_build_object('namespaceRelations',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and starts_with(c.relname,'_work_unit_contributors_')),'namespace',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid)) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname='work_unit_contributors_read' or starts_with(p.proname,'_work_unit_contributors_'))),");
contributorCatalogQuery=contributorCatalogQuery.replace("'body',encode(","'language',(select lanname from pg_language where oid=p.prolang),'kind',p.prokind,'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'strict',p.proisstrict,'parallel',p.proparallel,'body',encode(");
const contributorCatalog=(await q(contributorCatalogQuery)).value;
const contributorDigest=(await q('select encode(sha256(convert_to(c.value::text,\'UTF8\')),\'hex\') digest from ('+contributorCatalogQuery+') c')).digest;
const contributorContract='create function public._work_unit_contributors_coverage() returns boolean\nlanguage sql stable security definer set search_path=public,pg_temp as $coverage$\n select encode(sha256(convert_to(c.value::text,\'UTF8\')),\'hex\')=\''+contributorDigest+'\' from ('+contributorCatalogQuery+') c\n$coverage$;\nrevoke all on function public._work_unit_contributors_coverage() from public,anon,authenticated,service_role;\n';
if(process.argv.includes('--build-contributor-coverage')){
 contributors=contributors.replace(/-- CONTRIBUTORS_COVERAGE_BEGIN[\s\S]*?-- CONTRIBUTORS_COVERAGE_END/,'-- CONTRIBUTORS_COVERAGE_BEGIN\n'+contributorContract+'-- CONTRIBUTORS_COVERAGE_END');
 writeFileSync(new URL('supabase/migrations/20261108460000_work_unit_contributors.sql',root),contributors);
 // Disposable replacement of the just-created candidate guard only.
 await db.exec(contributorContract.replace('create function','create or replace function'));
}else assert.ok(contributors.includes(contributorContract),'Contributor coverage drift requires explicit source review');
assert.equal((await q('select _work_unit_contributors_coverage() ok')).ok,true);
if(process.env.WORK_UNIT_CONTRIBUTORS_CATALOG_OUT)writeFileSync(process.env.WORK_UNIT_CONTRIBUTORS_CATALOG_OUT,JSON.stringify({contributorsSha256:hash(contributors),totalsSha256:hash(totals),catalogSqlDigest:contributorDigest,catalogQuery:contributorCatalogQuery,metadata:contributorCatalog},null,2)+'\n');
const contributorWire=[];
`;
const checks=String.raw`
await as(id(2));
const readContributors=async()=>{const request={projectId:id(10),unitId:id(30),protocolVersion:1};const reply=(await q('select work_unit_contributors_read($1,$2,1) value',[request.projectId,request.unitId])).value;contributorWire.push({request,reply});return reply;};
let contribution=await readContributors();
check(contribution.availability==='available','Contributors authorized read available after frozen review view admission');
check(contribution.contributors.unitKnownMicros===fixedTotal,'Same source assembly preserves exact selected-unit positive labor');
check(contribution.contributors.people.length===1&&contribution.contributors.people[0].profileId===id(1),'Timed contribution grouped by recorded UUID');
check(contribution.contributors.people[0].activities.reduce((n,a)=>n+BigInt(a.knownMicros),0n)===BigInt(fixedTotal),'Person task sum equals unit sum');
check(contribution.contributors.untimedParticipants.some(p=>p.profileId===id(2))&&contribution.contributors.completenessReasons.includes('named_unlinked'),'Quality review participation is separately named without invented timer');
check(contribution.contributors.people[0].share.state==='unavailable','Named work with no causal timer link withholds definitive whole share');
await as(id(2),'postgres');
const at=(await q('select clock_timestamp() at')).at;
const priorLedger=(await q('select _work_totals_shift($1,$2,$3::timestamptz) v',[id(2),shift.id,at])).v;
const copiedLedger=(await q('select _work_unit_contributors_shift($1,$2,$3::timestamptz) v',[id(2),shift.id,at])).v;
const {proofCache:copiedProofCache,...copiedPublicLedger}=copiedLedger;
const projected={...copiedPublicLedger,claims:copiedLedger.claims.filter(c=>BigInt(c.microseconds)>0n).map(({intervalId,shiftId,sourceId,startedAt,endedAt,unitIncarnation,...c})=>c)};
assert.deepEqual(projected,priorLedger);
const cachedLedger=(await q('select _work_unit_contributors_shift($1,$2,$3::timestamptz,$4::jsonb) v',[id(2),shift.id,at,JSON.stringify(copiedProofCache)])).v;assert.deepEqual(cachedLedger,copiedLedger);
const wrongActorCache={...copiedProofCache,actorId:id(3)};const freshLedger=(await q('select _work_unit_contributors_shift($1,$2,$3::timestamptz,$4::jsonb) v',[id(2),shift.id,at,JSON.stringify(wrongActorCache)])).v;assert.deepEqual(freshLedger,copiedLedger);check(true,'Copied positive ledger exactly matches frozen validator at one asOf');
check((await q('select _work_totals_coverage() and _work_unit_review_coverage() and _work_unit_contributors_coverage() ok')).ok,'All three exact guards remain valid after contributor reads');

await as(id(2),'postgres');await db.exec('savepoint zero_scenario');await as(id(2));
const zeroUnit=id(9900);
await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(9901),JSON.stringify({id:zeroUnit,revision:0,project_id:id(10),opening_id:null,label:'Zero audit unit',type_label:'Window',facts:{},dimension_observation:{width:36,height:48,unit:'in',source:'estimated'},expected_fact_revision:0})]);
const emptyReply=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),zeroUnit])).value;
contributorWire.push({label:'complete_empty_zero',request:{projectId:id(10),unitId:zeroUnit,protocolVersion:1},reply:emptyReply});
check(emptyReply.contributors.unitComplete&&emptyReply.contributors.unitKnownMicros==='0'&&emptyReply.contributors.participantCounts.total===0,'Proven empty unit is zero without a invented contributor');
await as(id(3));await q("select to_jsonb(sign_toolbox_talk($1,$2,null::uuid,'Synthetic signature',null::text,null::text,'Synthetic contributor fixture',clock_timestamp())) value",[id(9902),id(3)]);
const zeroShift=(await q("select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1)) value",[id(10),id(9903)])).value;
let zeroSequence=0,zeroHead=null;
async function zeroCommand(action,tap=null){const snapshot=(await q('select work_activity_snapshot($1) value',[id(9904)])).value;const now=new Date().toISOString();const commandId=id(9920+zeroSequence);const payload={deviceId:id(9904),clientGeneration:id(9905),clientSequence:zeroSequence,predecessorCommandId:zeroHead,expectedRevision:snapshot.state.revision,basis:{observationId:snapshot.observation.id},shiftRef:snapshot.observation.shiftRef,tappedAt:tap??now,clockCheckedAt:now,clockSkewMs:0,intent:action};const answer=(await q('select work_activity_command($1,1,$2::jsonb) value',[commandId,JSON.stringify(payload)])).value;assert.ok(['applied','noop'].includes(answer.receipt.status),JSON.stringify(answer));zeroSequence++;zeroHead=commandId;return answer;}
await zeroCommand({kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null});
await zeroCommand({kind:'finish_setup',projectId:id(10),costCodeId:null});
const zeroBasis=(await q('select work_activity_unit_basis($1) value',[zeroUnit])).value.unit;
const zeroCommandBasis={id:zeroBasis.id,operationalRevision:zeroBasis.operationalRevision,incarnationEpoch:zeroBasis.incarnationEpoch,bindingEpoch:zeroBasis.bindingEpoch,projectEpoch:zeroBasis.projectEpoch,openingEpoch:zeroBasis.openingEpoch,factId:zeroBasis.fact.id,factRevision:zeroBasis.fact.revision,originProjectEpoch:zeroBasis.fact.originProjectEpoch,originOpeningEpoch:zeroBasis.fact.originOpeningEpoch};
const zeroStart=await zeroCommand({...intent('specific'),unit:zeroCommandBasis});
await as(id(3),'postgres');
const negativeLedger=(await q("select _work_unit_contributors_shift($1,$2,$3::timestamptz-interval '1 microsecond') value",[id(3),zeroShift.id,zeroStart.receipt.effectiveAt])).value;
check(!negativeLedger.proven&&negativeLedger.claims.length===0&&negativeLedger.issues.includes('negative_interval'),'Negative private validation interval is unproven and contributes no claim');
await as(id(3));await zeroCommand(intent('general'),zeroStart.receipt.effectiveAt);
await as(id(2));const openZero=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),zeroUnit])).value;
contributorWire.push({label:'open_shift_zero_not_a_proven_tap',request:{projectId:id(10),unitId:zeroUnit,protocolVersion:1},reply:openZero});
check(openZero.contributors.zeroOnly.length===0&&openZero.contributors.people.length===1&&openZero.contributors.people[0].measurementState==='unproven'&&openZero.contributors.people[0].activities.length===0&&!openZero.contributors.people[0].includesLive&&!openZero.contributors.people[0].complete,'Open-shift zero evidence stays uncertain rather than false zero-only audit');
check(openZero.contributors.completenessReasons.includes('open_shift')&&!openZero.contributors.unitComplete&&openZero.contributors.participantCounts.timingUncertain===1,'Open-shift zero has fixed reason and no definitive share');
await as(id(3));
await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text)) value',[zeroShift.id]);
await as(id(2));const zeroReply=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),zeroUnit])).value;
contributorWire.push({label:'proven_zero_only_tap',request:{projectId:id(10),unitId:zeroUnit,protocolVersion:1},reply:zeroReply});
check(zeroReply.contributors.unitKnownMicros==='0'&&zeroReply.contributors.people.length===0&&zeroReply.contributors.zeroOnly.length===1&&zeroReply.contributors.participantCounts.total===0,'Actual zero-length captured tap is audit only, never a worked/timed contributor');
check(zeroReply.contributors.zeroOnly[0].measurementState==='recorded_zero'&&zeroReply.contributors.zeroOnly[0].share.state==='unavailable','Zero proof reaches capture/identity validation and yields no percentage');
await as(id(2),'postgres');await db.exec('rollback to savepoint zero_scenario');
async function contributorControl(label,mutate,accept,unitId=id(30)){
 await as(id(2),'postgres');await db.exec('savepoint contributor_control');await mutate();await as(id(2));
 const request={projectId:id(10),unitId,protocolVersion:1},reply=(await q('select work_unit_contributors_read($1,$2,1) value',[request.projectId,unitId])).value;
 if(!accept(reply))console.log('CONTRIBUTOR_CONTROL',label,JSON.stringify(reply));check(accept(reply),label);
 contributorWire.push({label,request,reply});await as(id(2),'postgres');await db.exec('rollback to savepoint contributor_control');
}
await as(id(2),'postgres');await db.exec('savepoint foreman_names');await db.query("update profiles set role='supervisor' where id=$1",[id(3)]);await as(id(3));
const foremanNames=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
check(foremanNames.availability==='available'&&foremanNames.contributors.people[0].profileId===id(1),'Current authorized supervisor receives labor attribution without finalQC grant');
contributorWire.push({label:'supervisor_without_final_qc',request:{projectId:id(10),unitId:id(30),protocolVersion:1},reply:foremanNames});
await as(id(2),'postgres');await db.exec('rollback to savepoint foreman_names');
const concealed=v=>JSON.stringify(v)===JSON.stringify({availability:'unavailable',contributors:null,protocolVersion:1});
await contributorControl('Hidden selected job discloses no contributor UUID/name/count',()=>db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(10)]),concealed);
await contributorControl('Deleted selected unit is generic unavailable',()=>db.query('delete from custom_work_units where id=$1',[id(30)]),concealed);
await contributorControl('Renamed stable identity preserves exact labor and UUID',()=>db.query("update profiles set display_name='Renamed worker' where id=$1",[id(1)]),v=>v.contributors.people[0].profileId===id(1)&&v.contributors.people[0].displayName==='Renamed worker'&&v.contributors.unitKnownMicros===fixedTotal);
await contributorControl('Retired worker remains in historical attribution',()=>db.query('update profiles set retired_at=clock_timestamp() where id=$1',[id(1)]),v=>v.contributors.people[0].retired&&v.contributors.unitKnownMicros===fixedTotal);
await contributorControl('Unicode name fits exact500 UTF16 wire bound',()=>db.query("update profiles set display_name=repeat('😀',250) where id=$1",[id(1)]),v=>v.availability==='available'&&v.contributors.people[0].displayName.length===500);
await contributorControl('Overlong UTF16 name refuses rather than emitting malformed wire',()=>db.query("update profiles set display_name=repeat('😀',251) where id=$1",[id(1)]),concealed);
await contributorControl('Blank existing name is unavailable without inventing missing identity',()=>db.query("update profiles set display_name='  ' where id=$1",[id(1)]),v=>v.contributors.people[0].nameState==='unavailable'&&v.contributors.people[0].displayName===null&&v.contributors.people[0].retired===false);
await contributorControl('Captured source A-to-B-to-A does not revive accepted elapsed',async()=>{await db.query("update custom_work_sessions set ended_at=ended_at-interval '1 microsecond' where unit_id=$1",[id(30)]);await db.query("update custom_work_sessions set ended_at=ended_at+interval '1 microsecond' where unit_id=$1",[id(30)]);},v=>v.availability==='available'&&!v.contributors.unitComplete&&v.contributors.unitKnownMicros==='0'&&v.contributors.people.some(p=>p.measurementState==='unproven'));
await contributorControl('Source capture bypass makes attribution partial',async()=>{await db.exec('alter table custom_work_sessions disable trigger zz_work_activity_row');await db.query("update custom_work_sessions set ended_at=ended_at-interval '1 microsecond' where unit_id=$1",[id(30)]);await db.exec('alter table custom_work_sessions enable trigger zz_work_activity_row');},v=>!v.contributors.unitComplete&&v.contributors.completenessReasons.includes('source_unproven')&&v.contributors.people.every(p=>p.share.state==='unavailable'));
await contributorControl('Hidden edited payroll origin refuses before name disclosure',async()=>{await as(id(2));await q('select to_jsonb(edit_shift($1,$2,null,null,null,null,$3)) value',[shift.id,id(11),'Synthetic hidden origin']);await as(id(2),'postgres');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(11)]);},concealed);

await contributorControl('Future named timestamp cannot assert work after this reply asOf',()=>db.query("insert into opening_phases(id,opening_id,kind,status,started_by,started_at,submitted_at,minutes) values($1,$2,'flashing','submitted',$3,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours',60)",[id(16010),id(20),id(3)]),v=>v.availability==='available'&&!v.contributors.unitComplete&&v.contributors.completenessReasons.includes('source_unproven')&&!v.contributors.untimedParticipants.some(p=>p.profileId===id(3)));
await contributorControl('Unmapped legacy timer remains unknown rather than recorded zero',()=>db.query("insert into unit_sessions(id,opening_id,profile_id,started_at,ended_at) values($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[id(10040),id(20),id(3)]),v=>!v.contributors.unitComplete&&v.contributors.completenessReasons.includes('legacy_unmapped')&&v.contributors.people.some(p=>p.profileId===id(3)&&p.measurementState==='unproven'&&p.knownMicros==='0')&&v.contributors.zeroOnly.length===0);
await contributorControl('Legacy helper timer has uncertain subject without assigning requester labor',async()=>{await db.query('insert into summons(id,project_id,opening_id,requested_by,needed) values($1,$2,$3,$4,1)',[id(16002),id(10),id(20),id(2)]);await db.query("insert into summon_helpers(id,summon_id,profile_id,joined_at,completed_at,minutes) values($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',60)",[id(16003),id(16002),id(3)]);},v=>v.availability==='available'&&!v.contributors.unitComplete&&v.contributors.completenessReasons.includes('legacy_unmapped')&&v.contributors.people.some(p=>p.profileId===id(3)&&p.measurementState==='unproven'&&p.knownMicros==='0')&&!v.contributors.people.some(p=>p.profileId===id(2)));
await contributorControl('Deleted and reinserted unit UUID cannot inherit old labor identity',async()=>{const unitRow=(await q('select to_jsonb(u) value from custom_work_units u where id=$1',[id(30)])).value;await db.query('delete from custom_work_units where id=$1',[id(30)]);await db.query('insert into custom_work_units select (jsonb_populate_record(null::custom_work_units,$1::jsonb)).*',[JSON.stringify(unitRow)]);},concealed);
await contributorControl('Retired task keeps captured version and labor',()=>db.query('update work_activity_definitions set retired_at=clock_timestamp() where id=$1',[defs.find(d=>d.code==='totals_specific').definition_id]),v=>v.contributors.people[0].activities[0].retired&&v.contributors.unitKnownMicros===fixedTotal);
await contributorControl('New task label/version does not rewrite captured task',async()=>{await as(id(2));await q("select work_publish_activity_version($1,'totals_specific',1,'specific','Changed task name','Changed task name',false,'[]')",[id(seq++)]);},v=>v.contributors.people[0].activities[0].definitionVersion===1&&v.contributors.people[0].activities[0].labelEn==='totals_specific'&&v.contributors.unitKnownMicros===fixedTotal);
await as(id(2),'postgres');await db.exec('savepoint named_crew');
await db.query("insert into crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description) values($1,$2,$3,$4,(clock_timestamp() at time zone 'America/Denver')::date,'install','finished',true,'Synthetic untimed crew participation')",[id(10050),id(10),id(30),id(2)]);
await db.query('insert into crew_work_record_people(record_id,profile_id) values($1,$2)',[id(10050),id(3)]);
await as(id(2));const namedCrew=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
contributorWire.push({label:'named_crew_not_divided_duration',request:{projectId:id(10),unitId:id(30),protocolVersion:1},reply:namedCrew});
check(namedCrew.contributors.unitKnownMicros===fixedTotal&&namedCrew.contributors.untimedParticipants.some(p=>p.profileId===id(3)&&p.evidence.some(e=>e.sourceKind==='crew_work_record_people'))&&!namedCrew.contributors.people.some(p=>p.profileId===id(3)),'Untimed crew identity is never assigned a share of trip or unit time');
await as(id(2),'postgres');await db.exec('savepoint named_and_legacy');await db.query("insert into unit_sessions(id,opening_id,profile_id,started_at,ended_at) values($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[id(16001),id(20),id(3)]);await as(id(2));
const namedLegacy=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
contributorWire.push({label:'same_person_unproven_timer_and_named_work',request:{projectId:id(10),unitId:id(30),protocolVersion:1},reply:namedLegacy});
check(namedLegacy.contributors.people.some(p=>p.profileId===id(3)&&p.measurementState==='unproven')&&namedLegacy.contributors.untimedParticipants.some(p=>p.profileId===id(3))&&namedLegacy.contributors.participantCounts.total===3,'Named work cannot hide the same persons unproven timer or double-count their UUID');
check(BigInt(namedLegacy.contributors.unitKnownMicros)>0n&&namedLegacy.contributors.people.find(p=>p.profileId===id(3)).share.state==='unavailable'&&!namedLegacy.contributors.people.find(p=>p.profileId===id(3)).share.reasons.includes('zero'),'Zero-time unproven person on positive partial unit uses whole-unit uncertainty reasons, not zeroOnly audit reasons');
await as(id(2),'postgres');await db.exec('rollback to savepoint named_and_legacy');
await as(id(2),'postgres');await db.exec('savepoint moved_crew');await db.query('update crew_work_records set unit_id=$1,project_id=$2 where id=$3',[id(30),id(11),id(10050)]);
await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(11)]);await as(id(2));const hiddenMovedCrew=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
check(concealed(hiddenMovedCrew),'Moved named evidence retains original and current project permission closure');
await as(id(2),'postgres');await db.exec('rollback to savepoint moved_crew');
await as(id(2));await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(10052),JSON.stringify({id:id(10051),revision:0,project_id:id(10),opening_id:null,label:'Moved crew destination',type_label:'Window',facts:{},dimension_observation:{width:36,height:48,unit:'in',source:'estimated'},expected_fact_revision:0})]);
await as(id(2),'postgres');await db.exec('savepoint moved_unit_crew');await db.query('update crew_work_records set unit_id=$1 where id=$2',[id(10051),id(10050)]);await as(id(2));
const movedCrew=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
check(!movedCrew.contributors.untimedParticipants.some(p=>p.profileId===id(3)),'Current crew unit correction does not display historical binding as current named work');
await as(id(2),'postgres');await db.exec('rollback to savepoint moved_unit_crew');
await as(id(2),'postgres');await db.query("update crew_work_record_people set voided_at=clock_timestamp(),voided_by=$3,void_reason='Synthetic correction' where record_id=$1 and profile_id=$2",[id(10050),id(3),id(2)]);await as(id(2));
const voidedCrew=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
check(!voidedCrew.contributors.untimedParticipants.some(p=>p.profileId===id(3))&&voidedCrew.contributors.unitKnownMicros===fixedTotal,'Voiding named-only participation removes current name without changing captured labor');
await as(id(2),'postgres');await db.exec('rollback to savepoint named_crew');

for(const role of ['anon','service_role','authenticated']){
 await as(id(2),'postgres');await db.exec('savepoint contributor_role');await as(role==='authenticated'?id(3):id(2),role);
 let denied=null;try{await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)]);}catch(e){denied=e.code;}
 await as(id(2),'postgres').catch(()=>{});await db.exec('rollback to savepoint contributor_role');check(denied==='42501',role+' cannot obtain named contributors without real supervisor entry authority');
}
for(const [label,change] of [['retired actor','retired_at=clock_timestamp()'],['revoked actor','access_revoked_at=clock_timestamp()'],['partner actor','is_partner=true']]){
 await as(id(2),'postgres');await db.exec('savepoint contributor_actor');await db.query('update profiles set '+change+' where id=$1',[id(2)]);await as(id(2));let denied=null;
 try{await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)]);}catch(e){denied=e.code;}
 await db.exec('rollback to savepoint contributor_actor');check(denied==='42501',label+' is refused by actual server admission before contributor disclosure');
}
for(const args of [[null,id(30),1],[id(10),null,1],[id(10),id(30),2]]){
 await as(id(2),'postgres');await db.exec('savepoint contributor_input');await as(id(2));let code=null;
 try{await q('select work_unit_contributors_read($1,$2,$3) value',args);}catch(e){code=e.code;}
 await db.exec('rollback to savepoint contributor_input');check(code==='23514','Malformed contributor request refuses with23514');
}
for(const ddl of [
 'grant execute on function _work_unit_contributors_shift(uuid,uuid,timestamptz,jsonb) to authenticated',
 'grant execute on function work_unit_contributors_read(uuid,uuid,integer) to service_role',
 'grant select(profile_id) on work_activity_safety_events to public',
 "create function public._work_unit_contributors_unknown() returns int language sql as 'select 1'",
 "create function public.work_unit_contributors_read(text) returns int language sql as 'select 1'",
 "create table public._work_unit_contributors_unknown(id int)",
 "alter function public._work_unit_contributors_person(uuid,jsonb,text[],numeric,text[]) strict"
])await contributorControl('Exact contributor source guard rejects '+ddl,()=>db.exec(ddl),concealed);
await as(id(2),'postgres');await db.exec('savepoint three_person');
const trio=[id(10101),id(10102),id(10103)],trioUnit=id(10100);
for(const [i,p] of trio.entries()){await db.query('insert into auth.users(id) values($1)',[p]);await db.query("insert into profiles(id,display_name,role,is_test) values($1,$2,'installer',false)",[p,'Same name']);}
await as(id(2));await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(10104),JSON.stringify({id:trioUnit,revision:0,project_id:id(10),opening_id:null,label:'Three people',type_label:'Window',facts:{},dimension_observation:{width:36,height:48,unit:'in',source:'estimated'},expected_fact_revision:0})]);
let trioCommandCounter=11000;
async function recordLabor(profile,unitId,hours,captureOverride=null){
 await as(profile);await q("select to_jsonb(sign_toolbox_talk($1,$2,null::uuid,'Synthetic signature',null::text,null::text,'Synthetic contributor fixture',clock_timestamp())) value",[id(trioCommandCounter++),profile]);
 const begin=new Date(Date.now()-4*3600000).toISOString(),finish=new Date(Date.parse(begin)+hours*3600000).toISOString();
 const laborShift=(await q("select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,clock_timestamp(),0,1)) value",[id(10),id(trioCommandCounter++),begin])).value;
 const dev=id(trioCommandCounter++),gen=id(trioCommandCounter++);let sequence=0,head=null;
 async function issue(action,tap){const snap=(await q('select work_activity_snapshot($1) value',[dev])).value,cid=id(trioCommandCounter++);const payload={deviceId:dev,clientGeneration:gen,clientSequence:sequence,predecessorCommandId:head,expectedRevision:snap.state.revision,basis:{observationId:snap.observation.id},shiftRef:snap.observation.shiftRef,tappedAt:tap,clockCheckedAt:new Date().toISOString(),clockSkewMs:0,intent:action};const result=(await q('select work_activity_command($1,1,$2::jsonb) value',[cid,JSON.stringify(payload)])).value;assert.ok(['applied','noop'].includes(result.receipt.status),JSON.stringify(result));head=cid;sequence++;return result;}
 await issue({kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null},begin);
 await issue({kind:'finish_setup',projectId:id(10),costCodeId:null},begin);
 const uv=(await q('select work_activity_unit_basis($1) value',[unitId])).value.unit;
 const ub={id:uv.id,operationalRevision:uv.operationalRevision,incarnationEpoch:uv.incarnationEpoch,bindingEpoch:uv.bindingEpoch,projectEpoch:uv.projectEpoch,openingEpoch:uv.openingEpoch,factId:uv.fact.id,factRevision:uv.fact.revision,originProjectEpoch:uv.fact.originProjectEpoch,originOpeningEpoch:uv.fact.originOpeningEpoch};
 await issue({...captureOverride?.specific??intent('specific'),unit:ub},begin);
 if(captureOverride?.secondSpecific)await issue({...captureOverride.secondSpecific,unit:ub},new Date(Date.parse(begin)+hours*1800000).toISOString());
 await issue(captureOverride?.general??intent('general'),finish);
 await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text)) value',[laborShift.id]);
 return laborShift.id;
}
await as(id(2),'postgres');await db.exec('savepoint trio_ready');
for(const [i,p] of trio.entries())await recordLabor(p,trioUnit,3-i);
await as(id(2));const trioReply=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),trioUnit])).value;
contributorWire.push({label:'three_people_3_2_1_hours',request:{projectId:id(10),unitId:trioUnit,protocolVersion:1},reply:trioReply});
check(trioReply.contributors.unitComplete&&trioReply.contributors.unitKnownMicros==='21600000000','Three actual overlapping3h+2h+1h shifts produce6manhours');
check(trioReply.contributors.people.map(p=>p.knownMicros).join(',')==='10800000000,7200000000,3600000000','Per-person exact amounts are3h2h1h without elapsed-time division');
check(trioReply.contributors.people.every(p=>p.displayName==='Same name')&&new Set(trioReply.contributors.people.map(p=>p.profileId)).size===3,'Same names preserve three distinct UUIDs');
check(trioReply.contributors.people.every(p=>p.share.state==='available'&&p.share.denominatorMicros==='21600000000'&&p.activities.reduce((n,a)=>n+BigInt(a.knownMicros),0n)===BigInt(p.knownMicros)),'All tasks and share fractions use one coherent exact denominator');
check(trioReply.contributors.untimedParticipants.length===0&&trioReply.contributors.zeroOnly.length===0,'Valid closed work requires neither finalQC nor invented named companions');

await as(id(2),'postgres');await db.exec('rollback to savepoint trio_ready');
for(const p of trio.slice(0,2))await recordLabor(p,trioUnit,1);
await as(id(2));const overlapReply=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),trioUnit])).value;
contributorWire.push({label:'overlapping_two_people_one_hour_each',request:{projectId:id(10),unitId:trioUnit,protocolVersion:1},reply:overlapReply});
check(overlapReply.contributors.unitComplete&&overlapReply.contributors.unitKnownMicros==='7200000000'&&overlapReply.contributors.people.length===2&&overlapReply.contributors.people.every(p=>p.knownMicros==='3600000000'),'Two overlapping one-hour workers equal two manhours, not one elapsed hour');

await recordLabor(trio[2],trioUnit,0);await as(id(2));
const mixedZeroReply=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),trioUnit])).value;
contributorWire.push({label:'positive_unit_with_zero_only_audit',request:{projectId:id(10),unitId:trioUnit,protocolVersion:1},reply:mixedZeroReply});
check(mixedZeroReply.contributors.unitComplete&&mixedZeroReply.contributors.unitKnownMicros==='7200000000'&&mixedZeroReply.contributors.people.length===2&&mixedZeroReply.contributors.zeroOnly.length===1&&mixedZeroReply.contributors.participantCounts.total===2,'Proven zero audit does not add a worked contributor to positive unit');
check(mixedZeroReply.contributors.zeroOnly[0].share.state==='unavailable'&&mixedZeroReply.contributors.zeroOnly[0].share.reasons.includes('zero'),'Zero-only audit has no percentage even when other people have positive time');

await as(id(2),'postgres');await db.exec('rollback to savepoint trio_ready');await as(id(2));
await q("select work_publish_activity_version($1,'contributors_machine',0,'specific','Machine unit activity','Machine unit activity',true,'[]')",[id(15000)]);
await as(id(2),'postgres');const machineDef=(await q("select d.id definition_id,v.id version_id from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code='contributors_machine'")).definition_id;
const machineVersion=(await q('select id from work_activity_definition_versions where definition_id=$1',[machineDef])).id;
await as(id(2));await q("select work_publish_menu_version($1,'totals_menu',1,'Totals','Totals',$2::jsonb)",[id(15001),JSON.stringify([...defs.map((d,i)=>({definitionId:d.definition_id,versionId:d.version_id,position:i,enabled:true})),{definitionId:machineDef,versionId:machineVersion,position:2,enabled:true}])]);
await as(id(2),'postgres');const machineMenu=(await q("select v.id from work_capture_menu_versions v join work_capture_menus m on m.id=v.menu_id where m.code='totals_menu' and v.version=2")).id;
await as(id(2));await q('select work_select_job_menu($1,$2,$3,$4)',[id(15002),id(10),machineMenu,selection.revision]);
await as(id(2),'postgres');const machineSelection=await q('select id,revision from work_job_menu_selections where project_id=$1 order by revision desc limit 1',[id(10)]);
const newMenuIntent=base=>({...base,menuVersionId:machineMenu,selectionId:machineSelection.id,selectionRevision:machineSelection.revision});
await recordLabor(trio[0],trioUnit,2,{specific:newMenuIntent(intent('specific')),secondSpecific:{...newMenuIntent(intent('specific')),definitionVersionId:machineVersion,machineKind:'forklift'},general:newMenuIntent(intent('general'))});
await as(id(2));const machineReply=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),trioUnit])).value;
contributorWire.push({label:'two_tasks_machine_subset_not_extra_timer',request:{projectId:id(10),unitId:trioUnit,protocolVersion:1},reply:machineReply});
check(machineReply.contributors.unitComplete&&machineReply.contributors.unitKnownMicros==='7200000000'&&machineReply.contributors.people[0].activities.length===2,'One person two captured tasks sum to the same2hour unit denominator');
check(machineReply.contributors.people[0].activities.find(a=>a.definitionId===machineDef).machineSubsets[0].knownMicros==='3600000000','Machine hour is a subset of the twohour labor total, never an extra timer');

await as(id(2),'postgres');await db.exec('rollback to savepoint three_person');

await as(id(2),'postgres');await db.exec('savepoint contributor_caps');
await db.exec("insert into auth.users(id) select md5('contributor-cap-'||n)::uuid from generate_series(1,199)n;insert into profiles(id,display_name,role,is_test) select md5('contributor-cap-'||n)::uuid,'Cap person '||n,'installer',false from generate_series(1,199)n;");
await db.query("insert into crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description) values($1,$2,$3,$4,(clock_timestamp() at time zone 'America/Denver')::date,'install','partial',false,'Synthetic capped named work')",[id(14000),id(10),id(30),id(2)]);
await db.query("insert into crew_work_record_people(record_id,profile_id) select $1,md5('contributor-cap-'||n)::uuid from generate_series(1,198)n",[id(14000)]);await as(id(2));
const cap200=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
check(cap200.availability==='available'&&cap200.contributors.participantCounts.total===200,'Exactly200 distinct subjects admit a complete bounded response without truncation');
await as(id(2),'postgres');await db.query("insert into crew_work_record_people(record_id,profile_id) values($1,md5('contributor-cap-199')::uuid)",[id(14000)]);await as(id(2));
const cap201=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
check(concealed(cap201),'Subject201 refuses generically rather than leaking a truncated or reweighted breakdown');
await as(id(2),'postgres');await db.exec('rollback to savepoint contributor_caps');

if(process.env.WORK_UNIT_CONTRIBUTORS_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_CONTRIBUTORS_WIRE_OUT,JSON.stringify({contributorsSha256:hash(contributors),totalsSha256:hash(totals),calls:contributorWire},null,2)+'\n');
console.log('CONTRIBUTORS_SOURCE',hash(contributors));
`;
let source=original.replaceAll("process.argv.includes('--build-coverage')",'false').replace('stack:e.stack','stack:e.stack?.slice(-1200)');
source=source.replace(seam,()=>install+'\n'+seam);

const beforeQc=String.raw`
await as(id(2));
const completeContributors=(await q('select work_unit_contributors_read($1,$2,1) value',[id(10),id(30)])).value;
contributorWire.push({label:'complete_positive_before_review',request:{projectId:id(10),unitId:id(30),protocolVersion:1},reply:completeContributors});
check(completeContributors.availability==='available'&&completeContributors.contributors.unitComplete&&completeContributors.contributors.unitKnownMicros===fixedTotal,'Complete positive contribution exists without final QC approval');
check(completeContributors.contributors.people[0].share.state==='available'&&completeContributors.contributors.people[0].share.denominatorMicros===fixedTotal,'Complete share uses coherent exact unit denominator');
`;
const beforeQcSeam=`await as(id(2),'postgres');await db.query("update time_shifts set status='approved'`;
assert.equal(source.split(beforeQcSeam).length,2);source=source.replace(beforeQcSeam,()=>beforeQc+'\n'+beforeQcSeam);

source=source.replace('if(process.env.WORK_ACTIVITY_TOTALS_WIRE_OUT)',()=>checks+'\n'+extraChecks+'\nif(process.env.WORK_ACTIVITY_TOTALS_WIRE_OUT)');
source=source.replaceAll('import.meta.url',JSON.stringify(path.href));
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await runContributorProof();
