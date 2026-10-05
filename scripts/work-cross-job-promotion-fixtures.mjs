// Checkpoint4 source simulation. No provider access or genuine-role claim.
export async function beforeInstall(db,q,assert){
 const id=n=>'00000000-0000-4000-8000-'+String(490000+n).padStart(12,'0');
 const as=async(n,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(n)]);await db.exec('set role '+role)};
 await db.query('insert into auth.users(id) values($1),($2)',[id(1),id(2)]);
 await db.query("insert into profiles(id,display_name,role,is_test) values($1,'Promotion baseline','owner',false),($2,'Promotion fresh','owner',false)",[id(1),id(2)]);
 await db.query("insert into projects(id,job_code,name) values($1,'PROMOTION-A','Synthetic promotion A'),($2,'PROMOTION-B','Synthetic promotion B')",[id(10),id(11)]);
 await as(1,'postgres');await db.exec('select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1');
 console.log('PROMOTION baseline fresh capability');await as(2);const fresh=(await q('select work_activity_clock_capability() value')).value;
 await as(1,'postgres');const stamps=await q("select _work_activity_iso(clock_timestamp()-interval '3 hours') tap,_work_activity_iso(clock_timestamp()) checked");await as(1);const shift=(await q("select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0,1)) value",[id(10),id(100),stamps.tap,stamps.checked])).value;
 const existing=(await q('select work_activity_clock_capability() value')).value;
 const receipt=(await q('select work_activity_clock_receipt($1) value',[id(100)])).value;
 await as(1,'postgres');return {id,as,fresh,existing,receipt,shift,stamps};
}
export async function runPromotion(db,q,assert,catalogSql,b){
 const {id,as}=b;let n=5000;let checks=0;const labels=[];
 const check=(v,label)=>{assert.ok(v,label);checks++;labels.push(label);console.log('PROMOTION PASS',checks,label)};
 const sem=x=>{const y={...x};delete y.asOf;return y};
 console.log('PROMOTION installed fresh capability');await as(2);assert.deepEqual(sem((await q('select work_activity_clock_capability() value')).value),sem(b.fresh));check(true,'Fresh v1 readiness matches source baseline except asOf');
 await as(1);assert.deepEqual(sem((await q('select work_activity_clock_capability() value')).value),sem(b.existing));check(true,'Existing v1 readiness matches source baseline except asOf');
 assert.deepEqual((await q('select work_activity_clock_receipt($1) value',[id(100)])).value,b.receipt);check(true,'Original v1 historical receipt byte-equivalent after promotion');
 await as(1);assert.deepEqual((await q('select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0,1)) value',[id(10),id(100),b.stamps.tap,b.stamps.checked])).value,b.shift);assert.deepEqual((await q('select work_activity_clock_receipt($1) value',[id(100)])).value,b.receipt);check(true,'Original pre-install v1 keyed clock-in replay and receipt remain byte-equivalent');
 await as(1,'postgres');const guards=(await db.query("select c.relname,t.tgname,t.tgtype,t.tgenabled,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname like 'work_cross_job_%' and t.tgname='guard_test_account_sandbox_only' order by c.relname")).rows;
 assert.deepEqual(guards.map(x=>[x.relname,x.tgtype,x.tgenabled]),[['work_cross_job_allocations',31,'O'],['work_cross_job_bindings',31,'O']]);
 check(guards.every(x=>x.definition.includes("('project_id', 'project')")),'Exactly two enabled standard sandbox triggers and exact arguments');
 const ordinal=(await db.query("select c.relname,array_agg(t.tgname order by t.tgname) names from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname in('work_cross_job_allocations','work_cross_job_bindings') and not t.tgisinternal and (t.tgtype&1)=1 group by c.relname")).rows;
 check(ordinal.every(x=>x.names[0]==='guard_test_account_sandbox_only'),'Sandbox BEFORE row trigger precedes allocation admission/immutability');
 await db.exec('begin');
 await db.exec('create or replace function _work_cross_job_enabled() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select true$$');
 const seal=async()=>{const digest=(await q(`select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') value from (${catalogSql}) c`)).value;await db.exec('alter table work_cross_job_contract disable trigger work_cross_job_contract_immutable');await db.query('update work_cross_job_contract set expected_catalog_sha256=$1',[digest]);await db.exec('alter table work_cross_job_contract enable trigger work_cross_job_contract_immutable')};
 await seal();
 const tally=async()=>{await as(1,'postgres');return (await q("select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(s) order by client_id) from work_cross_job_clock_requests s),'paid',(select jsonb_agg(to_jsonb(s) order by id) from time_shifts s),'receipts',(select jsonb_agg(to_jsonb(s) order by client_id) from work_activity_clock_receipts s),'actions',(select jsonb_agg(to_jsonb(s) order by client_id) from time_clock_actions s),'registrations',(select jsonb_agg(to_jsonb(s) order by shift_id) from work_cross_job_shifts s),'allocations',(select jsonb_agg(to_jsonb(s) order by id) from work_cross_job_allocations s),'bindings',(select jsonb_agg(to_jsonb(s) order by source_kind,source_id) from work_cross_job_bindings s),'history',(select jsonb_agg(to_jsonb(s) order by id) from work_activity_source_history s),'transitions',(select jsonb_agg(to_jsonb(s) order by id) from personal_activity_transitions s),'frames',(select jsonb_agg(to_jsonb(s) order by operation_id) from work_cross_job_write_frames s),'operations',(select jsonb_agg(to_jsonb(s) order by id) from work_activity_operations s)) value")).value};
 const checked=(await q('select _work_activity_iso(clock_timestamp()) value')).value;
 const clock=async(version,client,tap,who=1)=>{await as(who);return (await q(version===0?'select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0)) value':'select to_jsonb(clock_in($1::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,$2::uuid,$3::timestamptz,$4::timestamptz,0,$5::int)) value',version===0?[id(10),client,tap,checked]:[id(10),client,tap,checked,version])).value};
 await db.query("insert into toolbox_completions(profile_id,signed_at,typed_name) values($1,clock_timestamp(),'Synthetic')",[id(1)]);
 await as(1);await q("select clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,clock_timestamp()-interval '2 hours',clock_timestamp(),0)",[b.shift.id,id(n++)]);await as(1,'postgres');
 await db.exec('savepoint matrix');
 for(const stored of [0,1,2]){
  await as(1,'postgres');await db.exec('rollback to savepoint matrix');
  const tap=(await q("select _work_activity_iso(clock_timestamp()-interval '80 minutes') value")).value,client=id(n++);
  const shift=await clock(stored,client,tap);await as(1,'postgres');assert.equal((await q('select exists(select 1 from work_cross_job_shifts where shift_id=$1) value',[shift.id])).value,stored===2,'Fixture must actually create requested registered generation');
  for(const requested of [0,1,2]){
   await as(1,'postgres');const before=await tally();await db.exec('savepoint replay');let err;
   try{await clock(requested,client,tap)}catch(e){err=e}
   const accepted=(stored===2?requested===2:stored===1?requested!==2:requested===0);
   if(!accepted){assert.equal(err?.code,'23514');assert.equal(err.message,'Clock command identity conflicts.');await as(1,'postgres').catch(()=>{});await db.exec('rollback to savepoint replay');assert.deepEqual(await tally(),before)}
   else {assert.equal(err,undefined);assert.deepEqual(await tally(),before)}
   check(true,`Stored${stored} requested${requested}: exact replay disposition and zero paid/evidence/frame mutation`);
  }
  if(stored===2){
   await as(1);const cap=(await q('select work_activity_clock_capability() value')).value;
   check(cap.mode==='unavailable'&&cap.setupReason==='not_ready'&&!cap.canAuthorSetup&&cap.canDispatchExistingSetup&&cap.canReadOwnReceipts&&cap.canDispatchPayrollSafety,'Registered v2 old-shape readiness unavailable with all three permission flags true');
   await as(1,'postgres');await db.exec('savepoint held_capability');await db.exec('create or replace function _work_cross_job_enabled() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select false$$');await seal();await as(1);const heldCap=(await q('select work_activity_clock_capability() value')).value;assert.deepEqual(sem(heldCap),sem(cap));check(true,'Registered v2 retained shift stays not_ready with all paid permission flags true while capture literal false');await as(1,'postgres');await db.exec('rollback to savepoint held_capability');await as(1);
   const missing=(await q('select work_activity_clock_receipt($1) value',[id(n++)])).value;
   assert.deepEqual((await q('select work_activity_clock_receipt($1) value',[client])).value,missing);check(true,'Registered v2 setup receipt equals unknown envelope');
   for(const action of ['break_start','break_end','clock_out']){
    const key=id(n++);const sql=action==='break_start'?"select to_jsonb(start_break($1::uuid,'rest'::text,$2::uuid,clock_timestamp(),clock_timestamp(),0)) value":action==='break_end'?'select to_jsonb(end_break($1::uuid,$2::uuid,clock_timestamp(),clock_timestamp(),0)) value':'select to_jsonb(clock_out($1::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text,$2::uuid,clock_timestamp(),clock_timestamp(),0)) value';
    await as(1);await q(sql,[shift.id,key]);const receipt=(await q('select work_activity_clock_receipt($1) value',[key])).value;check(receipt.availability==='available'&&receipt.receipt.action===action,action+' retained v2 paid receipt remains readable');
    const before=await tally();await as(1);await q(sql,[shift.id,key]);assert.deepEqual(await tally(),before);check(true,action+' retained v2 paid replay leaves exact rows unchanged');
   }
   await as(1);assert.deepEqual((await q('select work_activity_clock_receipt($1) value',[client])).value,missing);check(true,'V2 setup receipt remains fenced after physical clock-out');
  }
 }
 await as(1,'postgres');await db.exec('rollback to savepoint matrix');
 // Queued v1 setup must retain original arrival closure of current v2 payroll.
 let tap=(await q("select _work_activity_iso(clock_timestamp()-interval '80 minutes') value")).value;
 const current=await clock(2,id(n++),tap);await as(1,'postgres');const registrations=(await q('select jsonb_agg(to_jsonb(s) order by shift_id) value from work_cross_job_shifts s')).value;
 const queued=await clock(1,id(n++),tap);await as(1,'postgres');const ended=await q('select clock_out_at,last_punch_at from time_shifts where id=$1',[current.id]);
 check(!!ended.clock_out_at&&queued.id!==current.id,'Queued v1 setup closes current v2 at original paid arrival path');assert.deepEqual((await q('select jsonb_agg(to_jsonb(s) order by shift_id) value from work_cross_job_shifts s')).value,registrations);check(true,'Queued v1 setup preserves retained v2 registration history');
 await db.exec('rollback to savepoint matrix');
 // A real retained v2 setup can later be resumed by a QA actor only if guards allow it.
 const setupShift=await clock(2,id(n++),tap);await as(1,'postgres');await db.query('update profiles set is_test=true where id=$1',[id(1)]);await db.query("insert into sandbox_projects(project_id,note) values($1,'Synthetic promotion')",[id(10)]);
 await as(1);await q("select start_break($1::uuid,'rest'::text,$2::uuid,clock_timestamp()-interval '30 minutes',clock_timestamp(),0)",[setupShift.id,id(n++)]);await as(1,'postgres');const setupCount=(await q('select count(*)::int n from work_setup_sessions where shift_id=$1',[setupShift.id])).n;
 const returnTap=(await q("select _work_activity_iso(clock_timestamp()-interval '10 minutes') value")).value;await as(1);await q('select end_break($1::uuid,$2::uuid,$3::timestamptz,clock_timestamp(),0)',[setupShift.id,id(n++),returnTap]);await as(1,'postgres');const setupState=await q('select p.active_source_id,p.choice_required,p.resume_token,s.break_started_at,_work_activity_iso(s.last_punch_at) stamp,(select count(*) from work_cross_job_resume r where r.profile_id=p.profile_id)::int cached from personal_activity_state p join time_shifts s on s.id=p.shift_id where p.profile_id=$1',[id(1)]);
 check(setupState.active_source_id===null&&setupState.choice_required&&setupState.resume_token===null&&setupState.cached===0,'Sandbox-refused retained setup resume clears cache and requires choice');check(setupState.break_started_at===null&&setupState.stamp===returnTap&&(await q('select count(*)::int n from work_setup_sessions where shift_id=$1',[setupShift.id])).n===setupCount,'Sandbox-refused setup resume completes original paid return without replacement setup');await db.exec('rollback to savepoint matrix');
 // QA v1 sandbox setup remains supported, v2 null-project binding refuses atomically.
 await db.query('update profiles set is_test=true where id=$1',[id(1)]);await db.query("insert into sandbox_projects(project_id,note) values($1,'Synthetic promotion')",[id(10)]);
 await db.exec('savepoint qa');const before=await tally();let err;try{await clock(2,id(n++),tap)}catch(e){err=e}
 assert.equal(err?.code,'42501');await db.exec('rollback to savepoint qa');assert.deepEqual(await tally(),before);check(true,'QA v2 setup refuses atomically with zero paid/receipt/source/allocation/frame mutation');
 const qaShift=await clock(1,id(n++),tap);check(!!qaShift.id,'Same QA v1 sandbox setup remains successful');
 await as(1,'postgres');await db.exec('rollback');
 return {checks,labels,scope:'declared profile PGlite simulation; not genuine actors'};
}
