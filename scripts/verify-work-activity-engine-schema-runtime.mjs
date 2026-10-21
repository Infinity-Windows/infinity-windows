// Disposable local PGlite runtime proof on the source-matched application schema.
// This fixture excludes vector search/provider internals. It never installs a
// production migration or connects to a network database. Capture is enabled
// only inside synthetic test transactions, which are rolled back.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where}));process.exit(1);});
const module=process.env.PGLITE_MODULE??'@electric-sql/pglite';
const moduleUrl=isAbsolute(module)?pathToFileURL(module).href:import.meta.resolve(module);
const {PGlite}=await import(moduleUrl);
const {pgcrypto}=await import(new URL('./contrib/pgcrypto.js',moduleUrl));
const {uuid_ossp}=await import(new URL('./contrib/uuid_ossp.js',moduleUrl));
assert.ok(process.env.WORK_ACTIVITY_MATCHED_SCHEMA,'WORK_ACTIVITY_MATCHED_SCHEMA is required');
const schema=readFileSync(process.env.WORK_ACTIVITY_MATCHED_SCHEMA,'utf8');
const source=readFileSync(new URL('../supabase/migrations/20261108410000_work_activity_engine_cutover.sql',import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const fixtureManifest=JSON.parse(readFileSync(new URL('./fixtures/work-activity-engine-online-schema.manifest.json',import.meta.url),'utf8'));
assert.equal(hash(schema),fixtureManifest.artifactSha256,'Frozen source-matched fixture bytes changed');
for(const [file,expected] of Object.entries(fixtureManifest.sourceParentsSha256)){
 assert.equal(hash(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')),expected,'Fixture source parent drift: '+file);
}
const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});
const q=async(s,a=[])=>(await db.query(s,a)).rows[0];
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;};
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const as=async(uid,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid??'']);await db.exec('set role '+role);};
await db.exec(schema);
async function cancelledFixture(){
 await db.exec('begin;reset role');
 await db.query('insert into auth.users(id) values($1)',[id(1)]);
 await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Synthetic closure fixture','owner',false)",[id(1)]);
 await as(id(1),'postgres');
 await db.query("insert into projects(id,job_code,name) values($1,'ENGINE-SYNTHETIC','Synthetic fixture')",[id(2)]);
 await db.query("insert into project_openings(id,project_id,opening_code) values($1,$2,'SYNTHETIC-1')",[id(3),id(2)]);
 await db.query('insert into summons(id,project_id,opening_id,requested_by,needed) values($1,$2,$3,$4,1)',[id(4),id(2),id(3),id(1)]);
 await db.query("insert into summon_helpers(id,summon_id,profile_id,joined_at,canceled_at,minutes) values($1,$2,$3,now()-interval '1 hour',now()-interval '30 minutes',0)",[id(5),id(4),id(1)]);
 await as(id(1));
}
await cancelledFixture();
const old=(await q('select to_jsonb(complete_summon_help($1)) result',[id(4)])).result;
check(old.minutes===60&&old.completed_at!==null&&old.canceled_at!==null,'Installed original body demonstrates cancelled-helper completion counterexample');
await db.exec('rollback');await as(null,'postgres');
// The complete 221-entry original-body/authority guard remains executable.
// The full 730-routine graph guard requires the deliberately excluded vector
// extension/provider inventory. Omitting that guard here is fixture scope,
// never a deployable migration transformation or evidence of installed parity.
const exactSourceGuard=source.slice(source.indexOf('-- INSTALLED_SOURCE_GUARD:'),source.indexOf('-- INSTALLED_GRAPH_GUARD:'));
await db.exec(exactSourceGuard);checks++;
const cutover=source.slice(source.indexOf('-- DEVELOPMENT_PRIVATE_PREFIX:')).replace(/rollback;\s*$/,'commit;');
check(cutover.endsWith('commit;'),'Fixture changes only final rollback after explicit graph boundary');
await db.exec('begin;'+cutover);
check((await q('select not capture_enabled disabled from work_activity_authority_generation where singleton')).disabled,'Complete DDL leaves capture disabled');
if(process.env.WORK_ACTIVITY_MATCHED_CUTOVER_OUT){
 const serialized=schema+'\n;\n'+exactSourceGuard+'\n;\nbegin;\n'+cutover+'\n';
 await db.close();
 const imported=new PGlite({extensions:{pgcrypto,uuid_ossp}});
 try{await imported.exec(serialized);}finally{await imported.close();}
 writeFileSync(process.env.WORK_ACTIVITY_MATCHED_CUTOVER_OUT,serialized);
 console.log(JSON.stringify({roundTrip:'PASS',schemaSha256:hash(schema),cutoverSha256:hash(source),exportSha256:hash(serialized),scope:'Source-matched application fixture; explicit vector/provider/role exclusions; no activation',checks}));
 process.exit(0);
}
await cancelledFixture();await as(id(1),'postgres');
const before=await q("select (select to_jsonb(h) from summon_helpers h where id=$1) helper,(select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from unit_sessions u) units,(select coalesce(jsonb_agg(to_jsonb(p) order by profile_id),'[]') from personal_activity_state p) states,(select count(*)::int from personal_activity_transitions) transitions",[id(5)]);
await as(id(1));await db.exec('savepoint rejected_completion');
let error;try{await db.query('select complete_summon_help($1)',[id(4)]);}catch(e){error=e;}
check(error?.message==='no open help of yours on this summon','Corrected existing RPC refuses completion after cancellation');
await db.exec('rollback to savepoint rejected_completion');await as(id(1),'postgres');
const after=await q("select (select to_jsonb(h) from summon_helpers h where id=$1) helper,(select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from unit_sessions u) units,(select coalesce(jsonb_agg(to_jsonb(p) order by profile_id),'[]') from personal_activity_state p) states,(select count(*)::int from personal_activity_transitions) transitions",[id(5)]);
check(JSON.stringify(before)===JSON.stringify(after),'Refused completion preserves helper, every unit clock, personal state and transition count');
await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,status) values($1,$2,$3,now()-interval '1 hour','open')",[id(6),id(1),id(2)]);
await db.query("update summon_helpers set canceled_at=null,joined_at=now()-interval '5 minutes',minutes=null where id=$1",[id(5)]);
const payrollBefore=(await q('select to_jsonb(s) value from time_shifts s where id=$1',[id(6)])).value;
await as(id(1));
const completed=(await q('select to_jsonb(complete_summon_help($1)) result',[id(4)])).result;
check(completed.minutes===5&&completed.completed_at!==null&&completed.canceled_at===null,'A legitimately active helper still completes through the existing RPC');
await as(id(1),'postgres');
check(JSON.stringify((await q('select to_jsonb(s) value from time_shifts s where id=$1',[id(6)])).value)===JSON.stringify(payrollBefore),'Helper completion leaves the complete payroll shift byte-identical');
check(!(await q('select exists(select 1 from unit_sessions where profile_id=$1 and opening_id=$2 and ended_at is null) live',[id(1),id(3)])).live,'Helper completion closes its own mapped unit session');
await db.exec('rollback');await as(null,'postgres');
// Exercise the actual payroll roots and all real application callbacks in
// the matched schema. The old nine checks alone did not establish this lane.
await db.exec('begin');
await db.query('insert into auth.users(id) values($1),($2),($3)',[id(100),id(101),id(102)]);
await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Synthetic setup','installer',false),($2,'Synthetic legacy','installer',false),($3,'Synthetic reviewed','installer',false)",[id(100),id(101),id(102)]);
await as(id(100),'postgres');
await db.query("insert into projects(id,job_code,name) values($1,'SYNTHETIC-CLOCK','Synthetic clock fixture')",[id(110)]);
await db.exec('select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1');
const stamp=(await q('select clock_timestamp() t')).t;
const at=seconds=>new Date(stamp.getTime()+seconds*1000).toISOString();
const clock11='select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,$2::text,null::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)) value';
const clock12=clock11.replace(',0))',',0,1))');
async function refused(sql,args,code){
 await db.exec('savepoint expected_refusal');let failure;
 try{await db.query(sql,args);}catch(e){failure=e;}
 assert.ok(failure,'Expected SQL refusal');if(code)assert.equal(failure.code,code,failure.message);
 await db.exec('rollback to savepoint expected_refusal');checks++;
}
const paidArgs=[id(110),null,id(120),at(-3600),at(0)];
await as(id(100));
await refused(clock11,paidArgs,'P0001');
await as(id(100),'postgres');
check((await q('select count(*)::int n from time_shifts where profile_id=$1',[id(100)])).n===0,'Unsigned retained eleven-argument clock preserves its original company admission boundary');
// A custom claim is not admission; private helpers and frames remain inaccessible.
await as(id(100));
await db.exec("set app.work_setup='true';set request.jwt.claim.setup_version='1'");
await refused(clock11,paidArgs,'P0001');
const claimSql=clock11.replace('to_jsonb(clock_in(', '_work_activity_claim_clock_setup(').replace(',0)) value', ',0) value');
await refused(claimSql,paidArgs,'42501');
await refused("select _work_activity_operation_enter('clock_in_setup','{}'::jsonb,$1)",[id(120)],'42501');
await refused("insert into work_activity_operations(top_xid,backend_pid,actor_id,route,arrival_at,request_id,arguments) values(pg_current_xact_id(),pg_backend_pid(),$1,'clock_in_setup',clock_timestamp(),$2,'{}')",[id(100),id(120)],'42501');
await as(id(100),'postgres');
const digestSql=claimSql.replace('_work_activity_claim_clock_setup','_work_activity_clock_setup_digest');
const exactDigest=(await q(digestSql,paidArgs)).value;
// Trusted fixture corruption proves every claimed identity is checked, rather
// than merely checking a forgeable route label. Each attempt rolls back fully.
for(const [request,args,command] of [
 [id(999),{setupVersion:1,clockPayloadDigest:exactDigest},null],
 [id(120),{setupVersion:1,clockPayloadDigest:'wrong'},null],
 [id(120),{setupVersion:1,clockPayloadDigest:exactDigest},id(999)],
 [id(120),{setupVersion:1,clockPayloadDigest:exactDigest,extra:true},null]
]){
 await db.exec('savepoint corrupt_setup_claim');
 await q("select _work_activity_operation_enter('clock_in_setup',$1::jsonb,$2,$3)",[JSON.stringify(args),request,command]);
 await as(id(100));await refused(clock11,paidArgs,'42501');
 await as(id(100),'postgres');await db.exec('rollback to savepoint corrupt_setup_claim');
}
await db.exec('savepoint consumed_setup_claim');
await q("select _work_activity_operation_enter('clock_in_setup',$1::jsonb,$2)",[JSON.stringify({setupVersion:1,clockPayloadDigest:exactDigest}),id(120)]);
check((await q(claimSql,paidArgs)).value===true,'Exact private setup admission is consumed once');
await refused(claimSql,paidArgs,'42501');
await refused('update work_activity_operations set clock_entry_claimed=false',[],'23514');
await refused("update work_activity_operations set arguments='{}'",[],'23514');
await refused("update work_activity_operations set route='clock_in'",[],'23514');
await db.exec('rollback to savepoint consumed_setup_claim');
await db.exec('savepoint disabled_setup');await db.exec('update work_activity_authority_generation set capture_enabled=false,revision=revision+1');
await as(id(100));await refused(clock12,paidArgs,'P0001');
await as(id(100),'postgres');check((await q('select count(*)::int n from time_shifts where profile_id=$1',[id(100)])).n===0,'Capture disabled refuses unsigned new setup atomically');
await db.exec('rollback to savepoint disabled_setup');
await as(id(100));
const paid=(await q(clock12,paidArgs)).value;
check(new Date(paid.clock_in_at).toISOString()===at(-3600),'Twelve-argument payroll clock preserves the original trusted paid tap before toolbox');
const setupView=(await q('select work_activity_snapshot($1) value',[id(130)])).value;
check(setupView.state.status==='setup'&&setupView.state.shift.id===paid.id,'Fresh actual snapshot confirms the automatic setup, rather than inferring it from a payroll receipt');
const ack=(await q('select work_activity_clock_receipt($1) value',[id(120)])).value;
check(ack.receipt.usedTapTime&&ack.receipt.receiptProtocol==='setup_v1'&&ack.receipt.retention==='retained','Trusted setup protocol retains the actual keyed payroll acknowledgement');
check((await q(clock12,paidArgs)).value.id===paid.id,'Exact twelve-argument replay returns the same payroll row');
await as(id(100),'postgres');await db.exec('savepoint disabled_replay');await db.exec('update work_activity_authority_generation set capture_enabled=false,revision=revision+1');
await as(id(100));check((await q(clock12,paidArgs)).value.id===paid.id,'Unsigned exact setup replay remains available after capture disable');
await as(id(100),'postgres');await db.exec('rollback to savepoint disabled_replay');await as(id(100));
await refused('select _prep_time_gate($1)',[id(100)],'P0001');
await refused('select _unit_work_gate($1)',[id(100)],'P0001');

await refused(clock12,[...paidArgs.slice(0,1),'changed immutable note',...paidArgs.slice(2)],'23514');
await q('select start_break($1::uuid,$2::text,$3::uuid,$4::timestamptz,$5::timestamptz,0)',[paid.id,'rest',id(121),at(-600),at(0)]);
const onBreak=(await q('select work_activity_snapshot($1) value',[id(130)])).value;
check(onBreak.state.status==='on_break','Existing keyed break pauses the actual setup source');
const endSql='select end_break($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,0) value';
const endArgs=[paid.id,id(122),at(-60),at(0)];
const ended=(await q(endSql,endArgs)).value;
check(ended.outcome==='ended'&&ended.shift.break_seconds===540,'Actual paid break rounds/deducts its original interval once');
await q(endSql,endArgs);
await as(id(100),'postgres');
check((await q('select break_seconds from time_shifts where id=$1',[paid.id])).break_seconds===540,'Break receipt replay does not deduct the same interval twice');
check((await q('select count(*)::int n from work_setup_sessions where profile_id=$1 and ended_at is null',[id(100)])).n===1,'Eligible setup resumes exactly one current source');
await as(id(100));
const outSql='select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0)) value';
const closed=(await q(outSql,[paid.id,id(123),at(-30),at(0)])).value;
check(new Date(closed.clock_out_at).toISOString()===at(-30)&&closed.break_seconds===540,'Existing clock-out preserves the original finish and already-counted break seconds');
await as(id(100),'postgres');
check((await q('select count(*)::int n from work_setup_sessions where profile_id=$1 and ended_at is null',[id(100)])).n===0,'Clock-out closes setup without manufacturing a second paid shift');
await as(id(100),'postgres');
check((await q('select count(*)::int n from company_settings')).n===0,'New setup writes no company policy row');
await db.exec('savepoint signed_legacy');
await db.query("insert into toolbox_completions(profile_id,signed_at,typed_name) values($1,clock_timestamp(),'Synthetic signature')",[id(101)]);
await as(id(101));
check((await q(clock11,[id(110),null,id(129),at(-20),at(0)])).value.profile_id===id(101),'Retained eleven-argument signature admission remains valid');
await as(id(100),'postgres');await db.exec('rollback to savepoint signed_legacy');

await db.exec("insert into company_settings(id,paid_time_from_start_day_on) values(1,(clock_timestamp() at time zone 'America/Denver')::date)");
await as(id(101));
const legacyArgs=[id(110),null,id(124),at(-20),at(0)];
const legacy=(await q(clock11,legacyArgs)).value;
await refused(clock12,legacyArgs,'23514');
await as(id(101),'postgres');
check((await q('select count(*)::int n from work_setup_sessions where profile_id=$1',[id(101)])).n===0,'Replaying an old eleven-argument receipt through twelve arguments never retroactively opens setup');
await as(id(102),'postgres');await db.exec('savepoint disabled_legacy_policy');
await db.exec('update work_activity_authority_generation set capture_enabled=false,revision=revision+1');
await as(id(102));
check((await q(clock12,[id(110),null,id(128),at(-20),at(0)])).value.profile_id===id(102),'Capture-off new twelve-argument call retains existing paid-date admission');
await as(id(102),'postgres');
check((await q('select count(*)::int n from work_setup_sessions where profile_id=$1',[id(102)])).n===0,'Capture-off payroll admission does not create setup');
await db.exec('rollback to savepoint disabled_legacy_policy');
await as(id(102));
const reviewedArgs=[id(110),null,id(125),at(-20),null];
const reviewed=(await q(clock12,reviewedArgs)).value;
await as(id(102),'postgres');
check((await q('select count(*)::int n from work_setup_sessions where profile_id=$1',[id(102)])).n===0,'Unchecked delayed clock remains payroll evidence without automatic setup resurrection');
const reviewedReceipt=(await q('select review_reason,used_tap_time from time_clock_actions where client_id=$1',[id(125)]));
check(reviewedReceipt.review_reason==='clock_unchecked'&&!reviewedReceipt.used_tap_time,'Reviewed payroll arrival preserves its real reason and tap disposition');
await as(id(100));
await refused('select start_break($1::uuid,$2::text)',[legacy.id,'rest']);
await refused('select end_break($1::uuid)',[legacy.id]);
await refused(outSql,[legacy.id,id(126),at(0),at(0)]);
await as(id(101),'postgres');
check((await q('select clock_out_at is null and break_started_at is null untouched from time_shifts where id=$1',[legacy.id])).untouched,'Foreign caller payroll safety attempts do not mutate the actual owner shift');
await db.exec('rollback');await as(null,'postgres');
await db.close();
console.log(JSON.stringify({result:'PASS',checks,schemaSha256:hash(schema),cutoverSha256:hash(source),scope:'Whole authored cutover on source-matched application schema with vector/provider exclusions; synthetic helper and actual payroll/setup lifecycle cases'}));
