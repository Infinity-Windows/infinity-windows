await as(id(2),'postgres');
let metadataSql=read('supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql');
const metadataBuild=process.argv.includes('--build-metadata-coverage');
const metadataTables=['definitions','versions','proposals','revisions','current','floors','floor_current','commands','contract'].map(s=>'_work_unit_metadata_'+s);
const metadataPublic=['work_unit_metadata_read','work_unit_metadata_command','work_unit_metadata_receipt','work_unit_cohorts_read'];
const section=(sql,name,body)=>sql.replace(new RegExp('-- '+name+'_BEGIN[\\s\\S]*?-- '+name+'_END'),'-- '+name+'_BEGIN\n'+body+'-- '+name+'_END');
const controls=metadataTables.map(t=>`alter table public.${t} enable row level security;\nrevoke all on table public.${t} from public,anon,authenticated,service_role;\ncreate trigger metadata_gate before insert or update or delete or truncate on public.${t} for each statement execute function public._work_unit_metadata_gate();\n`+(['_work_unit_metadata_current','_work_unit_metadata_floor_current'].includes(t)?'':`create trigger metadata_immutable before update or delete or truncate on public.${t} for each statement execute function public._work_unit_metadata_immutable();\n`)).join('');
const baseFns=[...new Set([...contributorFunctions,'_is_lead','_work_unit_fact_peek_epoch','_work_unit_fact_bump_epoch','_work_config_is_owner','_work_config_is_supervisor','_work_config_internal','_work_activity_unit_basis','_work_unit_contributors_coverage','attach_sandbox_guards','sandbox_scoped_tables','guard_test_account_sandbox_only','row_project_id'])].sort();
let baseQuery=contributorCatalogQuery.replaceAll(sqlArray([...contributorFunctions,'_work_unit_contributors_coverage']),sqlArray([...baseFns,'_work_unit_contributors_coverage'])).replaceAll(sqlArray(contributorFunctions),sqlArray(baseFns));
// This new boundary attests full relevant function metadata and authored
// defaults/ACL/constraint semantics in addition to the frozen guard fields.
baseQuery=baseQuery.replaceAll("'parallel',p.proparallel,'body',encode(","'parallel',p.proparallel,'leakproof',p.proleakproof,'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'setReturning',p.proretset,'rawAcl',p.proacl::text,'body',encode(")
.replaceAll("'nullable',not a.attnotnull,","'nullable',not a.attnotnull,'default',(select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum),'collation',a.attcollation::regcollation::text,'rawAcl',a.attacl::text,")
.replaceAll("'validated',k.convalidated)","'validated',k.convalidated,'enforced',coalesce((to_jsonb(k)->>'conenforced')::boolean,true),'deferrable',k.condeferrable,'deferred',k.condeferred)")
.replaceAll("'rls',c.relrowsecurity,'owner'","'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,'kind',c.relkind,'persistence',c.relpersistence,'rawAcl',c.relacl::text,'owner'");
const digest=async query=>(await q("select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') digest from ("+query+")c")).digest;
const baseDigest=await digest(baseQuery);
const preflight="do $metadata_source$ begin\n if not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() or not coalesce((select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')='"+baseDigest+"' from ("+baseQuery+")c),false) then raise exception using errcode='55000',message='Unit metadata source is unavailable.';end if;\nend $metadata_source$;\n";
if(metadataBuild){metadataSql=section(metadataSql,'METADATA_TABLE_CONTROLS',controls);metadataSql=section(metadataSql,'METADATA_BASE_PREFLIGHT',preflight);metadataSql=section(metadataSql,'METADATA_FUNCTION_ACLS','');metadataSql=section(metadataSql,'METADATA_COVERAGE','');metadataSql=section(metadataSql,'METADATA_PROOF_SEED','');}else{assert.ok(metadataSql.includes(controls));assert.ok(metadataSql.includes(preflight),'Metadata base preflight drift');}
const ns=metadataSql.slice(metadataSql.indexOf('do $namespace$'),metadataSql.indexOf('end $namespace$;')+16);
for(const ddl of ["create function work_unit_metadata_read(text) returns int language sql as 'select 1'","create function work_unit_metadata_command(text) returns int language sql as 'select 1'","create function work_unit_metadata_receipt(text) returns int language sql as 'select 1'","create type _work_unit_metadata_collision as enum('collision')","create function work_unit_cohorts_read(text) returns int language sql as 'select 1'",'create table _work_unit_metadata_collision(id int)']){
 await db.exec('savepoint metadata_namespace');await db.exec(ddl);await db.exec('savepoint metadata_refusal');let err;try{await db.exec(ns);}catch(e){err=e.code;}assert.equal(err,'55000');await db.exec('rollback to savepoint metadata_namespace');check(true,'Metadata namespace collision refuses before DDL');
}
await db.exec('savepoint metadata_base_drift');await db.exec('grant select(profile_id) on work_activity_safety_events to authenticated');await db.exec('savepoint metadata_base_refusal');let mf;try{await db.exec(preflight);}catch(e){mf=e.code;}assert.equal(mf,'55000');await db.exec('rollback to savepoint metadata_base_drift');check(true,'Base column ACL drift refuses metadata DDL');
const sandboxTriggerQuery="select c.relname as table,t.tgenabled enabled,t.tgargs args,pg_get_triggerdef(t.oid,true) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname='guard_test_account_sandbox_only' order by c.relname";
const allTriggerQuery="select n.nspname,c.relname as table,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,t.tgname";
const allTriggersBefore=(await db.query(allTriggerQuery)).rows;
const sandboxTriggersBefore=(await db.query(sandboxTriggerQuery)).rows;
await db.exec(metadataSql.replace(/^([\s\S]*?)\bbegin;/,(_,prefix)=>prefix).replace(/rollback;\s*$/,''));
const allTriggersAfter=(await db.query(allTriggerQuery)).rows;assert.deepEqual(allTriggersAfter.filter(t=>!metadataTables.includes(t.table)),allTriggersBefore,'Every older public trigger remains byte-identical');
const sandboxTriggersAfter=(await db.query(sandboxTriggerQuery)).rows;const sandboxNew=sandboxTriggersAfter.filter(t=>metadataTables.includes(t.table));assert.deepEqual(sandboxTriggersAfter.filter(t=>!metadataTables.includes(t.table)),sandboxTriggersBefore);assert.deepEqual(sandboxNew.map(t=>t.table),['_work_unit_metadata_commands','_work_unit_metadata_definitions','_work_unit_metadata_proposals']);for(const t of sandboxNew){assert.equal(t.enabled,'O');assert.ok(t.definition.includes("guard_test_account_sandbox_only('project_id', 'project')"));}check(true,'Exactly three new enabled standard sandbox triggers; every older sandbox trigger unchanged');
if(process.env.WORK_UNIT_METADATA_SANDBOX_DELTA_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_SANDBOX_DELTA_OUT,JSON.stringify({scope:'Actual source-matched PGlite catalog delta',olderTriggersUnchanged:true,allOlderPublicTriggerCount:allTriggersBefore.length,allOlderPublicTriggersUnchanged:true,before:sandboxTriggersBefore,added:sandboxNew},null,2)+'\n');

const ownFns=(await db.query("select p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (starts_with(p.proname,'_work_unit_metadata_') or p.proname=any($1)) order by p.proname",[metadataPublic])).rows;
const acls=ownFns.map(f=>`revoke all on function public.${f.proname}(${f.args}) from public,anon,${metadataPublic.includes(f.proname)?'':'authenticated,'}service_role;\n`+(metadataPublic.includes(f.proname)?`grant execute on function public.${f.proname}(${f.args}) to authenticated;\n`:'')).join('');if(metadataBuild)await db.exec(acls);else assert.ok(metadataSql.includes(acls));
const ownNames=ownFns.map(f=>f.proname);
const functions=[...new Set([...baseFns,...ownNames])].sort(),tables=[...new Set([...contributorTables,...metadataTables])];
let mq=baseQuery.replaceAll(sqlArray([...baseFns,'_work_unit_contributors_coverage']),sqlArray([...functions,'_work_unit_contributors_coverage','_work_unit_metadata_coverage'])).replaceAll(sqlArray(baseFns),sqlArray(functions))
.replaceAll(sqlArray([...contributorTables,'_work_unit_review_live_sources']),sqlArray([...tables,'_work_unit_review_live_sources'])).replaceAll(sqlArray(contributorTables),sqlArray(tables))
.replaceAll("starts_with(c.relname,'_work_unit_contributors_')","(starts_with(c.relname,'_work_unit_contributors_') or starts_with(c.relname,'_work_unit_metadata_') or starts_with(c.relname,'work_unit_metadata_'))")
.replaceAll("starts_with(p.proname,'_work_unit_contributors_')","(starts_with(p.proname,'_work_unit_contributors_') or starts_with(p.proname,'_work_unit_metadata_') or starts_with(p.proname,'work_unit_metadata_') or p.proname=any("+sqlArray(metadataPublic)+"))");
mq=mq.replace("select jsonb_build_object(","select jsonb_build_object('metadataNamespaceTypes',(select coalesce(jsonb_agg(jsonb_build_object('name',t.typname,'kind',t.typtype,'relation',c.relname) order by t.typname),'[]') from pg_type t join pg_namespace n on n.oid=t.typnamespace left join pg_class c on c.oid=t.typrelid where n.nspname='public' and (starts_with(t.typname,'_work_unit_metadata_') or starts_with(t.typname,'work_unit_metadata_'))),");
mq=mq.replace("select jsonb_build_object(","select jsonb_build_object('metadataIndexes',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(c.oid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready) order by c.relname),'[]') from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and starts_with(t.relname,'_work_unit_metadata_')),");
// Generic attester includes its own complete body. Its expected catalog root
// lives in a singleton immutable proof row, avoiding a circular self hash.
const guard="create or replace function public._work_unit_metadata_coverage() returns boolean\nlanguage sql stable security definer set search_path=public,pg_temp as $coverage$\n select coalesce((select encode(sha256(convert_to(c.value::text,'UTF8')),'hex')=p.expected_catalog_sha256 from public._work_unit_metadata_contract p cross join ("+mq+")c where p.proof_key='metadata_v1'),false)\n$coverage$;\nrevoke all on function public._work_unit_metadata_coverage() from public,anon,authenticated,service_role;\n";
if(metadataBuild)await db.exec(guard);else assert.ok(metadataSql.includes(guard));
const pinQuery="select jsonb_build_object('body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'set',p.proretset,'result',pg_get_function_result(p.oid),'args',pg_get_function_identity_arguments(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'cost',p.procost,'rows',p.prorows,'support',p.prosupport::regprocedure::text,'language',(select lanname from pg_language where oid=p.prolang)) value from pg_proc p where p.oid=to_regprocedure('public._work_unit_metadata_coverage()')";
const pinDigest=await digest(pinQuery);
for(const actor of ['a','actor']){
 const boundary=" perform public._work_activity_read_committed();perform public._work_activity_gate();"+actor+":=public._work_activity_actor();perform pg_advisory_xact_lock(7710,0);"+actor+":=public._work_activity_actor();\n if not coalesce((select encode(sha256(convert_to(pin.value::text,'UTF8')),'hex')='"+pinDigest+"' from ("+pinQuery+")pin),false) then "+actor+":=null;\n elsif not public._work_unit_metadata_coverage() or not public._work_unit_review_coverage() or not public._work_totals_coverage() or not public._work_unit_contributors_coverage() then "+actor+":=null;end if;\n";
 const pattern=new RegExp('-- METADATA_BOUNDARY_'+actor+'_BEGIN[\\s\\S]*?-- METADATA_BOUNDARY_'+actor+'_END','g');assert.equal([...metadataSql.matchAll(pattern)].length,actor==='a'?3:1,'All four independent public boundaries exist');
 if(metadataBuild)metadataSql=metadataSql.replace(pattern,()=> '-- METADATA_BOUNDARY_'+actor+'_BEGIN\n'+boundary+' -- METADATA_BOUNDARY_'+actor+'_END');
 else for(const block of metadataSql.matchAll(pattern))assert.equal(block[0],'-- METADATA_BOUNDARY_'+actor+'_BEGIN\n'+boundary+' -- METADATA_BOUNDARY_'+actor+'_END','Independent public boundary pin drift');
}
if(metadataBuild){for(const name of metadataPublic){const start=metadataSql.indexOf('create function public.'+name+'('),end=metadataSql.indexOf('end$$;',start)+7;assert.ok(start>0&&end>start);await db.exec(metadataSql.slice(start,end).replace('create function','create or replace function'));}}
const md=await digest(mq),mc=(await q(mq)).value;
const proofSeed="insert into public._work_unit_metadata_contract(proof_key,expected_catalog_sha256) values('metadata_v1','"+md+"');\n";
if(metadataBuild){metadataSql=section(metadataSql,'METADATA_FUNCTION_ACLS',acls);metadataSql=section(metadataSql,'METADATA_COVERAGE',guard);metadataSql=section(metadataSql,'METADATA_PROOF_SEED',proofSeed);writeFileSync(new URL('supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql',root),metadataSql);await db.exec(proofSeed);}else{assert.ok(metadataSql.includes(acls));assert.ok(metadataSql.includes(guard),'Metadata exact catalog drift');assert.ok(metadataSql.includes(proofSeed),'Immutable source proof drift');}
check((await q('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() and _work_unit_metadata_coverage() ok')).ok,'New and all frozen catalog guards agree');
for(const role of ['anon','authenticated','service_role','public'])for(const permission of ['SELECT','INSERT','UPDATE','REFERENCES']){
 await db.exec('savepoint metadata_column_drift');await db.exec(`grant ${permission}(actor_id) on _work_unit_metadata_revisions to ${role}`);assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);await db.exec('rollback to savepoint metadata_column_drift');check(true,'Private column ACL drift '+role+' '+permission+' refused');
}
if(process.env.WORK_UNIT_METADATA_CATALOG_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_CATALOG_OUT,JSON.stringify({sourceSha256:hash(metadataSql),baseDigest,catalogDigest:md,catalogQuery:mq,metadata:mc},null,2)+'\n');
console.log('METADATA_SOURCE',hash(metadataSql));
const metadataWire=[];let mi=30000;
const mrpc=async(label,sql,args)=>{const reply=(await q(sql,args)).value;metadataWire.push({label,sql,args,reply});return reply;};
const mread=async(unit=id(30))=>mrpc('metadata_read','select work_unit_metadata_read($1,1) value',[unit]);
const mcommand=async(action,data,command=id(mi++))=>mrpc(action,'select work_unit_metadata_command($1,1,$2::jsonb) value',[command,JSON.stringify({action,data})]);
await as(id(2));let metadataView=await mread();check(metadataView.availability==='available'&&metadataView.metadata.classification.state==='unknown','Unclassified canonical unit has explicit unknown metadata');
const publish=async(kind,code,projectId=null,more={})=>{const answer=await mcommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId,definition:{kind,code,labelEn:code,labelEs:code,...more}});assert.equal(answer.receipt.status,'applied');return answer.receipt.result;};
const category=await publish('category','window');const door=await publish('category','door');const storefront=await publish('category','storefront');
const aluminum=await publish('material','aluminum');const casement=await publish('subtype','casement',null,{parentVersionId:category.versionId});
const pane=await publish('component','pane',null,{unit:'count'});
const customWidth=await publish('field','custom_width',null,{fieldType:'number',required:false,unit:'in',min:'0',max:'10000'});
const floorOne=await publish('floor','ground',id(10));const floorTwo=await publish('floor','upper',id(10));
const values={category:{state:'known',versionId:category.versionId},subtype:{state:'known',versionId:casement.versionId},frameMaterial:{state:'known',versionId:aluminum.versionId},components:[{versionId:pane.versionId,quantity:'3'}],fields:[{versionId:customWidth.versionId,state:'known',value:'999'}]};
await as(id(2),'postgres');
const timingBefore=(await q("select jsonb_build_object('shifts',(select jsonb_agg(to_jsonb(x) order by id) from time_shifts x),'sessions',(select jsonb_agg(to_jsonb(x) order by id) from custom_work_sessions x),'facts',(select jsonb_agg(to_jsonb(x) order by id) from work_unit_fact_revisions x),'qc',(select jsonb_agg(to_jsonb(x) order by id) from work_unit_review_events x)) value")).value;
await as(id(2));
const assignId=id(mi++),assignData={unitId:id(30),basis:metadataView.metadata.metadataBasis,classification:values};
const assigned=await mcommand('assign',assignData,assignId);check(assigned.receipt.status==='applied','Owner records immutable unit classification');
assert.deepEqual(await mcommand('assign',assignData,assignId),assigned);check(true,'Identical command returns original immutable receipt');
check((await mcommand('assign',{...assignData,classification:{...values,category:{state:'unknown'},subtype:{state:'unknown'}}},assignId)).availability==='unavailable','Changed payload cannot adopt original receipt');
metadataView=await mread();check(metadataView.metadata.classification.state==='current'&&metadataView.metadata.classification.values.fields[0].value==='999','Current classification retains exact custom value without dimension authority');
const floorData={unitId:id(30),basis:metadataView.metadata.floorBasis,state:'multilevel',shares:[{versionId:floorOne.versionId,numerator:'1',denominator:'3'},{versionId:floorTwo.versionId,numerator:'2',denominator:'3'}],reason:'Synthetic exact two-floor proof'};
const allocation=await mcommand('allocate',floorData);check(allocation.receipt.status==='applied','Dimension-authorized actor records exact multilevel area vector');
metadataView=await mread();check(metadataView.metadata.floor.current&&metadataView.metadata.floor.shares.length===2,'Floor proof is current against actual independent verification and QC');
await mcommand('assign',{unitId:id(30),basis:metadataView.metadata.metadataBasis,classification:{...values,category:{state:'unknown'},subtype:{state:'unknown'}}});
metadataView=await mread();check(metadataView.metadata.floor.current,'Authoritative reclassification does not invalidate independent floor proof');
await as(id(2),'postgres');
const timingAfter=(await q("select jsonb_build_object('shifts',(select jsonb_agg(to_jsonb(x) order by id) from time_shifts x),'sessions',(select jsonb_agg(to_jsonb(x) order by id) from custom_work_sessions x),'facts',(select jsonb_agg(to_jsonb(x) order by id) from work_unit_fact_revisions x),'qc',(select jsonb_agg(to_jsonb(x) order by id) from work_unit_review_events x)) value")).value;
assert.deepEqual(timingAfter,timingBefore);check(true,'Metadata/floor operations change no paid rows, physical facts or QC history');
await as(id(2));
const savedReceipt=await mrpc('receipt','select work_unit_metadata_receipt($1,1) value',[assignId]);assert.deepEqual(savedReceipt,assigned);
await as(id(3));check((await mrpc('foreign_receipt','select work_unit_metadata_receipt($1,1) value',[assignId])).availability==='unavailable','Foreign command receipt is hidden');
await as(id(2),'postgres');await db.exec('savepoint metadata_hidden');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[id(10)]);await as(id(2));check((await mread()).availability==='unavailable','Hidden source conceals metadata/floor identities');await as(id(2),'postgres');await db.exec('rollback to savepoint metadata_hidden');
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
await as(id(2),'postgres');
const unitCensus=(await db.query('select id from custom_work_units where project_id=$1 order by id',[id(10)])).rows.map(u=>u.id);
const memberships=(await q('select _work_unit_metadata_members($1::uuid[]) value',[unitCensus])).value;
for(const uid of unitCensus){
 const originalScope=(await q('select _work_unit_review_scope($1,$2) value',[id(2),uid])).value;
 const sharedScope=(await q('select _work_unit_metadata_scope($1,$2,$3::jsonb) value',[id(2),uid,JSON.stringify(memberships[uid])])).value;
 assert.deepEqual(sharedScope,originalScope,'FULL ordered source/dimension/manifest/token parity for '+uid);
 const originalReview=(await q('select _work_unit_review_view($1,$2::jsonb) value',[id(2),JSON.stringify(originalScope)])).value;
 const sharedReview=(await q('select _work_unit_metadata_review($1,$2::jsonb) value',[id(2),JSON.stringify(sharedScope)])).value;assert.deepEqual(sharedReview,originalReview);
}
check(true,'Every actual fixture unit has complete shared0844 scope/manifest/ur1/view parity');
await as(id(2));
const batch=await mrpc('project_batch','select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),'{}']);
assert.equal(batch.availability,'available',JSON.stringify(batch));
check(batch.cohort.units.length===unitCensus.length,'One coherent project batch includes each canonical current unit once');
const targetBatch=batch.cohort.units.find(u=>u.unitId===id(30));
check(targetBatch.eligible&&targetBatch.rawArea.numerator==='12'&&targetBatch.rawArea.denominator==='1','Actual independently verified/QC unit supplies exact once-counted rational area');
check(batch.cohort.summary.floors.length===2&&batch.cohort.summary.floors.every(f=>f.singleFloorProductivity===null),'Multilevel area split does not infer floor labor');
const floorAreas=batch.cohort.summary.floors.map(f=>f.area.numerator).sort();assert.deepEqual(floorAreas,['4','8']);check(true,'Exact1/3+2/3 splits12 square feet into4+8');
const categoryBuckets=batch.cohort.summary.groups.filter(g=>g.dimension==='category');assert.equal(categoryBuckets.reduce((sum,g)=>sum+BigInt(g.laborMicros),0n),BigInt(batch.cohort.summary.laborMicros));check(true,'Unknown classification conserves eligible project labor in its exclusive bucket');
for(const uid of [null,...unitCensus]){
 const prior=(await q('select work_activity_totals_read($1,$2) value',[id(10),uid])).value;assert.equal(prior.availability,'available');
 await as(id(2),'postgres');
 const ss=uid?(await q('select _work_unit_review_scope($1,$2) value',[id(2),uid])).value:null;
 const rr=uid?(await q('select _work_unit_review_view($1,$2::jsonb) value',[id(2),JSON.stringify(ss)])).value:null;
 const partitionIds=(await q('select _work_unit_metadata_shift_ids($1,$2,$3::jsonb) value',[id(10),uid,JSON.stringify(ss)])).value??[];
 const goldenMap={};for(const sid of partitionIds)goldenMap[sid]=(await q('select _work_totals_shift($1,$2,$3::timestamptz) value',[id(2),sid,prior.totals.asOf])).value;
 const parity=(await q('select _work_unit_metadata_partition($1,$2,$3,$4::timestamptz,$5::jsonb,$6::jsonb,$7::uuid[],$8::jsonb) value',[id(2),id(10),uid,prior.totals.asOf,JSON.stringify(ss),JSON.stringify(rr),partitionIds,JSON.stringify(goldenMap)])).value;
 assert.deepEqual(parity,prior,'FULL original0845 per-partition ledger/flags/reconciliation parity at original server asOf');
 await as(id(2));
}
check(true,'General and every unit preserve complete original0845 reply at one actual server asOf');

if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
// Isolated scenarios retain original fixture and invoke the real public writers.
const mscenario=async(label,fn)=>{await as(id(2),'postgres');await db.exec('savepoint metadata_scenario');try{await fn();}finally{await db.exec('rollback to savepoint metadata_scenario');await as(id(2),'postgres');}check(true,label);};
const merror=async(sql,args=[],code='23514')=>{await db.exec('savepoint metadata_expected_error');let actual;try{await q(sql,args);}catch(e){actual=e.code;}await db.exec('rollback to savepoint metadata_expected_error');assert.equal(actual,code);};
const mbatch=async()=>mrpc('project_batch','select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),'{}']);
const mrawCommand=(action,data)=>['select work_unit_metadata_command($1,1,$2::jsonb) value',[id(mi++),JSON.stringify({action,data})]];
await mscenario('Malformed null states and wrong typed values are rejected without receipts',async()=>{
 await as(id(2));const basis=(await mread()).metadata.metadataBasis;
 for(const patch of [{category:{state:null,versionId:category.versionId}},{fields:[{versionId:customWidth.versionId,state:null,value:'5'}]},{fields:[{versionId:customWidth.versionId,state:'known',value:5}]},{components:[{versionId:pane.versionId,quantity:'1e3'}]}])await merror(...mrawCommand('assign',{unitId:id(30),basis,classification:{...values,...patch}}));
 for(const dimension of [null,42])await merror(...mrawCommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId:null,definition:{kind:'group',code:'invalid_'+mi,labelEn:'Invalid',labelEs:'Invalid',dimension,members:[category.versionId]}}));
});
await mscenario('Floor vectors reject duplicate, inexact, cross-project and malformed rational weights',async()=>{
 await as(id(2));const basis=(await mread()).metadata.floorBasis;const foreign=await publish('floor','foreign',id(11));
 for(const shares of [[{versionId:floorOne.versionId,numerator:'1',denominator:'3'},{versionId:floorTwo.versionId,numerator:'1',denominator:'3'}],[{versionId:floorOne.versionId,numerator:'1',denominator:'2'},{versionId:floorOne.versionId,numerator:'1',denominator:'2'}],[{versionId:foreign.versionId,numerator:'1',denominator:'2'},{versionId:floorOne.versionId,numerator:'1',denominator:'2'}],[{versionId:floorOne.versionId,numerator:1,denominator:'2'},{versionId:floorTwo.versionId,numerator:'1',denominator:'2'}]])await merror(...mrawCommand('allocate',{...floorData,basis,shares}));
});
await mscenario('Actual installer author may assign; unrelated installer cannot; batch and publish remain restricted',async()=>{
 await as(id(3));const authorUnit=id(mi++);await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:authorUnit,revision:0,project_id:id(10),opening_id:null,label:'Author metadata',type_label:'Door',facts:{},dimension_observation:{width:10,height:20,unit:'in',source:'estimated'},expected_fact_revision:0})]);
 const own=await mread(authorUnit);assert.equal(own.metadata.capabilities.assign,true);assert.equal((await mcommand('assign',{unitId:authorUnit,basis:own.metadata.metadataBasis,classification:values})).receipt.status,'applied');
 const other=await mread();assert.equal(other.metadata.capabilities.assign,false);await merror(...mrawCommand('assign',{unitId:id(30),basis:other.metadata.metadataBasis,classification:values}),'42501');
 await merror('select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),'{}'],'42501');await merror(...mrawCommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId:null,definition:{kind:'material',code:'denied',labelEn:'Denied',labelEs:'Denied'}}),'42501');
});
await mscenario('Supervisor can propose and batch but cannot publish; global lead can assign subject to actual visibility',async()=>{
 await db.query("update profiles set role='supervisor' where id=$1",[id(3)]);await as(id(3));
 assert.equal((await mbatch()).availability,'available');const def={definitionId:id(mi++),expectedVersion:0,projectId:null,definition:{kind:'material',code:'draft',labelEn:'Draft',labelEs:'Draft'}};
 assert.equal((await mcommand('propose',def)).receipt.status,'applied');await merror(...mrawCommand('publish',def),'42501');
 const basis=(await mread()).metadata.metadataBasis;assert.equal((await mcommand('assign',{unitId:id(30),basis,classification:values})).receipt.status,'applied');
});
for(const mutation of ["access_revoked_at=clock_timestamp()","retired_at=clock_timestamp()","is_partner=true"]){await mscenario('Fresh actor admission refuses '+mutation,async()=>{await db.query('update profiles set '+mutation+' where id=$1',[id(2)]);await as(id(2));await merror('select work_unit_metadata_read($1,1) value',[id(30)],'42501');});}
await mscenario('Classification survives an actual new physical measurement while floor proof becomes noncurrent',async()=>{
 await as(id(1));const unitRow=(await q('select to_jsonb(u) value from custom_work_units u where id=$1',[id(30)])).value;
 const view=(await mread()).metadata;const oldClass=view.classification;
 // The original supported writer requires the actual current fact revision.
 await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:id(30),revision:unitRow.revision,project_id:id(10),opening_id:id(20),label:unitRow.label,type_label:unitRow.type_label,facts:Object.fromEntries(Object.entries(unitRow.facts).filter(([k])=>!['width_in','height_in','measurement_source','area_source'].includes(k))),dimension_observation:{width:37,height:48,unit:'in',source:'measured'},expected_fact_revision:view.floorBasis.factRevision})]);
 const after=(await mread()).metadata;assert.deepEqual(after.classification,oldClass);assert.equal(after.classification.state,'current');assert.equal(after.floor.current,false);await as(id(2));assert.deepEqual(await mrpc('receipt_after_measurement','select work_unit_metadata_receipt($1,1) value',[assignId]),assigned);assert.deepEqual(await mcommand('assign',assignData,assignId),assigned);
});
await mscenario('Binding ABA stays Noncurrent and stale floor basis cannot be accepted',async()=>{
 await db.query('update custom_work_units set opening_id=null where id=$1',[id(30)]);await db.query('update custom_work_units set opening_id=$2 where id=$1',[id(30),id(20)]);await as(id(2));
 const after=(await mread()).metadata;assert.equal(after.classification.state,'noncurrent');assert.equal(after.floor.current,false);
 assert.deepEqual(await mrpc('receipt_after_binding_aba','select work_unit_metadata_receipt($1,1) value',[assignId]),assigned);assert.deepEqual(await mcommand('assign',assignData,assignId),assigned);assert.equal((await mread()).metadata.classification.state,'noncurrent','Returning immutable receipt does not reapply old classification');
 const stale=await mcommand('allocate',floorData);assert.equal(stale.receipt.status,'rejected');
 const answer=await mbatch();assert.equal(answer.availability,'available');const row=answer.cohort.units.find(x=>x.unitId===id(30));assert.equal(row.classificationBuckets.category.state,'noncurrent');
});
await mscenario('Immutable definition rename keeps prior version labels and attachments; retirement rejects fresh assignment',async()=>{
 await as(id(2));const renamed=await mcommand('publish',{definitionId:aluminum.definitionId,expectedVersion:1,projectId:null,definition:{kind:'material',code:'aluminum',labelEn:'Renamed metal',labelEs:'Metal nuevo'}});assert.equal(renamed.receipt.status,'applied');
 const view=await mread();assert.equal(view.metadata.classification.state,'current');assert.equal(view.metadata.classification.values.frameMaterial.versionId,aluminum.versionId);assert.equal(view.metadata.catalog.find(x=>x.versionId===aluminum.versionId).definition.labelEn,'aluminum');
 await merror(...mrawCommand('assign',{unitId:id(30),basis:view.metadata.metadataBasis,classification:values}));
 const retired=await mcommand('retire',{definitionId:aluminum.definitionId,expectedVersion:2});assert.equal(retired.receipt.status,'applied');assert.equal((await mread()).metadata.classification.state,'current');
});
await mscenario('Exclusive grouping rejects sibling overlap and historical-ancestor cycles',async()=>{
 await as(id(2));const group=await publish('group','roots',null,{dimension:'category',members:[category.versionId,door.versionId]});
 await merror(...mrawCommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId:null,definition:{kind:'group',code:'overlap',labelEn:'Overlap',labelEs:'Overlap',dimension:'category',members:[category.versionId]}}));
 const child=await publish('group','child',null,{dimension:'category',members:[category.versionId],parentVersionId:group.versionId});
 await merror(...mrawCommand('publish',{definitionId:group.definitionId,expectedVersion:1,projectId:null,definition:{kind:'group',code:'roots',labelEn:'Cycle',labelEs:'Cycle',dimension:'category',members:[category.versionId],parentVersionId:child.versionId}}));
});
await mscenario('Missing dependent physical shift makes the complete batch generically unavailable',async()=>{
 await db.query('delete from time_shifts where id=$1',[shift.id]);await as(id(2));assert.deepEqual(await mbatch(),{protocolVersion:1,availability:'unavailable',cohort:null});
});
await mscenario('Pure temporary names cannot replace qualified authoritative sources',async()=>{
 await db.exec('create temporary table custom_work_units(id uuid);create temporary table _work_unit_metadata_revisions(id uuid);');await as(id(2));assert.equal((await mbatch()).availability,'available');
});
for(const ddl of ["alter table _work_unit_metadata_revisions disable row level security","alter table _work_unit_metadata_current drop constraint _work_unit_metadata_current_revision_id_fkey","alter table _work_unit_metadata_revisions disable trigger metadata_immutable","grant execute on function _work_unit_metadata_members(uuid[]) to authenticated","grant execute on function work_unit_cohorts_read(uuid,integer,jsonb) to service_role","create function _work_unit_metadata_unknown() returns int language sql as 'select 1'","create type _work_unit_metadata_unknown as enum('drift')"]){await mscenario('Exact new source guard refuses '+ddl,async()=>{await db.exec(ddl);assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);await as(id(2));assert.deepEqual(await mbatch(),{protocolVersion:1,availability:'unavailable',cohort:null});});}
await mscenario('Old immutable history and metadata private rows have no client/service raw access',async()=>{
 for(const role of ['anon','authenticated','service_role']){for(const table of metadataTables){assert.equal((await q("select has_table_privilege($1,$2,'SELECT') or has_any_column_privilege($1,$2,'SELECT') allowed",[role,'public.'+table])).allowed,false);}await as(id(2),role);await merror('select * from _work_unit_metadata_revisions',[],'42501');await as(id(2),'postgres');}
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
await mscenario('Unrelated unit bad payroll and General orphan do not contaminate eligible A; shared ledger parity remains exact',async()=>{
 await as(id(3));const bu=id(mi++);await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:bu,revision:0,project_id:id(10),opening_id:null,label:'Other partition',type_label:'Door',facts:{},dimension_observation:{width:24,height:48,unit:'in',source:'estimated'},expected_fact_revision:0})]);
 await q("select to_jsonb(sign_toolbox_talk($1,$2,null::uuid,'Synthetic signature',null::text,null::text,'Metadata partition fixture',clock_timestamp())) value",[id(mi++),id(3)]);
 const bs=(await q("select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1)) value",[id(10),id(mi++)])).value;
 const bd=id(mi++),bg=id(mi++);let bh=null,bn=0;
 const bc=async(action)=>{const snapshot=(await q('select work_activity_snapshot($1) value',[bd])).value;const now=new Date().toISOString();const cid=id(mi++);const payload={deviceId:bd,clientGeneration:bg,clientSequence:bn,predecessorCommandId:bh,expectedRevision:snapshot.state.revision,basis:{observationId:snapshot.observation.id},shiftRef:snapshot.observation.shiftRef,tappedAt:now,clockCheckedAt:now,clockSkewMs:0,intent:action};const answer=(await q('select work_activity_command($1,1,$2::jsonb) value',[cid,JSON.stringify(payload)])).value;assert.ok(['applied','noop'].includes(answer.receipt.status),JSON.stringify(answer));bn++;bh=cid;return answer;};
 await bc({kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null});await bc({kind:'finish_setup',projectId:id(10),costCodeId:null});
 const bv=(await q('select work_activity_unit_basis($1) value',[bu])).value.unit;const bb=Object.fromEntries(['id','operationalRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch'].map(k=>[k,bv[k]]));Object.assign(bb,{factId:bv.fact.id,factRevision:bv.fact.revision,originProjectEpoch:bv.fact.originProjectEpoch,originOpeningEpoch:bv.fact.originOpeningEpoch});await bc({...intent('specific'),unit:bb});
 await q('select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text)) value',[bs.id]);
 await as(id(2),'postgres');await db.query("insert into task_sessions(id,project_id,profile_id,state,started_at,ended_at) values($1,$2,$3,'on_task',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[id(mi++),id(10),id(3)]);
 await as(id(2));const answer=await mbatch();assert.equal(answer.availability,'available');const arow=answer.cohort.units.find(x=>x.unitId===id(30)),brow=answer.cohort.units.find(x=>x.unitId===bu);assert.equal(arow.eligible,true);assert.equal(brow.eligible,false);assert.equal(answer.cohort.general.complete,false);

 // C1: real selected eligible Window, unapproved timed Door, Unknown and
 // binding-noncurrent units. Filters apply to recorded/raw and trusted sets.
 await mcommand('assign',{unitId:id(30),basis:(await mread()).metadata.metadataBasis,classification:values});
 const doorValues={...values,category:{state:'known',versionId:door.versionId},subtype:{state:'unknown'}};
 await mcommand('assign',{unitId:bu,basis:(await mread(bu)).metadata.metadataBasis,classification:doorValues});
 const extras=[];
 for(const [label,width] of [['Unknown filter unit',12],['Noncurrent filter unit',18]]){
  const uid=id(mi++);extras.push(uid);await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:uid,revision:0,project_id:id(10),opening_id:null,label,type_label:'Unknown',facts:{},dimension_observation:{width,height:12,unit:'in',source:'estimated'},expected_fact_revision:0})]);
 }
 const noncurrent=extras[1];await mcommand('assign',{unitId:noncurrent,basis:(await mread(noncurrent)).metadata.metadataBasis,classification:values});
 await as(id(2),'postgres');const filterOpening=id(mi++);await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'C1-NONCURRENT')",[filterOpening,id(10)]);await db.query('update custom_work_units set opening_id=$2 where id=$1',[noncurrent,filterOpening]);await db.query('update custom_work_units set opening_id=null where id=$1',[noncurrent]);await as(id(2));
 const exactAdd=(left,right)=>{let n=BigInt(left.numerator)*BigInt(right.denominator)+BigInt(right.numerator)*BigInt(left.denominator),d=BigInt(left.denominator)*BigInt(right.denominator),a=n,b=d;while(b){const t=a%b;a=b;b=t;}return {numerator:String(n/a),denominator:String(d/a)};};
 const sumArea=rows=>rows.reduce((acc,row)=>row.rawArea===null?acc:exactAdd(acc,row.rawArea),{numerator:'0',denominator:'1'});
 const sumLabor=rows=>String(rows.reduce((acc,row)=>acc+BigInt(row.recorded.knownMicros),0n));
 const filtered=async(label,filter)=>{const reply=await mrpc(label,'select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),JSON.stringify(filter)]);assert.equal(reply.availability,'available');const c=reply.cohort,selected=c.units.filter(row=>row.selected),eligible=selected.filter(row=>row.eligible);assert.equal(c.summary.actualKnownMicros,sumLabor(selected));assert.deepEqual(c.summary.rawKnownArea,sumArea(selected));assert.equal(c.summary.laborMicros,sumLabor(eligible));assert.deepEqual(c.summary.area,sumArea(eligible));assert.deepEqual([...c.summary.eligibleUnitIds].sort(),eligible.map(row=>row.unitId).sort());return c;};
 const all=await filtered('c1_unfiltered',{});assert.equal(all.units.length,4);assert.ok(all.units.every(row=>row.selected));assert.equal(all.units.find(row=>row.unitId===extras[0]).metadata.classification.state,'unknown');assert.equal(all.units.find(row=>row.unitId===noncurrent).metadata.classification.state,'noncurrent');assert.ok(BigInt(all.units.find(row=>row.unitId===bu).recorded.knownMicros)>0n,'Real unapproved Door has recorded elapsed');
 const windows=await filtered('c1_window_filter',{categoryVersionIds:[category.versionId]});assert.deepEqual(windows.units.filter(row=>row.selected).map(row=>row.unitId),[id(30)]);assert.equal(windows.summary.laborMicros,windows.summary.actualKnownMicros);assert.ok(BigInt(windows.summary.laborMicros)>0n);assert.ok(BigInt(all.summary.actualKnownMicros)>BigInt(windows.summary.actualKnownMicros));
 const doors=await filtered('c1_door_filter',{categoryVersionIds:[door.versionId]});assert.deepEqual(doors.units.filter(row=>row.selected).map(row=>row.unitId),[bu]);assert.equal(doors.summary.laborMicros,'0');assert.deepEqual(doors.summary.area,{numerator:'0',denominator:'1'});assert.ok(BigInt(doors.summary.actualKnownMicros)>0n);assert.ok(BigInt(doors.summary.rawKnownArea.numerator)>0n);
 const empty=await filtered('c1_empty_filter',{categoryVersionIds:[]});assert.equal(empty.summary.actualKnownMicros,'0');assert.deepEqual(empty.summary.rawKnownArea,{numerator:'0',denominator:'1'});
 assert.equal(BigInt(all.summary.actualKnownMicros),BigInt(windows.summary.actualKnownMicros)+BigInt(doors.summary.actualKnownMicros));assert.deepEqual(all.summary.rawKnownArea,exactAdd(exactAdd(windows.summary.rawKnownArea,doors.summary.rawKnownArea),sumArea(all.units.filter(row=>extras.includes(row.unitId)))));
 const repeated=await filtered('c1_unfiltered_repeat',{});assert.deepEqual(repeated.summary,all.summary);check(true,'Filtered recorded/raw totals use the selected set; trusted subset and unfiltered conservation remain exact');
 for(const uid of [id(30),bu,null]){
 const prior=(await q('select work_activity_totals_read($1,$2) value',[id(10),uid])).value;assert.equal(prior.availability,'available');await as(id(2),'postgres');
 const s=uid?(await q('select _work_unit_review_scope($1,$2) value',[id(2),uid])).value:null,r=uid?(await q('select _work_unit_review_view($1,$2::jsonb) value',[id(2),JSON.stringify(s)])).value:null;
 const ids=(await q('select _work_unit_metadata_shift_ids($1,$2,$3::jsonb) value',[id(10),uid,JSON.stringify(s)])).value??[];const map={};for(const sid of ids)map[sid]=(await q('select _work_totals_shift($1,$2,$3::timestamptz) value',[id(2),sid,prior.totals.asOf])).value;
 const actual=(await q('select _work_unit_metadata_partition($1,$2,$3,$4::timestamptz,$5::jsonb,$6::jsonb,$7::uuid[],$8::jsonb) value',[id(2),id(10),uid,prior.totals.asOf,JSON.stringify(s),JSON.stringify(r),ids,JSON.stringify(map)])).value;assert.deepEqual(actual,prior);await as(id(2));
 }
});
await mscenario('Actual empty project is complete with null productivity and no fabricated area',async()=>{
 const empty=id(mi++);await db.query("insert into projects(id,job_code,name) values($1,$2,'Empty cohort')",[empty,'METADATA-EMPTY-'+mi]);await as(id(2));const answer=await mrpc('empty_project','select work_unit_cohorts_read($1,1,$2::jsonb) value',[empty,'{}']);assert.equal(answer.availability,'available');assert.equal(answer.cohort.units.length,0);assert.equal(answer.cohort.summary.area.numerator,'0');assert.equal(answer.cohort.summary.hoursPerSquareFoot,null);
});
await mscenario('100-unit cap plus one returns only generic unavailable',async()=>{
 await as(id(2));for(let n=unitCensus.length;n<101;n++)await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:id(mi++),revision:0,project_id:id(10),opening_id:null,label:'Cap unit '+n,type_label:'Unclassified',facts:{}})]);
 assert.deepEqual(await mbatch(),{protocolVersion:1,availability:'unavailable',cohort:null});
});
await mscenario('General501 real retained orphan rows cause whole generic refusal, not a partial denominator',async()=>{
 await db.query("insert into task_sessions(id,project_id,profile_id,state,started_at,ended_at) select md5('metadata-cap-orphan-'||g)::uuid,$1,$2,'on_task',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour' from generate_series(1,501)g",[id(10),id(3)]);await as(id(2));assert.deepEqual(await mbatch(),{protocolVersion:1,availability:'unavailable',cohort:null});
});
await mscenario('Exact rational conversion retains mm/cm/in/ft equivalence and tiny differences',async()=>{
 for(const [width,height,unit] of [['304.8','304.8','mm'],['30.48','30.48','cm'],['12','12','in'],['1','1','ft']]){const area=(await q('select _work_unit_metadata_area($1::jsonb) value',[JSON.stringify({observation:{widthDecimal:width,heightDecimal:height,unit}})])).value;assert.deepEqual(area,{numerator:'1',denominator:'1'});}
 const tiny=(await q('select _work_unit_metadata_area($1::jsonb) value',[JSON.stringify({observation:{widthDecimal:'1.0000000000000000000000000000000000000001',heightDecimal:'1',unit:'ft'}})])).value;assert.notEqual(tiny.numerator,tiny.denominator);
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
await mscenario('Custom exact-parent groups conserve known, Unknown and unassigned children without cross-level summation',async()=>{
 await as(id(2));const parent=await publish('group','partition_roots',null,{dimension:'category',members:[category.versionId,door.versionId]});
 const child=await publish('group','partition_window',null,{dimension:'category',members:[category.versionId],parentVersionId:parent.versionId});
 let answer=await mbatch();let roots=answer.cohort.summary.customGroups.trees.find(t=>t.dimension==='category').groups.filter(g=>g.parentVersionId===null);assert.ok(roots.some(g=>g.state==='unknown'));assert.equal(roots.reduce((n,g)=>n+BigInt(g.laborMicros),0n),BigInt(answer.cohort.summary.laborMicros));
 await mcommand('assign',{unitId:id(30),basis:(await mread()).metadata.metadataBasis,classification:{...values,category:{state:'known',versionId:door.versionId},subtype:{state:'unknown'}}});
 answer=await mbatch();const parentRow=answer.cohort.summary.customGroups.trees.find(t=>t.dimension==='category').groups.find(g=>g.versionId===parent.versionId);const children=answer.cohort.summary.customGroups.trees.find(t=>t.dimension==='category').groups.filter(g=>g.parentVersionId===parent.versionId);assert.ok(children.some(g=>g.state==='unassigned'));assert.equal(children.reduce((n,g)=>n+BigInt(g.laborMicros),0n),BigInt(parentRow.laborMicros));assert.deepEqual(children[0].area,parentRow.area);
 await mcommand('publish',{definitionId:parent.definitionId,expectedVersion:1,projectId:null,definition:{kind:'group',code:'partition_roots',labelEn:'Renamed parent',labelEs:'Renamed parent',dimension:'category',members:[category.versionId,door.versionId]}});
 const isolated=await mbatch();assert.equal(isolated.availability,'available');assert.equal(isolated.cohort.summary.customGroups.availability,'unavailable');assert.equal(isolated.cohort.summary.customGroups.trees[0].groups,null);assert.equal(isolated.cohort.summary.laborMicros,answer.cohort.summary.laborMicros);assert.deepEqual(isolated.cohort.summary.area,answer.cohort.summary.area);
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
await mscenario('Dangling category tree cannot poison independent material tree or primary filtered totals',async()=>{
 await as(id(2));const parent=await publish('group','isolation_category',null,{dimension:'category',members:[category.versionId,door.versionId]});await publish('group','isolation_child',null,{dimension:'category',members:[category.versionId],parentVersionId:parent.versionId});
 await publish('group','isolation_material',null,{dimension:'material',members:[aluminum.versionId]});
 await mcommand('assign',{unitId:id(30),basis:(await mread()).metadata.metadataBasis,classification:values});
 const before=await mbatch();await mcommand('publish',{definitionId:parent.definitionId,expectedVersion:1,projectId:null,definition:{kind:'group',code:'isolation_category',labelEn:'Replacement',labelEs:'Replacement',dimension:'category',members:[category.versionId,door.versionId]}});
 const after=await mrpc('custom_tree_partial_filtered','select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),JSON.stringify({categoryVersionIds:[category.versionId]})]);assert.equal(after.availability,'available');assert.equal(after.cohort.summary.customGroups.availability,'partial');assert.equal(after.cohort.summary.customGroups.trees.find(x=>x.dimension==='category').groups,null);assert.equal(after.cohort.summary.customGroups.trees.find(x=>x.dimension==='frameMaterial').availability,'available');assert.equal(after.cohort.summary.laborMicros,before.cohort.summary.laborMicros);assert.deepEqual(after.cohort.summary.area,before.cohort.summary.area);
});
await mscenario('Empty and zero-selection trees are available empty, distinct from unavailable',async()=>{
 await as(id(2));const empty=await mbatch();assert.deepEqual(empty.cohort.summary.customGroups,{availability:'available',trees:[]});
 await publish('group','empty_selection',null,{dimension:'category',members:[category.versionId]});
 const answer=await mrpc('zero_selection_tree','select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),JSON.stringify({categoryVersionIds:[]})]);assert.equal(answer.cohort.summary.laborMicros,'0');assert.equal(answer.cohort.summary.customGroups.availability,'available');assert.deepEqual(answer.cohort.summary.customGroups.trees[0].groups,[]);assert.equal(answer.cohort.summary.hoursPerSquareFoot,null);
});
await mscenario('Current known historical classification/filter survives definition retirement without regrouping area',async()=>{
 await as(id(2));await mcommand('assign',{unitId:id(30),basis:(await mread()).metadata.metadataBasis,classification:values});await publish('group','historical_window',null,{dimension:'category',members:[category.versionId]});
 await mcommand('retire',{definitionId:category.definitionId,expectedVersion:1});const answer=await mrpc('historical_category_filter','select work_unit_cohorts_read($1,1,$2::jsonb) value',[id(10),JSON.stringify({categoryVersionIds:[category.versionId]})]);assert.equal(answer.availability,'available');assert.equal(answer.cohort.units[0].metadata.classification.state,'current');assert.equal(answer.cohort.units[0].classificationBuckets.category.state,'known');assert.equal(answer.cohort.units[0].eligible,true);assert.equal(answer.cohort.summary.customGroups.availability,'available');
});
await mscenario('Noncurrent classification conserves physically reapproved unit in primary and custom root residuals',async()=>{
 await as(id(2));await publish('group','noncurrent_root',null,{dimension:'category',members:[category.versionId]});
 await as(id(2),'postgres');await db.query('update custom_work_units set opening_id=null where id=$1',[id(30)]);await db.query('update custom_work_units set opening_id=$2 where id=$1',[id(30),id(20)]);await as(id(2));
 await as(id(1));const unitRow=(await q('select to_jsonb(u) value from custom_work_units u where id=$1',[id(30)])).value;const factBasis=(await mread()).metadata.floorBasis;
 await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:id(30),revision:unitRow.revision,project_id:id(10),opening_id:id(20),label:unitRow.label,type_label:unitRow.type_label,facts:Object.fromEntries(Object.entries(unitRow.facts).filter(([k])=>!['width_in','height_in','measurement_source','area_source'].includes(k))),dimension_observation:{width:36,height:48,unit:'in',source:'estimated'},expected_fact_revision:factBasis.factRevision})]);await as(id(2));
 for(const [action,data] of [['reopen',{note:'Synthetic binding revalidation'}],['verify_dimensions',{widthDecimal:'36',heightDecimal:'48',unit:'in',source:'measured',sourceReference:null}],['submit',{note:null}],['pass',{note:null}]]){const reply=await reviewCommand(action,data);assert.equal(reply.outcome,'applied',JSON.stringify(reply));}
 const answer=await mbatch();assert.equal(answer.availability,'available');const row=answer.cohort.units.find(x=>x.unitId===id(30));assert.equal(row.eligible,true);assert.equal(row.metadata.classification.state,'noncurrent');const residual=answer.cohort.summary.customGroups.trees.find(x=>x.dimension==='category').groups.find(x=>x.state==='noncurrent');assert.equal(residual.laborMicros,answer.cohort.summary.laborMicros);assert.deepEqual(residual.area,answer.cohort.summary.area);
});
await mscenario('General501 actual closed shifts cause whole generic refusal before ledger assembly',async()=>{
 await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status) select md5('metadata-cap-shift-'||g)::uuid,$1,$2,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour','submitted' from generate_series(1,501)g",[id(3),id(10)]);await as(id(2));assert.deepEqual(await mbatch(),{protocolVersion:1,availability:'unavailable',cohort:null});
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

await mscenario('Rejected stale caller binding is not retained authority and cannot poison future reads',async()=>{
 await as(id(2));const before=await mread();const stale=structuredClone(before.metadata.metadataBasis);stale.binding.projectId=id(777777);stale.binding.projectEpoch='0';
 const reply=await mcommand('assign',{unitId:id(30),basis:stale,classification:values});assert.equal(reply.receipt.status,'rejected');const after=await mread();assert.equal(after.availability,'available');assert.deepEqual(after.metadata.classification,before.metadata.classification);
 await merror(...mrawCommand('assign',{unitId:id(30),basis:null,classification:values}));await merror(...mrawCommand('assign',{unitId:id(30),basis:{...stale,metadataRevision:1.5},classification:values}));
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

await mscenario('New unique-index semantics are exact catalog evidence, not just index names',async()=>{
 await db.exec('drop index work_unit_metadata_definition_global;create unique index work_unit_metadata_definition_global on _work_unit_metadata_definitions(id) where project_id is null');assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
await mscenario('Original unassigned author context cannot be laundered through a current visible project',async()=>{
 await as(id(1));const uid=id(mi++);await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:uid,revision:0,project_id:null,opening_id:null,label:'Unassigned origin',type_label:'Unknown',facts:{}})]);
 const original=await mread(uid);const applied=await mcommand('assign',{unitId:uid,basis:original.metadata.metadataBasis,classification:values});assert.equal(applied.receipt.status,'applied');
 const row=(await q('select to_jsonb(u) value from custom_work_units u where id=$1',[uid])).value;await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:uid,revision:row.revision,project_id:id(10),opening_id:null,label:row.label,type_label:row.type_label,facts:row.facts,reason:'Explicit synthetic job assignment'})]);
 await as(id(2),'postgres');await db.query("update profiles set role='foreman' where id=$1",[id(3)]);await as(id(3));assert.deepEqual(await mread(uid),{protocolVersion:1,availability:'unavailable',metadata:null});
 await as(id(1));assert.equal((await mread(uid)).availability,'available');
});
await mscenario('Operational unit deletion retains new immutable histories and refuses old receipts',async()=>{
 const before=(await q('select (select count(*) from _work_unit_metadata_revisions where unit_id=$1)::int revisions,(select count(*) from _work_unit_metadata_floors where unit_id=$1)::int floors',( [id(30)]))).revisions;
 await db.query('delete from custom_work_units where id=$1',[id(30)]);assert.equal((await q('select count(*)::int n from _work_unit_metadata_revisions where unit_id=$1',[id(30)])).n,before);await as(id(2));assert.deepEqual(await mread(),{protocolVersion:1,availability:'unavailable',metadata:null});assert.equal((await mrpc('deleted_unit_receipt','select work_unit_metadata_receipt($1,1) value',[assignId])).availability,'unavailable');
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

for(const drift of [null,'grant select(actor_id) on _work_unit_metadata_revisions to authenticated','alter table _work_unit_metadata_commands add column unreviewed text',"create or replace function _work_unit_metadata_fraction(n numeric,d numeric) returns jsonb language sql immutable set search_path=public,pg_temp as 'select null::jsonb'"])await mscenario('Independently pinned admitted boundaries reject select-true attester with '+(drift??'otherwise unchanged source'),async()=>{
 await as(id(2));const view=await mread();assert.equal(view.availability,'available');assert.equal((await mbatch()).availability,'available');assert.equal((await mrpc('attester_positive_receipt','select work_unit_metadata_receipt($1,1) value',[assignId])).availability,'available');
 const payload={unitId:id(30),basis:view.metadata.metadataBasis,classification:values};
 await as(id(2),'postgres');await db.exec("create or replace function _work_unit_metadata_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as 'select true'");if(drift)await db.exec(drift);
 assert.equal((await q('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() ok')).ok,true,'Old guards still admit, so refusal cannot be masked');
 await as(id(2));assert.deepEqual(await mread(),{protocolVersion:1,availability:'unavailable',metadata:null});assert.deepEqual(await mbatch(),{protocolVersion:1,availability:'unavailable',cohort:null});assert.deepEqual(await mcommand('assign',payload),{protocolVersion:1,availability:'unavailable',receipt:null});assert.deepEqual(await mrpc('attester_refused_receipt','select work_unit_metadata_receipt($1,1) value',[assignId]),{protocolVersion:1,availability:'unavailable',receipt:null});
});
await mscenario('Immutable expected proof cannot be overwritten, deleted, truncated or supplemented',async()=>{
 for(const sql of ["update _work_unit_metadata_contract set expected_catalog_sha256=repeat('0',64)",'delete from _work_unit_metadata_contract','truncate _work_unit_metadata_contract'])await merror(sql,[],'23514');
 await merror("insert into _work_unit_metadata_contract values('metadata_v1',repeat('0',64))",[],'23505');assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,true);
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

for(const ddl of ["alter function _work_unit_metadata_fraction(numeric,numeric) cost 101","alter table _work_unit_metadata_commands alter column recorded_at set default '1970-01-01'::timestamptz","alter table _work_unit_metadata_commands force row level security"])await mscenario('Expanded exact metadata refuses '+ddl,async()=>{await db.exec(ddl);assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);await as(id(2));assert.equal((await mbatch()).availability,'unavailable');});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

await mscenario('Recreated UUID retains history but cannot expose or duplicate a prior incarnation receipt',async()=>{
 await as(id(1));const uid=id(mi++);const create={id:uid,revision:0,project_id:id(10),opening_id:null,label:'Receipt incarnation',type_label:'Unknown',facts:{}};
 await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify(create)]);
 const initial=await mread(uid),cid=id(mi++),payload={unitId:uid,basis:initial.metadata.metadataBasis,classification:values};assert.equal((await mcommand('assign',payload,cid)).receipt.status,'applied');
 await as(id(1),'postgres');await db.query('delete from custom_work_units where id=$1',[uid]);await as(id(1));
 await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify(create)]);
 const fresh=await mread(uid);assert.equal(fresh.availability,'available');assert.notEqual(fresh.metadata.metadataBasis.binding.incarnation,initial.metadata.metadataBasis.binding.incarnation);assert.equal(fresh.metadata.classification.state,'noncurrent');
 assert.deepEqual(await mrpc('recreated_unit_receipt','select work_unit_metadata_receipt($1,1) value',[cid]),{protocolVersion:1,availability:'unavailable',receipt:null});assert.equal((await mcommand('assign',payload,cid)).availability,'unavailable');
 assert.equal((await mcommand('assign',{...payload,basis:fresh.metadata.metadataBasis})).receipt.status,'applied');await as(id(1),'postgres');assert.equal((await q('select count(*)::int n from _work_unit_metadata_revisions where unit_id=$1',[uid])).n,2);
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

await mscenario('QA sandbox-scoped commands succeed; global and real-job refusals are atomic across all metadata and physical history',async()=>{
 const qa=id(mi++),sandbox=id(mi++),sandboxUnit=id(mi++);
 await db.query('insert into auth.users(id) values($1)',[qa]);await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Metadata QA','owner',true)",[qa]);
 await db.query("insert into projects(id,job_code,name,is_test) values($1,$2,'Metadata QA sandbox',true)",[sandbox,'META-QA-'+mi]);await db.query("insert into sandbox_projects(project_id,note) values($1,'Synthetic metadata guard test')",[sandbox]);
 await as(qa);await q("select to_jsonb(custom_work_command($1,'unit',$2::jsonb)) value",[id(mi++),JSON.stringify({id:sandboxUnit,revision:0,project_id:sandbox,opening_id:null,label:'Sandbox metadata unit',type_label:'Unknown',facts:{}})]);
 const qaFloor=await publish('floor','qa_floor',sandbox);assert.ok(qaFloor.versionId);
 assert.equal((await mcommand('propose',{definitionId:id(mi++),expectedVersion:0,projectId:sandbox,definition:{kind:'floor',code:'qa_proposal',labelEn:'QA floor',labelEs:'QA'}})).receipt.status,'applied');
 assert.equal((await mcommand('assign',{unitId:sandboxUnit,basis:(await mread(sandboxUnit)).metadata.metadataBasis,classification:values})).receipt.status,'applied');
 check(true,'QA Owner can publish/propose/assign on actual authorized sandbox scope');
 const census=async()=>{await as(id(2),'postgres');const result={};for(const table of [...metadataTables,'custom_work_units','custom_work_history','work_unit_fact_revisions','work_unit_fact_current','work_unit_review_events','work_unit_review_current','time_shifts','custom_work_sessions','work_activity_source_history'])result[table]=(await q(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from public.${table} t`)).value;return result;};
 const atomic=async(label,run)=>{const before=await census();await as(qa);await run();const after=await census();assert.deepEqual(after,before,label);check(true,label);};
 await atomic('QA global definition publish refuses with no metadata/floor/fact/payroll mutation',async()=>{await merror(...mrawCommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId:null,definition:{kind:'material',code:'qa_global',labelEn:'QA global',labelEs:'QA'}}),'42501');});
 await atomic('QA null-project proposal refuses atomically by standard guard',async()=>{await merror(...mrawCommand('propose',{definitionId:id(mi++),expectedVersion:0,projectId:null,definition:{kind:'material',code:'qa_global_proposal',labelEn:'QA',labelEs:'QA'}}),'42501');});
 await atomic('QA real-job publication is unavailable before private IDs or writes',async()=>{assert.equal((await mcommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId:id(10),definition:{kind:'floor',code:'qa_real',labelEn:'QA real',labelEs:'QA'}})).availability,'unavailable');});
 await atomic('QA real-job assignment and foreign receipt remain generic unavailable',async()=>{assert.equal((await mcommand('assign',assignData)).availability,'unavailable');assert.equal((await mrpc('qa_foreign_receipt','select work_unit_metadata_receipt($1,1) value',[assignId])).availability,'unavailable');});
 await atomic('QA scope-kind mismatch rejects before any immutable write',async()=>{await merror(...mrawCommand('publish',{definitionId:id(mi++),expectedVersion:0,projectId:sandbox,definition:{kind:'material',code:'qa_wrong_scope',labelEn:'Wrong scope',labelEs:'QA'}}));});
 // Owner-internal SQL retaining a QA JWT deliberately exercises the DB guard.
 // This does not grant QA raw access or imply these private paths are public.
 for(const project of [null,id(10)])for(const table of ['definitions','proposals','commands'])await atomic('DB guard rejects QA '+table+' '+(project===null?'null global':'real project')+' without partial rows',async()=>{
  await as(qa,'postgres');let sql,args;const cid=id(mi++);
  if(table==='definitions'){sql="insert into _work_unit_metadata_definitions(id,kind,code,project_id,actor_id) values($1,$2,$3,$4,$5)";args=[cid,project===null?'material':'floor','qa_raw_'+mi,project,qa];}
  if(table==='proposals'){sql="insert into _work_unit_metadata_proposals(id,actor_id,command_id,project_id,value) values($1,$2,$3,$4,'{}')";args=[cid,qa,id(mi++),project];}
  if(table==='commands'){sql="insert into _work_unit_metadata_commands(command_id,actor_id,project_id,origin_jobs,request,result) values($1,$2,$3,'[]','{}','{}')";args=[cid,qa,project];}
  await merror(sql,args,'42501');
 });
 await as(id(2),'postgres');await db.query('update projects set deleted_at=clock_timestamp() where id=$1',[sandbox]);await atomic('QA hidden sandbox project metadata read and command are unavailable',async()=>{assert.equal((await mread(sandboxUnit)).availability,'unavailable');assert.equal((await mcommand('propose',{definitionId:id(mi++),expectedVersion:0,projectId:sandbox,definition:{kind:'floor',code:'qa_hidden',labelEn:'Hidden',labelEs:'QA'}})).availability,'unavailable');});
});
for(const table of ['commands','definitions','proposals'])await mscenario('New sandbox guard disabled on '+table+' is independently refused with old guards still true',async()=>{
 await as(id(2));assert.equal((await mread()).availability,'available');await as(id(2),'postgres');await db.exec('alter table _work_unit_metadata_'+table+' disable trigger guard_test_account_sandbox_only');assert.equal((await q('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() ok')).ok,true);assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);await as(id(2));assert.equal((await mread()).availability,'unavailable');assert.equal((await mbatch()).availability,'unavailable');assert.equal((await mcommand('assign',assignData)).availability,'unavailable');assert.equal((await mrpc('sandbox_guard_receipt_refusal','select work_unit_metadata_receipt($1,1) value',[assignId])).availability,'unavailable');
});
for(const body of ["create or replace function guard_test_account_sandbox_only() returns trigger language plpgsql security definer set search_path=public as $$begin return new;end$$", "create or replace function attach_sandbox_guards() returns table(table_name text,link_column text,link_kind text,action text) language plpgsql security definer set search_path=public,pg_temp as $$begin return;end$$", "create or replace function sandbox_scoped_tables() returns table(table_name text,link_column text,link_kind text) language sql stable security definer set search_path=public,pg_temp as $$select null::text,null::text,null::text where false$$", "create or replace function row_project_id(p_kind text,p_value text) returns uuid language sql stable security definer set search_path=public as $$select null::uuid$$"])await mscenario('Sandbox dependency body mutation independently fails exact metadata guard',async()=>{
 await db.exec(body);assert.equal((await q('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() ok')).ok,true);assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);await merror(preflight,[],'55000');await as(id(2));assert.equal((await mread()).availability,'unavailable');
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');

for(const table of ['commands','definitions','proposals'])await mscenario('Wrong sandbox trigger arguments on '+table+' refuse without old-guard masking',async()=>{
 await db.exec("drop trigger guard_test_account_sandbox_only on _work_unit_metadata_"+table+";create trigger guard_test_account_sandbox_only before insert or update or delete on _work_unit_metadata_"+table+" for each row execute function guard_test_account_sandbox_only('project_id','opening')");assert.equal((await q('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage() ok')).ok,true);assert.equal((await q('select _work_unit_metadata_coverage() ok')).ok,false);await as(id(2));assert.equal((await mbatch()).availability,'unavailable');
});
if(process.env.WORK_UNIT_METADATA_WIRE_OUT)writeFileSync(process.env.WORK_UNIT_METADATA_WIRE_OUT,JSON.stringify({sourceSha256:hash(metadataSql),calls:metadataWire},null,2)+'\n');
