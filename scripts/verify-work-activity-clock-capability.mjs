// Disposable source-matched fixture only. --build emits the reviewed migration
// from its exact post-cutover catalog; normal execution refuses any source drift.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where}));process.exit(1);});
const module=process.env.PGLITE_MODULE??'@electric-sql/pglite';
const moduleUrl=isAbsolute(module)?pathToFileURL(module).href:import.meta.resolve(module);
const {PGlite}=await import(moduleUrl);
const {pgcrypto}=await import(new URL('./contrib/pgcrypto.js',moduleUrl));
const {uuid_ossp}=await import(new URL('./contrib/uuid_ossp.js',moduleUrl));
const hash=s=>createHash('sha256').update(s).digest('hex');
const root=new URL('../',import.meta.url);
const cutover=readFileSync(new URL('supabase/migrations/20261108410000_work_activity_engine_cutover.sql',root),'utf8');
const cutoverHash='aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648';
assert.equal(hash(cutover),cutoverHash,'Cutover source changed; deliberately review and regenerate the completion contract');
const schema=readFileSync(new URL('scripts/fixtures/work-activity-engine-online-schema.sql',root),'utf8');
assert.equal(hash(schema),'ee41a980b19f76baa8637101b62703ecdf798a32eccbb0e9f074fbfd71c62471');
const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});
const q=async(s,a=[])=>(await db.query(s,a)).rows[0];
await db.exec(schema);
await db.exec(cutover.slice(cutover.indexOf('-- INSTALLED_SOURCE_GUARD:'),cutover.indexOf('-- INSTALLED_GRAPH_GUARD:')));
await db.exec('begin;'+cutover.slice(cutover.indexOf('-- DEVELOPMENT_PRIVATE_PREFIX:')).replace(/rollback;\s*$/,'commit;'));
await db.exec('set search_path=public,pg_temp');
// Hash semantic source/authority, not OIDs, timestamps, grant ordering or provider
// service-role default EXECUTE. PUBLIC/anon/authenticated permissions are exact.
const functionValue=`jsonb_build_object('body',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile,'kind',p.prokind,'language',l.lanname,'returns',pg_get_function_result(p.oid),'config',p.proconfig,'public',exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'))`;
const contract=(await db.query(`select p.proname name,pg_get_function_identity_arguments(p.oid) args,${functionValue} value from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' and l.lanname in ('sql','plpgsql') and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows;
const triggerValue=`jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)`;
const triggers=(await db.query(`select c.relname relation,t.tgname name,${triggerValue} value from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`)).rows;
const tables=(await db.query(`select c.relname name,jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity) order by a.attnum) columns from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind='r' and (c.relname like 'work_activity_%' or c.relname like 'personal_activity_%' or c.relname in ('work_setup_sessions','work_session_capture_metadata')) group by c.relname order by c.relname`)).rows;
const essentialNames=['clock_in','start_break','end_break','clock_out','work_activity_clock_receipt','_work_activity_gate','_work_activity_actor','_work_activity_read_committed','_toolbox_gate_open','_toolbox_signed_today','_work_config_internal','_work_activity_clock_replay_guard','_work_activity_mirror_clock_receipt','_work_activity_clock_setup_digest','_work_activity_claim_clock_setup','_work_activity_keep_clock_receipt'];
const runtime=contract.filter(x=>essentialNames.includes(x.name));
assert.ok(contract.length>650&&triggers.length>300&&tables.length>15&&runtime.length>15,'Completion contract unexpectedly small');
const checkFunctions=(name,list)=>`for e in select value from jsonb_array_elements($${name}$${JSON.stringify(list)}$${name}$::jsonb) loop
 select ${functionValue} into actual from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
 where n.nspname='public' and p.proname=e->>'name' and pg_get_function_identity_arguments(p.oid)=e->>'args';
 if actual is distinct from e->'value' then raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 end loop;`;
const marker=hash(JSON.stringify({cutoverHash,contract,triggers,tables}));
const migration=`-- Read-only readiness for the explicit paid-setup protocol. No activation.
-- Generated completion evidence: frozen cutover SHA256 ${cutoverHash}.
-- Reproduce with verify-work-activity-clock-capability.mjs --build on the pinned
-- source-matched fixture. Root's installed-source guards remain mandatory.
-- This verifies all represented application routines/triggers, not provider
-- extension internals. Extra independent read-only migrations are allowed.
begin;
set local search_path=public,pg_temp;
do $completion$
declare e jsonb;actual jsonb;relation_oid oid;role_name text;
begin
 ${checkFunctions('routines',contract)}
 for e in select value from jsonb_array_elements($triggers$${JSON.stringify(triggers)}$triggers$::jsonb) loop
 select ${triggerValue} into actual from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname=e->>'relation' and t.tgname=e->>'name' and not t.tgisinternal;
 if actual is distinct from e->'value' then raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 end loop;
 for e in select value from jsonb_array_elements($tables$${JSON.stringify(tables)}$tables$::jsonb) loop
 relation_oid:=to_regclass(format('public.%I',e->>'name'));
 if relation_oid is null or not (select relrowsecurity from pg_class where oid=relation_oid) then raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity) order by a.attnum) into actual
 from pg_attribute a where a.attrelid=relation_oid and a.attnum>0 and not a.attisdropped;
 if actual is distinct from e->'columns' then raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 foreach role_name in array array['anon','authenticated'] loop
 if has_table_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(role_name,relation_oid,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 end loop;
 end loop;
end;$completion$;
-- No mutable deployment row, history identity, user-controlled GUC or flag can
-- manufacture completion. Only a trusted migration owner can replace this
-- private constant, installed atomically after the full contract above.
create function public._work_activity_clock_contract_marker() returns text
language sql immutable security definer set search_path=public,pg_temp as $marker$
 select '${marker}'::text
$marker$;
revoke all on function public._work_activity_clock_contract_marker() from public,anon,authenticated,service_role;

create function public.work_activity_clock_capability() returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $capability$
declare actor uuid;as_of timestamptz;enabled boolean;generation bigint;s public.personal_activity_state;
 mode text;reason text;author_setup boolean:=false;e jsonb;actual jsonb;
begin
 perform public._work_activity_read_committed();
 perform public._work_activity_gate();actor:=public._work_activity_actor();as_of:=clock_timestamp();
 if public._work_activity_clock_contract_marker() is distinct from '${marker}' then
 raise exception using errcode='55000',message='Clock protocol is unavailable.';end if;
 -- Bounded cheap runtime drift check, after caller permission. The complete
 -- installation contract above covers every transformed entry and callback.
 ${checkFunctions('protocol',runtime)}
 select capture_enabled,revision into enabled,generation from public.work_activity_authority_generation where singleton;
 select * into s from public.personal_activity_state where profile_id=actor;
 if enabled is null or generation is null or generation>=9007199254740991
  or (s.profile_id is not null and (s.integrity_state<>'clean' or s.revision>=9007199254740991))
  or exists(select 1 from public.work_activity_safety_events where profile_id=actor) then
 mode:='unavailable';reason:='not_ready';
 elsif not enabled then mode:='closing_only';reason:='starts_disabled';
 else
 -- The exact setup_v1 root may start paid setup before signing. Ordinary
 -- overloads keep their existing toolbox/company-date policy.
 mode:='active';author_setup:=true;
 end if;
 return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(as_of),
 'clockProtocol','setup_v1','receiptProtocol','retained_v1','mode',mode,'canAuthorSetup',author_setup,'setupReason',reason,
 'canDispatchExistingSetup',true,'canReadOwnReceipts',true,'canDispatchPayrollSafety',true);
exception when undefined_function or undefined_table or undefined_column then
 raise exception using errcode='55000',message='Clock protocol is unavailable.';
end;$capability$;
revoke all on function public.work_activity_clock_capability() from public,anon,authenticated,service_role;
grant execute on function public.work_activity_clock_capability() to authenticated;
commit;
`;
const path=new URL('supabase/migrations/20261108430000_work_activity_clock_capability.sql',root);
if(process.argv.includes('--build')) writeFileSync(path,migration);
else assert.equal(readFileSync(path,'utf8'),migration,'Capability migration/contract drift; do not silently regenerate during tests');
await db.exec(migration);
const completionGuard=migration.slice(migration.indexOf('do $completion$'),migration.indexOf('-- No mutable deployment row'));
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;};
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const as=async(uid,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid??'']);await db.exec('set role '+role);};
const read=async()=> (await q('select work_activity_clock_capability() value')).value;
async function refused(sql,args=[],code='42501'){
 await db.exec('savepoint expected_refusal');let failure;
 try{await db.query(sql,args);}catch(e){failure=e;}
 assert.equal(failure?.code,code,failure?.message??'Expected refusal');
 await db.exec('rollback to savepoint expected_refusal');checks++;
}
const matrix=(v,mode,reason,author)=>{
 assert.deepEqual(Object.keys(v).sort(),['protocolVersion','asOf','clockProtocol','receiptProtocol','mode','canAuthorSetup','setupReason','canDispatchExistingSetup','canReadOwnReceipts','canDispatchPayrollSafety'].sort());
 assert.equal(v.protocolVersion,1);assert.equal(v.clockProtocol,'setup_v1');assert.equal(v.receiptProtocol,'retained_v1');
 assert.equal(v.mode,mode);assert.equal(v.setupReason,reason);assert.equal(v.canAuthorSetup,author);
 for(const k of ['canDispatchExistingSetup','canReadOwnReceipts','canDispatchPayrollSafety'])assert.equal(v[k],true);
 assert.ok(Number.isFinite(Date.parse(v.asOf)));checks++;
};
await db.exec('begin');
await db.query('insert into auth.users(id) values($1),($2),($3),($4)',[id(1),id(2),id(3),id(4)]);
await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Synthetic active','installer',false),($2,'Synthetic revoked','owner',false),($3,'Synthetic partner','foreman',false),($4,'Synthetic retired','installer',false)",[id(1),id(2),id(3),id(4)]);
await db.query('update profiles set access_revoked_at=clock_timestamp() where id=$1',[id(2)]);
await db.query('update profiles set is_partner=true where id=$1',[id(3)]);
await db.query('update profiles set retired_at=clock_timestamp() where id=$1',[id(4)]);
await db.exec('commit');
// A real read-only transaction prevents any hidden lazy initialization/write.
await as(id(1));await db.exec('begin read only');matrix(await read(),'closing_only','starts_disabled',false);await db.exec('commit');
await as(null,'postgres');await db.exec('begin');
check((await q('select count(*)::int n from personal_activity_state')).n===0,'Read never lazily creates state');
check((await q('select count(*)::int n from work_activity_observations')).n===0,'Read creates no observation');
check((await q('select count(*)::int n from work_activity_clock_receipts')).n===0,'Read creates no clock receipt');
for(const actor of [null,id(2),id(3),id(4),id(99)]){await as(actor);await refused('select work_activity_clock_capability()');}
await as(id(1),'service_role');await refused('select work_activity_clock_capability()');
await as(id(1),'anon');await refused('select work_activity_clock_capability()');
await as(id(1));await refused('select _work_activity_clock_contract_marker()');
await as(null,'postgres');await db.exec('select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1');
await as(id(1));matrix(await read(),'active',null,true);
await as(null,'postgres');
await db.exec('savepoint signed_toolbox');
await db.query("insert into toolbox_completions(profile_id,signed_at,typed_name) values($1,clock_timestamp(),'Synthetic signature')",[id(1)]);
await as(id(1));matrix(await read(),'active',null,true);
await as(null,'postgres');await db.exec('rollback to savepoint signed_toolbox');
await db.exec("insert into company_settings(id,paid_time_from_start_day_on) values(1,(clock_timestamp() at time zone 'America/Denver')::date)");
await as(id(1));matrix(await read(),'active',null,true);
await as(null,'postgres');await db.exec('savepoint exhausted');await db.exec('update work_activity_authority_generation set revision=9007199254740991');
await as(id(1));matrix(await read(),'unavailable','not_ready',false);
await as(null,'postgres');await db.exec('rollback to savepoint exhausted');
await db.query("insert into personal_activity_state(profile_id,integrity_state) values($1,'review')",[id(1)]);
await as(id(1));matrix(await read(),'unavailable','not_ready',false);
await as(null,'postgres');await db.exec('savepoint missing_marker');await db.exec('drop function _work_activity_clock_contract_marker()');
await as(id(1));await refused('select work_activity_clock_capability()',[],'55000');
await as(null,'postgres');await db.exec('rollback to savepoint missing_marker');
await db.exec('savepoint changed_protocol');await db.exec('revoke execute on function work_activity_clock_receipt(uuid) from authenticated');
await as(id(1));await refused('select work_activity_clock_capability()',[],'55000');
await as(null,'postgres');await db.exec('rollback to savepoint changed_protocol');
// Mutation-positive completion guard tests: each independently changes real
// source/authority metadata, and the entire change is rolled back.
for(const mutation of [
 'revoke execute on function clock_in(uuid,uuid,text,double precision,double precision,text,text,uuid,timestamptz,timestamptz,integer,integer) from authenticated',
 'alter table time_shifts disable trigger \"000_work_activity_gate\"',
 'grant select on personal_activity_state to authenticated',
 'alter table work_activity_clock_receipts rename column receipt_protocol to broken_receipt_protocol'
]){
 await db.exec('savepoint invalid_completion');await db.exec(mutation);
 await refused(completionGuard,[],'55000');
 await db.exec('rollback to savepoint invalid_completion');
}
await db.exec('rollback');
for(const isolation of ['repeatable read','serializable']){
 await as(id(1));await db.exec('begin isolation level '+isolation);await refused('select work_activity_clock_capability()',[],'25001');await db.exec('rollback');
}
await db.close();
const incomplete=new PGlite({extensions:{pgcrypto,uuid_ossp}});
await incomplete.exec(schema);let partialError;
try{await incomplete.exec('begin;set local search_path=public,pg_temp;'+completionGuard);}catch(e){partialError=e;}
assert.equal(partialError?.code,'55000','Original/substrate-only schema must not claim cutover completion');
await incomplete.exec('rollback');
assert.equal((await incomplete.query("select to_regprocedure('_work_activity_clock_contract_marker()') is null absent")).rows[0].absent,true);checks++;
await incomplete.close();
console.log(JSON.stringify({result:'PASS',checks,contract:{functions:contract.length,triggers:triggers.length,privateTables:tables.length,runtimeFunctions:runtime.length,marker},cutoverSha256:cutoverHash,capabilitySha256:hash(migration),scope:'Disposable matched source PGlite; genuine PG17 role/concurrency tests pending; no activation'}));
