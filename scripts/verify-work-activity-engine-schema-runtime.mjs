// Disposable local PGlite runtime proof on the source-matched application schema.
// This fixture excludes vector search/provider internals. It never installs a
// production migration, connects to a network database, or enables capture.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where}));process.exit(1);});
const module=process.env.PGLITE_MODULE??'@electric-sql/pglite';
const moduleUrl=process.env.PGLITE_MODULE??import.meta.resolve(module);
const {PGlite}=await import(module);
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
await db.close();
console.log(JSON.stringify({result:'PASS',checks,schemaSha256:hash(schema),cutoverSha256:hash(source),scope:'Whole authored cutover on source-matched application schema with vector/provider exclusions; synthetic cancelled-helper regression only'}));
