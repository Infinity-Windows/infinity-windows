// Disposable PGlite/source verification of the INACTIVE 08400000 substrate.
// Real dependency helper bodies/migrations, synthetic rows only. This does not
// prove installed entry closure, PostgreSQL backend concurrency or activation.
// WORK_ACTIVITY_SCHEMA_OUT exports exactly the executed schema, before fixtures.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const migrations = new URL('supabase/migrations/', root);
const read = file => readFileSync(new URL(file, migrations), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const migrationName = '20261108400000_work_activity_engine_substrate.sql';
const source = read(migrationName);
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

// Conservative source inventory: definitions and evidence, NOT an installed
// pg_proc/pg_trigger/ACL proof. Overloaded callers are included by name. Dynamic
// SQL and dropped signatures are explicit catalog reconciliation obligations.
const splitArgs = input => {
  const result = []; let depth=0, quoted=false, start=0;
  for(let i=0;i<input.length;i++) { const c=input[i];
    if(c==="'" && input[i+1]==="'" && quoted){i++;continue;}
    if(c==="'"){quoted=!quoted;continue;}
    if(!quoted){if(c==='('||c==='[')depth++;if(c===')'||c===']')depth--;if(c===','&&depth===0){result.push(input.slice(start,i).trim());start=i+1;}}
  }
  if(input.slice(start).trim())result.push(input.slice(start).trim()); return result;
};
const canonicalType = value => value.trim().toLowerCase().replace(/\s+/g,' ').replace(/^int(?:4)?(?=\[|$)/,'integer').replace(/^int8(?=\[|$)/,'bigint').replace(/^bool(?=\[|$)/,'boolean').replace(/^timestamp with time zone(?=\[|$)/,'timestamptz');
const functionsIn = (text,file) => {
  const result=[]; const rx=/^\s*create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gim;
  for(const match of text.matchAll(rx)) {
    let at=match.index+match[0].lastIndexOf('(')+1, end=at, depth=1, quoted=false;
    for(;end<text.length&&depth;end++){const c=text[end];if(c==="'"&&text[end+1]==="'"&&quoted){end++;continue;}if(c==="'")quoted=!quoted;if(!quoted){if(c==='(')depth++;if(c===')')depth--;}}
    const args=text.slice(at,end-1); const bodyStart=/\bas\s+(\$[a-z0-9_]*\$)/i.exec(text.slice(end));
    if(!bodyStart)continue;
    const headerEnd=end+bodyStart.index+bodyStart[0].length;
    // Never consume into the following declaration for non-dollar definitions.
    const next=text.indexOf('\ncreate ',end); if(next>=0&&next<headerEnd)continue;
    const bodyEnd=text.indexOf(bodyStart[1],headerEnd); if(bodyEnd<0)continue;
    const definition=text.slice(match.index,bodyEnd+bodyStart[1].length).trim();
    const header=text.slice(match.index,headerEnd);
    const types=splitArgs(args).filter(a=>!/^out\s/i.test(a)).map(a=>a.replace(/\s+(?:default\s|=)[\s\S]*$/i,'').replace(/^(?:in\s+|inout\s+|variadic\s+)?[a-z_][a-z0-9_]*\s+/i,'').replace(/\s+/g,' ')).map(canonicalType);
    const line=1+text.slice(0,match.index+match[0].search(/create/i)).split('\n').length-1;
    const body=text.slice(headerEnd,bodyEnd);
    const evidence=(pattern)=>[...body.matchAll(pattern)].map(m=>({line:1+text.slice(0,headerEnd+m.index).split('\n').length-1,text:m[0].replace(/\s+/g,' ').trim()}));
    result.push({_offset:match.index,name:match[1].toLowerCase(),identity:`${match[1].toLowerCase()}(${types.join(', ')})`,arguments:args.trim(),source:file,line,
      securityMode:/\bsecurity\s+definer\b/i.test(header)?'definer':'invoker',volatility:/\bimmutable\b/i.test(header)?'immutable':/\bstable\b/i.test(header)?'stable':'volatile',
      definitionSha256:sha(definition),locks:evidence(/pg_(?:try_)?advisory_(?:xact_)?lock\s*\([^;]*?\)\s*;|\bfor\s+(?:no\s+key\s+)?update\b[^;]*;/gi),body});
  } return result;
};
const manifest = () => {
  const files=readdirSync(migrations).filter(f=>f.endsWith('.sql')&&f<migrationName).sort();
  const latest=new Map(); const ddl=[]; const droppedDefinitions=[]; const unresolvedDrops=[]; const timing=['time_shifts','time_clock_actions','unit_sessions','task_sessions','custom_work_sessions','service_time_sessions','opening_phases','summon_helpers'];
  const parents=['profiles','projects','project_openings','custom_work_units','service_visits','service_visit_units'];
  const explicit=new Set(['record_crew_work','record_stage_contributors','correct_stage_contributors','ai_field_command','ai_field_resolve','_ai_field_apply','purge_project','purge_expired_projects','merge_field_unit','remove_field_unit','remove_opening','restore_opening','workflow_lock_writes','attach_sandbox_guards','guard_timecard_role_boundary','guard_time_entry_import_source']);
  for(const file of files){const sql=read(file);const events=functionsIn(sql,file).map(fn=>({at:fn._offset,fn}));
    for(const drop of sql.matchAll(/^\s*drop\s+function\s+(?:if\s+exists\s+)?([^;]+);/gim)){
      let parsed=0;
      for(const signature of drop[1].matchAll(/(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^()]*)\)/gi)){
        const identity=`${signature[1].toLowerCase()}(${splitArgs(signature[2]).map(canonicalType).join(', ')})`;
        events.push({at:drop.index,drop:{identity,source:file,line:1+sql.slice(0,drop.index+drop[0].search(/drop/i)).split('\n').length-1}});parsed++;
      }
      if(!parsed)unresolvedDrops.push({source:file,statement:drop[0].trim()});
    }
    for(const event of events.sort((a,b)=>a.at-b.at)){if(event.fn)latest.set(event.fn.identity,event.fn);else{droppedDefinitions.push({...event.drop,priorDefinitionFound:latest.has(event.drop.identity)});latest.delete(event.drop.identity);}}

    const rx=/^\s*(?:create\s+(?:constraint\s+)?(?:trigger|policy)|(?:alter|drop)\s+(?:table|trigger|policy|function)|grant\s+|revoke\s+)[\s\S]*?;/gim;
    for(const m of sql.matchAll(rx)) if([...timing,...parents].some(t=>new RegExp(`\\b${t}\\b`,'i').test(m[0])) || /drop\s+function|(?:grant|revoke)[\s\S]*\bfunction\b/i.test(m[0]))
      ddl.push({source:file,line:1+sql.slice(0,m.index+m[0].search(/\S/)).split('\n').length-1,statement:m[0].trim(),dynamicOrHistorical:true});
  }
  const candidates=[...latest.values()]; const selected=new Set(candidates.filter(f=>explicit.has(f.name)||[...timing,...parents].some(t=>new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?${t}\\b`,'i').test(f.body))).map(f=>f.name));
  let changed=true;while(changed){changed=false;for(const f of candidates)if(!selected.has(f.name)&&[...selected].some(n=>new RegExp(`\\b${n}\\s*\\(`,'i').test(f.body))){selected.add(f.name);changed=true;}}
  return {formatVersion:1,sourceOnly:true,gate:{namespace:7712,key:0},activation:false,
    limitations:['Latest textual definitions by normalized signature, applying recognized explicit DROP FUNCTION statements in source order; conditional/dynamic DROP and ALTER still require installed catalog reconciliation.','Conservative name-level reverse-call closure includes all overloads; SQL text is evidence, not parsed PL/pgSQL reachability.','Dynamic SQL, trigger installation/order, FKs, RLS/ACL effect and prior-lock closure require actual-schema catalog proof.','Read-only helpers may appear in conservative candidate closure; entry classification requires review.'],
    sourceTables:timing,sourceParents:parents,
    requiredCatalogs:['pg_proc identity arguments/body/prosecdef/proacl','pg_trigger enabled/order/function/table','pg_policies','pg_class/pg_namespace privileges','pg_constraint foreign-key/cascade actions','pg_depend and dynamic SQL/manual maintenance review'],
    sources:files.map(file=>({file,sha256:sha(read(file))})),
    functions:candidates.filter(f=>selected.has(f.name)).sort((a,b)=>a.identity.localeCompare(b.identity)).map(({body,_offset,...f})=>({...f,classification:'candidate: review first-G entry/callback/authority closure',calledSourceFunctionNames:[...new Set(candidates.filter(c=>new RegExp(`\\b${c.name}\\s*\\(`,'i').test(body)).map(c=>c.name))].sort(),directTimingWrite:timing.some(t=>new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:public\\.)?${t}\\b`,'i').test(body))})),droppedDefinitions,unresolvedDrops,ddlEvidence:ddl};
};
const currentManifest=manifest();
const manifestUrl=new URL('scripts/work-activity-engine-manifest.json',root);
if(process.argv.includes('--write-manifest')) {writeFileSync(manifestUrl,JSON.stringify(currentManifest,null,2)+'\n'); console.log(`Wrote ${currentManifest.functions.length} source candidates; installed closure remains unproved.`); process.exit(0);}
check(JSON.stringify(JSON.parse(readFileSync(manifestUrl,'utf8')))===JSON.stringify(currentManifest),'Source manifest matches all current prior-migration hashes and extracted evidence');
check(currentManifest.functions.some(f=>f.name==='custom_work_command'&&f.source==='20261108300000_work_unit_observations.sql'),'Manifest uses the latest unit command, not 310');
check(currentManifest.functions.filter(f=>f.name==='clock_in').length===6,'Manifest retains all six clock-in overloads');
check(currentManifest.functions.some(f=>f.name==='start_opening_work'&&f.securityMode==='invoker'),'Invoker route requiring reviewed closure stays visible');
check(currentManifest.functions.filter(f=>f.name==='clock_out').length===2,'Manifest removes explicitly dropped old clock-out signatures');
check(currentManifest.functions.some(f=>f.name==='merge_field_unit'),'Parent/cascade entry remains visible');
check(!/^\s*create\s+or\s+replace\s+function\b/im.test(source),'Substrate replaces no legacy function body');
check(!/^\s*grant\s+execute\b/im.test(source),'Substrate grants no public helper execution');

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db=new PGlite(); const schemaSql=[];
const schemaExec=async sql=>{await db.exec(sql);schemaSql.push(sql);};
const one=async sql=>(await db.query(sql)).rows[0];
const all=async sql=>(await db.query(sql)).rows;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const quote=v=>"'"+JSON.stringify(v).replace(/'/g,"''")+"'::jsonb";
const refuse=async(sql,code='23514')=>{let caught;try{await db.exec(sql);}catch(error){caught=error;}assert.ok(caught,'Expected refusal: '+sql);assert.equal(caught.code,code,`${sql} -> ${caught.message}`);checks++;};
const migrationFunction=(file,name)=>{const f=functionsIn(read(file),file).filter(f=>f.name===name);assert.equal(f.length,1,'Unambiguous real helper '+name);const sql=read(file);const at=sql.indexOf('create',sql.split('\n').slice(0,f[0].line-1).join('\n').length);const header=sql.slice(at);const body=/\bas\s+(\$[a-z0-9_]*\$)/i.exec(header);const end=header.indexOf(body[1],body.index+body[0].length);return header.slice(0,end+body[1].length)+';';};
let selfFailed=false;try{await refuse('select 1');}catch{selfFailed=true;}check(selfFailed,'Negative assertion cannot swallow unexpected success');
await schemaExec(`set check_function_bodies=off;
create role authenticated; create role anon; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean not null default true,retired_at timestamptz,access_revoked_at timestamptz,is_partner boolean not null default false,is_test boolean not null default false);
create table projects(id uuid primary key,deleted_at timestamptz,is_test boolean not null default false);
create table project_openings(id uuid primary key,project_id uuid,opening_code text,removed_at timestamptz);
create table sandbox_projects(project_id uuid primary key);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0,source_import jsonb);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(id uuid primary key,started_by uuid,status text,paused_at timestamptz);
grant select on profiles,projects,project_openings to authenticated;`);
for(const [file,names] of [
 ['20260950000000_partner_wall.sql',['is_partner_user']],
 ['20260730120000_test_accounts_excluded_from_learning.sql',['is_test_profile']],
 ['20260730220000_test_accounts_sandbox_only.sql',['is_sandbox_project','row_project_id','guard_test_account_sandbox_only']],
 ['20260967000000_sandbox_guard_rearm.sql',['sandbox_scoped_tables','attach_sandbox_guards']],
 ['20260810000000_team_timecards.sql',['_is_supervisor']],
 ['20260718050000_time_timecard.sql',['_is_lead']],
 ['20260730230000_runaway_shift_guard.sql',['shift_cap_hours']],
])for(const name of names)await schemaExec(migrationFunction(file,name));
await schemaExec(read('20261011000000_custom_work.sql'));
for(const name of ['custom_work_internal','validate_custom_work_facts','_ai_job_visible'])await schemaExec(migrationFunction('20261024000000_ai_field_operations.sql',name));
// Actual receipt table DDL (only): do not install payroll writers for this test.
const clock=read('20261028000000_clock_integrity.sql');
const clockTable=/create table(?: if not exists)? public\.time_clock_actions\s*\([\s\S]*?\n\);/i.exec(clock);
assert.ok(clockTable,'Actual clock receipt table DDL exists');await schemaExec(clockTable[0]);
await schemaExec(read('20261107020000_work_capture_foundation.sql'));
await schemaExec(read('20261108000000_work_configuration.sql'));
await schemaExec(read('20261108300000_work_unit_observations.sql'));
const baselineFunctions=await all("select p.oid::text,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by p.oid");
const baselineTriggers=await all("select oid::text,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by oid");
const baselinePolicies=await all("select * from pg_policies where schemaname='public' order by tablename,policyname");
let beforeSources;
if(!process.env.WORK_ACTIVITY_SCHEMA_OUT){
 await db.exec(`insert into profiles(id,role) values('${id(9000)}','installer');
 insert into time_shifts(id,profile_id,clock_in_at,clock_out_at,status,break_seconds) values('${id(9001)}','${id(9000)}','2026-10-03 12:00Z','2026-10-03 20:00Z','approved',1800);
 insert into custom_work_sessions(id,profile_id,shift_id,kind,description,started_at,ended_at,shift_status) values('${id(9002)}','${id(9000)}','${id(9001)}','idle','Existing fixture evidence','2026-10-03 12:15Z','2026-10-03 13:00Z','approved');`);
 beforeSources=JSON.stringify({shifts:await all('select * from time_shifts order by id'),sessions:await all('select * from custom_work_sessions order by id')});
}
await schemaExec(source);
if(beforeSources)check(JSON.stringify({shifts:await all('select * from time_shifts order by id'),sessions:await all('select * from custom_work_sessions order by id')})===beforeSources,'Migration preserves nonempty payroll and legacy activity byte-for-byte');
check(JSON.stringify(await all(`select p.oid::text,pg_get_functiondef(p.oid) definition from pg_proc p where p.oid=any(array[${baselineFunctions.map(f=>f.oid).join(',')}]::oid[]) order by p.oid`))===JSON.stringify(baselineFunctions),'Every preexisting fixture function body/OID remains unchanged');
check(JSON.stringify(await all(`select oid::text,pg_get_triggerdef(oid) definition from pg_trigger where oid=any(array[${baselineTriggers.map(t=>t.oid).join(',')}]::oid[]) order by oid`))===JSON.stringify(baselineTriggers),'Every preexisting fixture trigger remains unchanged');
check(JSON.stringify(await all("select * from pg_policies where schemaname='public' order by tablename,policyname"))===JSON.stringify(baselinePolicies),'No RLS policy widened or added');
if(process.env.WORK_ACTIVITY_SCHEMA_OUT){writeFileSync(process.env.WORK_ACTIVITY_SCHEMA_OUT,schemaSql.join('\n\n')+'\n');await db.close();console.log('Exported actual executed activity substrate schema, before synthetic records.');process.exit(0);}

// CASES appended below. Keep schema export above every fixture write.
const OWNER=id(1),OTHER=id(2),QA=id(3),RETIRED=id(4),REVOKED=id(5),PARTNER=id(6),EXTERNAL=id(7),DEVICE=id(20);
await db.exec(`insert into profiles(id,role) values('${OWNER}','installer'),('${OTHER}','owner'),('${QA}','foreman'),('${RETIRED}','owner'),('${REVOKED}','supervisor'),('${PARTNER}','supervisor'),('${EXTERNAL}','customer');
update profiles set is_test=true where id='${QA}';update profiles set retired_at=now() where id='${RETIRED}';update profiles set access_revoked_at=now() where id='${REVOKED}';update profiles set is_partner=true where id='${PARTNER}';`);
const as=uid=>db.exec(`select set_config('request.jwt.claim.sub','${uid??''}',false)`);
await as(OWNER);
const tables=['work_activity_observations','work_activity_streams','work_activity_transaction_context','work_activity_expected_mutations','work_setup_sessions','personal_activity_transition_sources'];
for(const table of tables){check((await one(`select relrowsecurity from pg_class where oid='${table}'::regclass`)).relrowsecurity,table+' has RLS');
 check((await one(`select count(*)::int n from ${table}`)).n===0,table+' unseeded');
 for(const role of ['authenticated','anon']){check(!(await one(`select has_table_privilege('${role}','${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed`)).allowed,role+' lacks raw '+table);}}
const functions=await all("select oid::regprocedure::text identity from pg_proc where proname like '\\_work\\_activity\\_%' escape '\\'");
for(const {identity} of functions)for(const role of ['authenticated','anon'])check(!(await one(`select has_function_privilege('${role}','${identity}','EXECUTE') allowed`)).allowed,role+' cannot call '+identity);
await db.exec('set role authenticated');
await refuse('select _work_activity_gate()','42501');
await refuse('select * from work_activity_observations','42501');
await refuse('truncate work_activity_transaction_context','42501');
await db.exec('reset role');
for(const actor of [null,RETIRED,REVOKED,PARTNER,EXTERNAL]){await as(actor);await refuse(`select _work_activity_observe('${DEVICE}')`,'42501');}
await as(QA);check((await one(`select (_work_activity_observe('${DEVICE}')).actor_id actor`)).actor===QA,'Real internal QA actor may own private observation without reading company/source data');
await as(OWNER);
const observe=async(device=DEVICE)=>one(`select * from _work_activity_observe('${device}')`);
const observation=await observe();
check(observation.actor_id===OWNER&&Number(observation.revision)===0&&observation.shift_id===null,'Initial state stays unclassified revision0 without guessing a shift');
check((await one(`select integrity_state from personal_activity_state where profile_id='${OWNER}'`)).integrity_state==='review','Initialization does not assert clean legacy state');
check(Date.parse(observation.expires_at)-Date.parse(observation.issued_at)<=16*3600000,'Observation has bounded server lifetime');
await refuse(`update work_activity_observations set revision=9 where id='${observation.id}'`);
await refuse(`delete from work_activity_observations where id='${observation.id}'`);
const payload=(obs,generation,overrides={})=>({deviceId:obs.device_id,clientGeneration:generation,clientSequence:0,predecessorCommandId:null,expectedRevision:Number(obs.revision),basis:{observationId:obs.id},shiftRef:obs.shift_id?{kind:'shift',id:obs.shift_id}:null,tappedAt:'2026-10-03T12:00:00Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:obs.current_generation,previousHeadCommandId:obs.current_head_command_id},...overrides});
const establish=async(command,data)=>(await one(`select _work_activity_establish_stream('${command}',${quote(data)}) result`)).result;
const gen1=id(30),cmd1=id(40),data1=payload(observation,gen1);
const receipt1=await establish(cmd1,data1);
check(receipt1.status==='noop'&&receipt1.beforeRevision===0&&receipt1.afterRevision===0,'Establishment is an immutable activity noop');
check(JSON.stringify(await establish(cmd1,data1))===JSON.stringify(receipt1),'Exact establishment replay returns the same receipt');
check((await one('select count(*)::int n from personal_activity_transitions')).n===0,'Stream creation manufactures no activity/lifecycle transition');
await refuse(`select _work_activity_establish_stream('${cmd1}',${quote({...data1,tappedAt:'2026-10-03T13:00:00Z'})})`);
await as(OTHER);await refuse(`select _work_activity_establish_stream('${cmd1}',${quote(data1)})`);await as(OWNER);
await refuse(`select _work_activity_establish_stream('${id(41)}',${quote(data1)})`);
const obs2=await observe();const gen2=id(31),cmd2=id(42);const data2=payload(obs2,gen2);
check((await establish(cmd2,data2)).status==='noop','Fresh exact-head generation replacement succeeds');
check((await one(`select status from work_activity_streams where client_generation='${gen1}'`)).status==='retired','Old generation is durably retired');
check((await one("select count(*)::int n from work_activity_streams where status in ('active','blocked')")).n===1,'Exactly one current generation remains');
check(JSON.stringify(await establish(cmd1,data1))===JSON.stringify(receipt1),'Retired generation still retrieves a committed receipt');
const stale=await establish(id(43),payload(obs2,id(32)));
check(stale.status==='conflict'&&stale.reasonCode==='stream_changed','Stale generation/head cannot replace the winner');
check((await one(`select client_generation from work_activity_streams where status='active'`)).client_generation===gen2,'Failed rotation leaves current stream untouched');
await refuse(`update work_activity_streams set status='active',retired_at=null where client_generation='${gen1}'`);
await refuse(`delete from work_activity_streams where client_generation='${gen1}'`);
await refuse(`update personal_activity_commands set result='{}' where command_id='${cmd1}'`);
await refuse(`delete from personal_activity_commands where command_id='${cmd1}'`);

for(const bad of [null,[],{}, {...data1,unknown:true},{...data1,expectedRevision:null},{...data1,expectedRevision:'0'},
 {...data1,expectedRevision:0.5},{...data1,expectedRevision:-1},{...data1,expectedRevision:9007199254740992},
 {...data1,clientSequence:'0'},{...data1,clientSequence:1},{...data1,predecessorCommandId:cmd1},
 {...data1,basis:[]},{...data1,intent:[]},{...data1,shiftRef:[]},{...data1,basis:{observationId:null}},{...data1,basis:{observationId:observation.id,extra:true}},
 {...data1,deviceId:null},{...data1,clientGeneration:'fake'}, {...data1,tappedAt:null},{...data1,tappedAt:'infinity'},
 {...data1,tappedAt:'2026-99-99T00:00:00Z'}, {...data1,clockCheckedAt:true},{...data1,clockSkewMs:'1'},
 {...data1,clockSkewMs:0.2},{...data1,clockSkewMs:120001},{...data1,shiftRef:{kind:'clock_command',id:cmd1}},
 {...data1,intent:{kind:'establish_stream',previousGeneration:gen1,previousHeadCommandId:null}},
 {...data1,intent:{...data1.intent,unknown:true}}, {...data1,padding:'x'.repeat(20000)}]){
 await refuse(`select _work_activity_establish_payload(${quote(bad)})`);
}
await refuse('select _work_activity_establish_payload(null)');
check((await one(`select _work_activity_establish_payload(${quote({...data1,expectedRevision:9007199254740991,clockSkewMs:-120000})})->>'expectedRevision' revision`)).revision==='9007199254740991','Maximum safe revision and skew boundary accepted exactly');
const canonical=(await one(`select _work_activity_establish_payload(${quote(data1)}) value`)).value;
check(JSON.stringify((await one(`select _work_activity_establish_payload(${quote(canonical)}) value`)).value)===JSON.stringify(canonical),'Canonicalization is a fixed point');
await db.exec("set timezone='America/Denver'");
check(JSON.stringify((await one(`select _work_activity_establish_payload(${quote(data1)}) value`)).value)===JSON.stringify(canonical),'Canonical payload/hash does not vary by session timezone');
await db.exec("set timezone='UTC'");

// FINAL_RESULTS

// Refusal receipts commit, but cannot rotate a current stream. They are private
// bookkeeping, not simulated starts/stops or an activity revision increment.
const obs3=await observe();
const expiredId=id(60);
await db.exec(`insert into work_activity_observations(id,actor_id,device_id,revision,current_generation,current_head_command_id,issued_at,expires_at)
 values('${expiredId}','${OWNER}','${DEVICE}',0,'${gen2}','${cmd2}',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`);
const expiredPayload=payload({...obs3,id:expiredId},id(61));
const expiredReceipt=await establish(id(62),expiredPayload);
check(expiredReceipt.status==='refused'&&expiredReceipt.reasonCode==='observation_expired','Expired server basis cannot rotate the stream');
await db.exec(`update personal_activity_state set revision=1 where profile_id='${OWNER}'`);
check(JSON.stringify(await establish(id(62),expiredPayload))===JSON.stringify(expiredReceipt),'Replay is resolved before changed state and expired observation');
const stateConflict=await establish(id(63),payload(obs3,id(64)));
check(stateConflict.status==='conflict'&&stateConflict.reasonCode==='state_changed','Explicit null-safe state CAS refuses stale revision');
await db.exec(`update personal_activity_state set revision=0 where profile_id='${OWNER}'`);
await as(OTHER);const otherObs=await observe();await as(OWNER);
const hidden=await establish(id(65),payload({...obs3,id:otherObs.id},id(66)));
check(hidden.status==='refused'&&hidden.reasonCode==='observation_unavailable','Foreign observation identity returns generic unavailability');
await refuse(`insert into work_activity_observations(actor_id,device_id,revision,issued_at,expires_at) values('${OWNER}','${DEVICE}',9007199254740992,now(),now()+interval '1 hour')`);
await refuse(`insert into work_activity_observations(actor_id,device_id,revision,issued_at,expires_at) values('${OWNER}','${DEVICE}',0,now(),now()+interval '17 hours')`);
await refuse(`insert into work_activity_observations(actor_id,device_id,revision,issued_at,expires_at) values('${OWNER}','${DEVICE}',0,'-infinity','infinity')`);
const capShift=id(70);
await db.exec(`insert into time_shifts(id,profile_id,clock_in_at,status) values('${capShift}','${OWNER}',clock_timestamp()-interval '15 hours','open');update personal_activity_state set shift_id='${capShift}' where profile_id='${OWNER}'`);
const capped=await observe();
check(Date.parse(capped.expires_at)-Date.parse(capped.issued_at)<3600001,'Observation expires at actual shift cap, not 16 more hours');
await db.exec(`update time_shifts set clock_in_at=clock_timestamp()-interval '17 hours' where id='${capShift}'`);
await refuse(`select _work_activity_observe('${DEVICE}')`);
await db.exec(`update time_shifts set profile_id='${OTHER}',clock_in_at=clock_timestamp() where id='${capShift}'`);
await refuse(`select _work_activity_observe('${DEVICE}')`);
await db.exec(`update personal_activity_state set shift_id=null where profile_id='${OWNER}'`);

// Head identity is checked against the actual immutable command and transition,
// not a standalone pointer or a result that merely looks successful.
const core=(command,status='noop',reason=null,before=0,after=before,transition=null)=>({protocolVersion:1,commandId:command,status,reasonCode:reason,beforeRevision:before,afterRevision:after,transitionId:transition,effectiveAt:null});
const commandRow=(command,seq,data,status='noop',reason=null,transition=null,after=0,result=core(command,status,reason,0,after,transition))=>`insert into personal_activity_commands(command_id,actor_id,subject_profile_id,protocol_version,normalized_payload,payload_hash,device_id,client_generation,client_sequence,predecessor_command_id,expected_revision,status,reason_code,before_revision,after_revision,transition_id,effective_at,result)
 values('${command}','${OWNER}','${OWNER}',1,${quote(data)},encode(sha256(convert_to((${quote(data)})::text,'UTF8')),'hex'),'${DEVICE}','${gen2}',${seq},'${cmd2}',0,'${status}',${reason?`'${reason}'`:'null'},0,${after},${transition?`'${transition}'`:'null'},${transition?"'2026-10-03 12:00Z'":'null'},${quote(result)})`;
const headPayload={...data2,clientSequence:1,predecessorCommandId:cmd2,intent:{kind:'stop'}};
const rollbackCase=async fn=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}};
await rollbackCase(async()=>{await db.exec(commandRow(id(80),1,{...headPayload,deviceId:id(999)}));
 await refuse(`update work_activity_streams set head_sequence=1,head_command_id='${id(80)}' where client_generation='${gen2}'`);});
await rollbackCase(async()=>{await db.exec(commandRow(id(81),1,headPayload,'noop',null,null,0,core(id(999))));
 await refuse(`update work_activity_streams set head_sequence=1,head_command_id='${id(81)}' where client_generation='${gen2}'`);});
await rollbackCase(async()=>{await db.exec(commandRow(id(82),1,headPayload,'applied',null,id(83),1));
 await refuse(`update work_activity_streams set head_sequence=1,head_command_id='${id(82)}' where client_generation='${gen2}'`);});
await rollbackCase(async()=>{
 await db.exec(`insert into personal_activity_transitions(id,profile_id,revision_before,revision_after,command_id,cause,selected_effective_at,time_selection_reason,before_evidence,after_evidence,protocol_version) values('${id(85)}','${OWNER}',0,1,'${id(84)}','stop','2026-10-03 12:00Z','fixture','{}','{}',1)`);
 await db.exec(commandRow(id(84),1,headPayload,'applied',null,id(85),1,{...core(id(84),'applied',null,0,1,id(85)),effectiveAt:'2026-10-03T12:00:00.000000Z'}));
 await db.exec(`update work_activity_streams set head_sequence=1,head_command_id='${id(84)}' where client_generation='${gen2}'`);
 check((await one(`select head_command_id from work_activity_streams where client_generation='${gen2}'`)).head_command_id===id(84),'Applied pointer requires and accepts the exact actual command-transition pair');
});
await db.exec(commandRow(id(90),1,headPayload,'refused','fixture_refusal'));
await db.exec(`update work_activity_streams set head_sequence=1,head_command_id='${id(90)}',status='blocked' where client_generation='${gen2}'`);
check((await one(`select status from work_activity_streams where client_generation='${gen2}'`)).status==='blocked','Refusal receipt blocks the current generation');
await rollbackCase(async()=>{await db.exec(commandRow(id(91),2,{...headPayload,clientSequence:2,predecessorCommandId:id(90)}));
 await refuse(`update work_activity_streams set head_sequence=2,head_command_id='${id(91)}',status='active' where client_generation='${gen2}'`);});
const blockedObs=await observe();
check(blockedObs.current_head_command_id===id(90),'Snapshot sees blocked head for explicit recovery');
check((await establish(id(92),payload(blockedObs,id(93)))).status==='noop','Fresh exact blocked-head rotation recovers without changing old receipts');
check((await one(`select status from work_activity_streams where client_generation='${gen2}'`)).status==='retired','Blocked generation remains as retired evidence');

// The context is a real transaction/backend row, never a user-settable flag.
await refuse("select _work_activity_context_open('clock_in','clock_in',now())");
check((await one('select count(*)::int n from work_activity_transaction_context')).n===0,'Autocommit cannot leave an unfinished frame');
await db.exec('begin isolation level repeatable read');await refuse('select _work_activity_gate()','25000');await db.exec('rollback');
const savepointRefusal=async(sql,code='23514')=>{await db.exec('savepoint negative_case');try{await refuse(sql,code);}finally{await db.exec('rollback to savepoint negative_case;release savepoint negative_case');}};
await db.exec('begin');
const frame=(await one("select _work_activity_context_open('clock_in','clock_in','2026-10-03 12:00Z') id")).id;
check((await one(`select top_xid=pg_current_xact_id() and backend_pid=pg_backend_pid() bound from work_activity_transaction_context where id='${frame}'`)).bound,'Frame binds to actual top xid and backend PID');
await db.exec(`select set_config('work_activity.frame','${id(999)}',true);select set_config('work_activity.suppress_all','true',true)`);
await savepointRefusal(`select _work_activity_context_assert('${id(999)}')`,'42501');
await as(OTHER);await savepointRefusal(`select _work_activity_context_assert('${frame}')`,'42501');await as(OWNER);
await savepointRefusal(`insert into work_activity_transaction_context(top_xid,backend_pid,actor_id,subject_profile_id,route,cause,selected_effective_at) values('1',pg_backend_pid(),'${OWNER}','${OWNER}','fake','switch',now())`,'42501');
await savepointRefusal(`insert into work_activity_transaction_context(top_xid,backend_pid,actor_id,subject_profile_id,route,cause,selected_effective_at) values(pg_current_xact_id(),pg_backend_pid()+1,'${OWNER}','${OWNER}','fake','switch',now())`,'42501');
await savepointRefusal(`update work_activity_transaction_context set route='forged' where id='${frame}'`);
const child=(await one(`select _work_activity_context_open('nested','clock_in','2026-10-03 12:00Z','${frame}') id`)).id;
await savepointRefusal(`select _work_activity_context_close('${frame}')`);
await db.exec(`select _work_activity_context_close('${child}')`);
check((await one('select count(*)::int n from work_activity_transaction_context')).n===1,'Nested frame closes without losing outer identity');
// An exception rollback discards the nested frame and its deferred event.
await db.exec('savepoint caught_child');
const discarded=(await one(`select _work_activity_context_open('nested_failure','clock_in','2026-10-03 12:00Z','${frame}') id`)).id;
await db.exec('rollback to savepoint caught_child;release savepoint caught_child');
await savepointRefusal(`select _work_activity_context_assert('${discarded}')`,'42501');
const sourceId=id(200),before={id:sourceId,profile_id:OWNER,ended_at:null,end_reason:null},after={...before,ended_at:'2026-10-03T12:00:00+00:00',end_reason:'handoff'};
const expectSql=(columns,b=before,a=after,table='unit_sessions')=>`select _work_activity_expect('${frame}','${table}'::regclass,'UPDATE','${sourceId}',${columns},${quote(b)},${quote(a)}) id`;
await savepointRefusal(expectSql("array['not_a_column']"));
await savepointRefusal(expectSql("array['ended_at','ended_at']"));
await savepointRefusal(expectSql("array['ended_at',null]"));
await savepointRefusal(expectSql("array['ended_at','end_reason']",{...before,profile_id:OTHER},after));
await savepointRefusal(expectSql("array['ended_at']",before,after,'profiles'));
await savepointRefusal(expectSql("array['ended_at']",{...before,note:'🪟'.repeat(2100)},after));
const expectation=(await one(expectSql("array['ended_at','end_reason']"))).id;
await savepointRefusal(`update work_activity_expected_mutations set source_id='${id(999)}' where id='${expectation}'`);
await savepointRefusal(`delete from work_activity_expected_mutations where id='${expectation}'`);
await savepointRefusal(`select _work_activity_context_close('${frame}')`);
await savepointRefusal(`select _work_activity_consume('${expectation}','task_sessions','UPDATE',${quote(before)},${quote(after)})`);
await savepointRefusal(`select _work_activity_consume('${expectation}','unit_sessions','UPDATE',${quote(before)},${quote({...after,profile_id:OTHER})})`);
await savepointRefusal(`select _work_activity_consume('${expectation}','unit_sessions','UPDATE',${quote({...before,role:'install'})},${quote({...after,role:'helper'})})`);
await db.exec(`select _work_activity_consume('${expectation}','unit_sessions','UPDATE',${quote(before)},${quote(after)})`);
await savepointRefusal(`select _work_activity_consume('${expectation}','unit_sessions','UPDATE',${quote(before)},${quote(after)})`);
await savepointRefusal(`update work_activity_expected_mutations set consumed=false where id='${expectation}'`);
const nestedBefore={id:sourceId,profile_id:OWNER,source_import:{original:'same'}},nestedAfter={...nestedBefore,source_import:{original:'changed'}};
const exactJson=(await one(`select _work_activity_expect('${frame}','time_shifts','UPDATE','${sourceId}',array['source_import'],${quote(nestedBefore)},${quote(nestedAfter)}) id`)).id;
await savepointRefusal(`select _work_activity_consume('${exactJson}','time_shifts','UPDATE',${quote(nestedBefore)},${quote({...nestedAfter,source_import:{original:'changed',injected:true}})})`);
await db.exec(`select _work_activity_consume('${exactJson}','time_shifts','UPDATE',${quote(nestedBefore)},${quote(nestedAfter)})`);
await db.exec(`select _work_activity_context_close('${frame}');commit;`);
check((await one('select count(*)::int n from work_activity_transaction_context')).n===0&&(await one('select count(*)::int n from work_activity_expected_mutations')).n===0,'Committed frame leaves no ephemeral rows');
await refuse(`select _work_activity_context_assert('${frame}')`,'42501');
await db.exec('begin');const depthFrames=[];
for(let depth=0;depth<16;depth++) depthFrames.push((await one(`select _work_activity_context_open('depth_fixture','stop',now(),${depth?`'${depthFrames.at(-1)}'`:'null'}) id`)).id);
await savepointRefusal(`select _work_activity_context_open('too_deep','stop',now(),'${depthFrames.at(-1)}')`,'54000');
for(const f of depthFrames.reverse())await db.exec(`select _work_activity_context_close('${f}')`);
await db.exec('commit');check((await one('select count(*)::int n from work_activity_transaction_context')).n===0,'Maximum supported nesting unwinds cleanly');
// This tested the private allowance primitive, not a legacy source write. Only
// the following new setup-table trigger consumes actual OLD/NEW rows here.

const SHIFT=id(300),PUNCH=id(301),SETUP=id(302),START=id(303),END=id(304);
const START_AT='2026-10-03T12:00:00+00:00',END_AT='2026-10-03T12:15:00+00:00';
await db.exec(`insert into time_shifts(id,profile_id,clock_in_at,status) values('${SHIFT}','${OWNER}','${START_AT}','open');
 insert into time_clock_actions(client_id,shift_id,profile_id,action,outcome) values('${PUNCH}','${SHIFT}','${OWNER}','clock_in','clocked_in');`);
const transitionSql=(transition,revision,cause,time,profile=OWNER,shift=SHIFT,request=PUNCH)=>`insert into personal_activity_transitions(id,profile_id,revision_before,revision_after,legacy_source_route,source_request_id,actor_id,cause,selected_effective_at,time_selection_reason,source_shift_id,before_evidence,after_evidence,protocol_version)
 values('${transition}','${profile}',${revision},${revision+1},'synthetic_fixture','${request}','${profile}','${cause}','${time}','fixture','${shift}','{}','{}',1)`;
await db.exec(transitionSql(START,100,'clock_in',START_AT));
const setupInsert=(setup=SETUP,transition=START)=>`insert into work_setup_sessions(id,profile_id,shift_id,clock_client_id,started_at,start_transition_id) values('${setup}','${OWNER}','${SHIFT}','${PUNCH}','${START_AT}','${transition}')`;
await refuse(setupInsert(),'42501');
const openFrame=async(cause,time)=>(await one(`select _work_activity_context_open('fixture_setup','${cause}','${time}') id`)).id;
const setupExpected=(setup=SETUP,transition=START)=>({id:setup,profile_id:OWNER,shift_id:SHIFT,clock_client_id:PUNCH,started_at:START_AT,start_transition_id:transition});
const expectSetupInsert=async(frame,setup=SETUP,transition=START)=>db.exec(`select _work_activity_expect('${frame}','work_setup_sessions','INSERT','${setup}',array['id','profile_id','shift_id','clock_client_id','started_at','start_transition_id'],null,${quote(setupExpected(setup,transition))})`);
// Missing actual lifecycle causes deferred failure and rolls back setup/frames.
await db.exec('begin');const badFrame=await openFrame('clock_in',START_AT);await expectSetupInsert(badFrame,SETUP,id(399));await db.exec(setupInsert(SETUP,id(399)));await db.exec(`select _work_activity_context_close('${badFrame}')`);await refuse('commit','23503');await db.exec('rollback');
check((await one(`select count(*)::int n from work_setup_sessions where id='${SETUP}'`)).n===0,'Missing lifecycle rolls back actual setup insertion');
await db.exec(transitionSql(id(398),200,'clock_in',START_AT,OTHER));
await db.exec('begin');const foreignFrame=await openFrame('clock_in',START_AT);await expectSetupInsert(foreignFrame,SETUP,id(398));await db.exec(setupInsert(SETUP,id(398)));await db.exec(`select _work_activity_context_close('${foreignFrame}')`);await refuse('commit');await db.exec('rollback');
check((await one(`select count(*)::int n from work_setup_sessions where id='${SETUP}'`)).n===0,'Existing foreign lifecycle cannot authorize this person setup');
await db.exec('begin');const setupFrame=await openFrame('clock_in',START_AT);await expectSetupInsert(setupFrame);
await savepointRefusal(`insert into work_setup_sessions(id,profile_id,shift_id,clock_client_id,started_at,start_transition_id,ended_at,selected_end_at,end_reason,end_transition_id) values('${SETUP}','${OWNER}','${SHIFT}','${PUNCH}','${START_AT}','${START}','${END_AT}','${END_AT}','setup_complete','${END}')`);
await db.exec(setupInsert());await db.exec(`select _work_activity_context_close('${setupFrame}');commit`);
check((await one(`select start_transition_id from work_setup_sessions where id='${SETUP}'`)).start_transition_id===START,'Exact private frame records setup against actual keyed clock/lifecycle');
await rollbackCase(async()=>{await db.exec(`update personal_activity_state set shift_id='${SHIFT}',active_source_kind='setup',active_source_id='${SETUP}',effective_since='${START_AT}' where profile_id='${OWNER}'`);check((await one(`select active_source_kind from personal_activity_state where profile_id='${OWNER}'`)).active_source_kind==='setup','Existing state can represent a setup source without another shift');});
await refuse(`update personal_activity_state set active_source_kind='setup' where profile_id='${OWNER}'`);
await refuse(`update personal_activity_state set revision=9007199254740992 where profile_id='${OWNER}'`);
await refuse(`delete from work_setup_sessions where id='${SETUP}'`);
await refuse(`update work_setup_sessions set started_at=started_at+interval '1 minute' where id='${SETUP}'`);
await refuse(`update work_setup_sessions set ended_at='${END_AT}',selected_end_at='${END_AT}',end_reason='setup_complete',end_transition_id='${END}' where id='${SETUP}'`,'42501');
await db.exec(transitionSql(END,101,'stop',END_AT));
const setupBefore={id:SETUP,profile_id:OWNER,ended_at:null,selected_end_at:null,end_reason:null,end_transition_id:null};
const setupEvent=(transition,setup,shift,cause,time)=>`insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,source_shift_id,selected_effective_at,cause,before_evidence,after_evidence) values('${transition}','${OWNER}','setup','${setup}','effective','${shift}','${time}','${cause}','{}','{}')`;
const setupAfter={...setupBefore,ended_at:END_AT,selected_end_at:END_AT,end_reason:'setup_complete',end_transition_id:END};
await db.exec('begin');const endFrame=await openFrame('stop',END_AT);
await db.exec(`select _work_activity_expect('${endFrame}','work_setup_sessions','UPDATE','${SETUP}',array['ended_at','selected_end_at','end_reason','end_transition_id'],${quote(setupBefore)},${quote(setupAfter)})`);
await db.exec(`update work_setup_sessions set ended_at='${END_AT}',selected_end_at='${END_AT}',end_reason='setup_complete',end_transition_id='${END}' where id='${SETUP}';select _work_activity_context_close('${endFrame}');${setupEvent(END,SETUP,SHIFT,'stop',END_AT)};commit;`);
check((await one(`select ended_at::text ended from work_setup_sessions where id='${SETUP}'`)).ended.includes('12:15:00'),'Setup closes once at its exact lifecycle boundary');
await refuse(`update work_setup_sessions set ended_at=null,end_reason=null,end_transition_id=null where id='${SETUP}'`);
// Retained source identities never acquire operational cascading foreign keys.
const setupSnapshot=JSON.stringify(await all(`select * from work_setup_sessions where id='${SETUP}'`));
await db.exec(`delete from time_shifts where id='${SHIFT}'`);
check(JSON.stringify(await all(`select * from work_setup_sessions where id='${SETUP}'`))===setupSnapshot,'Deleting synthetic operational shift preserves setup/clock UUID history');
check((await one("select count(*)::int n from pg_constraint where conrelid='work_setup_sessions'::regclass and confrelid in ('time_shifts'::regclass,'profiles'::regclass,'time_clock_actions'::regclass)")).n===0,'Setup has no operational parent FK');
// Closing a previously valid owned interval cannot depend on its old clock
// source still existing or on current new-start eligibility.
const SHIFT2=id(410),PUNCH2=id(411),SETUP2=id(412),START2=id(413),END2=id(414);
await db.exec(`insert into time_shifts(id,profile_id,clock_in_at,status) values('${SHIFT2}','${OWNER}','${START_AT}','open');insert into time_clock_actions(client_id,shift_id,profile_id,action,outcome) values('${PUNCH2}','${SHIFT2}','${OWNER}','clock_in','clocked_in');`);
await db.exec(transitionSql(START2,102,'clock_in',START_AT,OWNER,SHIFT2,PUNCH2));
await db.exec('begin');const sf2=await openFrame('clock_in',START_AT);
const sa2={...setupExpected(SETUP2,START2),shift_id:SHIFT2,clock_client_id:PUNCH2};
await db.exec(`select _work_activity_expect('${sf2}','work_setup_sessions','INSERT','${SETUP2}',array['id','profile_id','shift_id','clock_client_id','started_at','start_transition_id'],null,${quote(sa2)});insert into work_setup_sessions(id,profile_id,shift_id,clock_client_id,started_at,start_transition_id) values('${SETUP2}','${OWNER}','${SHIFT2}','${PUNCH2}','${START_AT}','${START2}');select _work_activity_context_close('${sf2}');commit;`);
await db.exec(`delete from time_shifts where id='${SHIFT2}';update profiles set access_revoked_at=now() where id='${OWNER}'`);
await refuse(`select _work_activity_observe('${DEVICE}')`,'42501');
await db.exec(transitionSql(END2,103,'clock_out',END_AT,OWNER,SHIFT2,PUNCH2));
await db.exec('begin');const ef2=await openFrame('clock_out',END_AT);
const sb2={...setupBefore,id:SETUP2},se2={...sb2,ended_at:END_AT,selected_end_at:END_AT,end_reason:'clock_out',end_transition_id:END2};
await db.exec(`select _work_activity_expect('${ef2}','work_setup_sessions','UPDATE','${SETUP2}',array['ended_at','selected_end_at','end_reason','end_transition_id'],${quote(sb2)},${quote(se2)})`);
await savepointRefusal(`update work_setup_sessions set ended_at='2026-10-03 12:16Z',end_reason='clock_out',end_transition_id='${END2}' where id='${SETUP2}'`);
await db.exec(`update work_setup_sessions set ended_at='${END_AT}',selected_end_at='${END_AT}',end_reason='clock_out',end_transition_id='${END2}' where id='${SETUP2}';select _work_activity_context_close('${ef2}');${setupEvent(END2,SETUP2,SHIFT2,'clock_out',END_AT)};commit;`);
check((await one(`select end_reason from work_setup_sessions where id='${SETUP2}'`)).end_reason==='clock_out','Private identity kernel allows exact owned close after source deletion and access revocation');
await db.exec(`update profiles set access_revoked_at=null where id='${OWNER}'`);
const evidenceSql=(profile=OWNER,evidence={})=>`insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) values('${END}','${profile}','unit','${id(449)}','companion','{}',${quote(evidence)})`;
await refuse(evidenceSql(OTHER));
await refuse(evidenceSql(OWNER,{note:'🪟'.repeat(2100)}));
await db.exec(evidenceSql());
await refuse(`update personal_activity_transition_sources set relation='conflict' where transition_id='${END}'`);
await refuse(`delete from personal_activity_transition_sources where transition_id='${END}'`);
check((await one(`select source_id from personal_activity_transition_sources where transition_id='${END}' and source_kind='setup'`)).source_id===SETUP,'Supplemental source retains exact canonical lifecycle identity');
const emptyEvidenceBytes=(await one(`select octet_length(jsonb_build_object('note','')::text)::int n`)).n;
const exactEvidence=`jsonb_build_object('note',repeat('x',${8192}- ${emptyEvidenceBytes}))`;
await db.exec(`insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) values('${END}','${OWNER}','unit','${id(450)}','conflict','{}',${exactEvidence})`);
check((await one(`select octet_length(after_evidence::text)::int n from personal_activity_transition_sources where source_id='${id(450)}'`)).n===8192,'Exact 8192-byte evidence fits without truncation');
await refuse(`insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) values('${END}','${OWNER}','unit','${id(451)}','conflict','{}',jsonb_build_object('note',repeat('x',8193-${emptyEvidenceBytes})))`);
// Real private setup trigger path through break closure and a fresh segment.
const SHIFT3=id(500),PUNCH3=id(501),SETUP3=id(502),SETUP4=id(503),T3=id(504),TB=id(505),TR=id(506);
await db.exec(`insert into time_shifts(id,profile_id,clock_in_at,status) values('${SHIFT3}','${OWNER}','${START_AT}','open');insert into time_clock_actions(client_id,shift_id,profile_id,action,outcome) values('${PUNCH3}','${SHIFT3}','${OWNER}','clock_in','clocked_in');`);
const insertSegment=async(setup,t,cause,time,prior=null)=>{
 await db.exec('begin');const f=await openFrame(cause,time);
 const row={id:setup,profile_id:OWNER,shift_id:SHIFT3,clock_client_id:PUNCH3,started_at:time,start_transition_id:t,resumed_from_id:prior};
 await db.exec(`select _work_activity_expect('${f}','work_setup_sessions','INSERT','${setup}',array['id','profile_id','shift_id','clock_client_id','started_at','start_transition_id','resumed_from_id'],null,${quote(row)});insert into work_setup_sessions(id,profile_id,shift_id,clock_client_id,started_at,start_transition_id,resumed_from_id) values('${setup}','${OWNER}','${SHIFT3}','${PUNCH3}','${time}','${t}',${prior?`'${prior}'`:'null'});select _work_activity_context_close('${f}');commit;`);
};
await db.exec(transitionSql(T3,104,'clock_in',START_AT,OWNER,SHIFT3,PUNCH3));await insertSegment(SETUP3,T3,'clock_in',START_AT);
await db.exec(transitionSql(TB,105,'break_start',END_AT,OWNER,SHIFT3,id(507)));
await db.exec('begin');const breakFrame=await openFrame('break_start',END_AT);
const breakBefore={...setupBefore,id:SETUP3},breakAfter={...breakBefore,ended_at:END_AT,selected_end_at:END_AT,end_reason:'break',end_transition_id:TB};
await db.exec(`select _work_activity_expect('${breakFrame}','work_setup_sessions','UPDATE','${SETUP3}',array['ended_at','selected_end_at','end_reason','end_transition_id'],${quote(breakBefore)},${quote(breakAfter)});update work_setup_sessions set ended_at='${END_AT}',selected_end_at='${END_AT}',end_reason='break',end_transition_id='${TB}' where id='${SETUP3}';select _work_activity_context_close('${breakFrame}');${setupEvent(TB,SETUP3,SHIFT3,'break_start',END_AT)};commit;`);
const resumeAt='2026-10-03T12:30:00+00:00';await db.exec(transitionSql(TR,106,'break_end',resumeAt,OWNER,SHIFT3,id(508)));
await insertSegment(SETUP4,TR,'break_end',resumeAt,SETUP3);
check((await one(`select resumed_from_id from work_setup_sessions where id='${SETUP4}'`)).resumed_from_id===SETUP3,'Setup return creates a new segment preserving original break history');
check((await one(`select count(*)::int n from work_setup_sessions where clock_client_id='${PUNCH3}'`)).n===2,'Setup resume retains both segments against one original clock request');
check((await one(`select count(*)::int n from work_setup_sessions where profile_id='${OWNER}' and ended_at is null`)).n===1,'Only the resumed setup is open');
// One root clock-in closes old setup and starts new setup, preserving distinct
// source boundaries under ONE personal revision. This exercises private source
// guards, not the not-yet-installed payroll adapter.
const MOVE_SHIFT=id(600),MOVE_PUNCH=id(601),MOVE_SETUP=id(602),MOVE_T=id(603);
const moveAt='2026-10-03T12:45:00+00:00',oldCloseAt='2026-10-03T12:44:00+00:00';
await db.exec(`insert into time_shifts(id,profile_id,clock_in_at,status) values('${MOVE_SHIFT}','${OWNER}','${moveAt}','open');insert into time_clock_actions(client_id,shift_id,profile_id,action,outcome) values('${MOVE_PUNCH}','${MOVE_SHIFT}','${OWNER}','clock_in','clocked_in');`);
const moveBefore={...setupBefore,id:SETUP4},moveAfter={...moveBefore,ended_at:oldCloseAt,selected_end_at:oldCloseAt,end_reason:'clock_out',end_transition_id:MOVE_T};
const moveNew={id:MOVE_SETUP,profile_id:OWNER,shift_id:MOVE_SHIFT,clock_client_id:MOVE_PUNCH,started_at:moveAt,start_transition_id:MOVE_T};
const moveTransaction=async(eventMode)=>{
 await db.exec('begin');const root=await openFrame('clock_in',moveAt);
 const child=(await one(`select _work_activity_context_open('fixture_old_close','clock_out','${oldCloseAt}','${root}') id`)).id;
 await db.exec(`select _work_activity_expect('${child}','work_setup_sessions','UPDATE','${SETUP4}',array['ended_at','selected_end_at','end_reason','end_transition_id'],${quote(moveBefore)},${quote(moveAfter)});update work_setup_sessions set ended_at='${oldCloseAt}',selected_end_at='${oldCloseAt}',end_reason='clock_out',end_transition_id='${MOVE_T}' where id='${SETUP4}';select _work_activity_context_close('${child}');`);
 await db.exec(`select _work_activity_expect('${root}','work_setup_sessions','INSERT','${MOVE_SETUP}',array['id','profile_id','shift_id','clock_client_id','started_at','start_transition_id'],null,${quote(moveNew)});insert into work_setup_sessions(id,profile_id,shift_id,clock_client_id,started_at,start_transition_id) values('${MOVE_SETUP}','${OWNER}','${MOVE_SHIFT}','${MOVE_PUNCH}','${moveAt}','${MOVE_T}');select _work_activity_context_close('${root}');${transitionSql(MOVE_T,107,'clock_in',moveAt,OWNER,MOVE_SHIFT,MOVE_PUNCH)};`);
 if(eventMode!=='missing')await db.exec(setupEvent(MOVE_T,SETUP4,eventMode==='wrong_shift'?MOVE_SHIFT:SHIFT3,eventMode==='wrong_cause'?'clock_in':'clock_out',eventMode==='wrong_boundary'?moveAt:oldCloseAt));
};
const moveLedgerBefore=(await one(`select count(*)::int n from personal_activity_transitions where profile_id='${OWNER}'`)).n;
for(const mode of ['missing','wrong_shift','wrong_cause','wrong_boundary']){
 await moveTransaction(mode);await refuse('commit');await db.exec('rollback');
 check((await one(`select ended_at is null unchanged from work_setup_sessions where id='${SETUP4}'`)).unchanged&&!(await one(`select exists(select 1 from work_setup_sessions where id='${MOVE_SETUP}') found`)).found&&!(await one(`select exists(select 1 from personal_activity_transitions where id='${MOVE_T}') found`)).found,`Compound move ${mode} rolls back old close, new setup and root transition`);
}
await moveTransaction('valid');await db.exec('commit');
check((await one(`select count(*)::int n from personal_activity_transitions where profile_id='${OWNER}'`)).n===moveLedgerBefore+1,'Compound move adds exactly one personal transition');
check((await one(`select old.end_transition_id=new.start_transition_id same,old.shift_id='${SHIFT3}' old_shift,new.shift_id='${MOVE_SHIFT}' new_shift,old.selected_end_at='${oldCloseAt}' old_boundary,new.started_at='${moveAt}' new_boundary from work_setup_sessions old cross join work_setup_sessions new where old.id='${SETUP4}' and new.id='${MOVE_SETUP}'`)).same,'Old close and new start share the same canonical transition');
const moveRows=await one(`select old.shift_id='${SHIFT3}' old_shift,new.shift_id='${MOVE_SHIFT}' new_shift,old.selected_end_at='${oldCloseAt}' old_boundary,new.started_at='${moveAt}' new_boundary from work_setup_sessions old cross join work_setup_sessions new where old.id='${SETUP4}' and new.id='${MOVE_SETUP}'`);
check(Object.values(moveRows).every(v=>v===true),'Compound move preserves distinct original shifts and exact source boundaries');
check((await one(`select count(*)::int n from work_setup_sessions where profile_id='${OWNER}' and ended_at is null`)).n===1,'Compound move leaves only new setup open');
check(JSON.stringify({shifts:await all(`select * from time_shifts where id='${id(9001)}'`),sessions:await all(`select * from custom_work_sessions where id='${id(9002)}'`)})===beforeSources,'All private tests preserve baseline payroll and session evidence byte-for-byte');
check((await one('select count(*)::int n from work_activity_transaction_context')).n===0&&(await one('select count(*)::int n from work_activity_expected_mutations')).n===0,'No final ephemeral context or allowance survives');
await db.close();console.log(`Work activity inactive substrate: ${checks} checks passed; no timing activation or multi-backend claim.`);
