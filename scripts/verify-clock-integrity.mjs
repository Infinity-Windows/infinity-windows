// Disposable PostgreSQL checks for 20261028000000_clock_integrity.sql (Release
// 0, "trust the clock": K0.2 one-time ids, K0.4 lunch-return integrity, K0.5 tap
// time vs arrival time). Minimal schema, the REAL clock RPCs, no network, no
// credentials, no production records.
//
// Every failure mode the migration exists to close is called here, the way a
// phone would call it, and asserted on the row that comes back:
//   * the same clock-in id twice makes ONE shift;
//   * clock_out twice leaves clock_out_at and status where the first left them,
//     and an approved shift is untouched by any resend;
//   * end_break with no running break is an outcome, not a silent success — the
//     shift carries review_reason and an audit line, the ledger keeps the refusal,
//     and a replay of the same id answers the same way;
//   * the tap-time rule accepts and rejects exactly the cases the owner set;
//   * the legacy signatures refuse a second close and a break with no start;
//   * payroll: existing rows' hours are byte-identical across the migration, and
//     an ordinary online punch pays the same hours through the keyed overloads as
//     through the legacy ones.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,is_partner boolean default false,display_name text);
create table time_shifts(
  id uuid primary key default gen_random_uuid(),profile_id uuid not null references profiles(id) on delete cascade,
  project_id uuid,cost_code_id uuid,clock_in_at timestamptz not null default now(),clock_out_at timestamptz,
  break_seconds int not null default 0,clock_in_photo text,clock_out_photo text,injured boolean,injury_note text,
  time_confirmed boolean,signed_at timestamptz,
  status text not null default 'open' check (status in ('open','submitted','approved','rejected','needs_finish','voided')),
  approved_by uuid,approved_at timestamptz,edited_note text,created_at timestamptz not null default now(),
  break_started_at timestamptz,break_type text check (break_type in ('lunch','rest','other')),
  clock_in_lat double precision,clock_in_lng double precision,clock_out_lat double precision,clock_out_lng double precision,
  client_id uuid,note text,job_mode text check (job_mode is null or job_mode in ('data','tracking')),
  edited_by uuid,edited_at timestamptz,rejected_by uuid,rejected_at timestamptz,reject_reason text,
  voided_at timestamptz,voided_by uuid,voided_reason text,closed_reason text,clocked_in_by uuid,clocked_out_by uuid,
  last_seen_at timestamptz,last_seen_lat double precision,last_seen_lng double precision,last_seen_accuracy_m double precision,
  evening_nudged_on date,source_import_key text,source_import jsonb,edited_after_signing boolean not null default false,job_name text);
create unique index time_shifts_client_id_key on time_shifts (client_id) where client_id is not null;
create table time_shift_edits(id uuid primary key default gen_random_uuid(),shift_id uuid not null references time_shifts(id) on delete cascade,
  edited_by uuid not null references profiles(id),field text not null,old_value text,new_value text,reason text not null,created_at timestamptz not null default now());
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table opening_phases(id uuid primary key default gen_random_uuid(),status text,started_by uuid,paused_at timestamptz);
create function public.is_partner_user() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select coalesce((select is_partner from public.profiles where id=auth.uid()),false)$$;
grant select on profiles to authenticated;
grant select,insert,update,delete on time_shifts to authenticated;
grant select,insert,update on opening_phases to authenticated;
grant select on toolbox_completions to authenticated;
`);
async function source(file) { return readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'); }
async function original(file,name) {
  const text=await source(file); const start=text.indexOf('create or replace function '+name+'(');
  assert.ok(start>=0,name); const end=text.indexOf('$$;',text.indexOf('as $$',start));
  await db.exec(text.slice(start,end+3));
}
// The dangling-shift guard every clock_in calls, and the cap it reads.
await original('20260730230000_runaway_shift_guard.sql','shift_cap_hours');
await original('20260730230000_runaway_shift_guard.sql','_close_dangling_shift');
await db.exec('grant execute on function _close_dangling_shift(uuid) to authenticated');
// The legacy overloads as production has them today, so the rebuilds below are
// proven to replace exactly those bodies.
await original('20260921000000_injury_note.sql','clock_out');
await original('20260811010000_phase_pause.sql','start_break');
await original('20260718040000_time_clock_horizon.sql','end_break');
await original('20260970000000_job_modes.sql','clock_in');

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const roles=['installer','foreman','supervisor','owner'];
for (let i=0;i<roles.length;i++) await db.query('insert into profiles(id,role,display_name) values($1,$2,$3)',[id(i+1),roles[i],roles[i]]);
await db.query('insert into profiles(id,role,is_partner,display_name) values($1,$2,true,$3)',[id(9),'installer','partner']);
for (const i of [1,2,3,4,9]) await db.query('insert into toolbox_completions values($1,now())',[id(i)]);
let checks=0;
async function admin() { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); }
async function asUser(i) { await admin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(i)]); await db.exec('set role authenticated'); }
async function read(sql,args=[]) { await admin(); return (await db.query(sql,args)).rows; }
async function row(sql,args=[]) { return (await read(sql,args))[0]; }
async function denied(fn,pattern) { await assert.rejects(fn,pattern?{message:pattern}:undefined); checks++; }
const equal=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
const ok=(v,msg)=>{assert.ok(v,msg);checks++;};
const near=(a,b,ms,msg)=>{assert.ok(Math.abs(new Date(a).getTime()-new Date(b).getTime())<=ms,`${msg}: ${a} vs ${b}`);checks++;};
async function seed(person=1,over={}) {
  await admin();
  const r={id:uuid(900+checks+Math.floor(Math.random()*1000)),profile_id:id(person),project_id:uuid(90),cost_code_id:uuid(91),clock_in_at:'2026-09-14T14:00:13Z',clock_out_at:'2026-09-14T22:00:41Z',break_seconds:1800,status:'submitted',...over};
  const keys=Object.keys(r);
  await db.query(`insert into time_shifts(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r));
  return r.id;
}
const hoursSql="select id, round((extract(epoch from (clock_out_at-clock_in_at))/3600 - break_seconds/3600.0)::numeric,6)::text hours, status, clock_in_at, clock_out_at, break_seconds from time_shifts where profile_id=$1 order by id";

// --- Payroll before/after: the rows that exist before the migration ---------
const payrollPerson=4;
const fixtures=[
  await seed(payrollPerson,{clock_in_at:'2026-09-14T13:00:00Z',clock_out_at:'2026-09-14T21:30:00Z',break_seconds:1800,status:'approved'}),
  await seed(payrollPerson,{clock_in_at:'2026-09-15T13:02:11Z',clock_out_at:'2026-09-15T22:47:59Z',break_seconds:2700,status:'submitted'}),
  await seed(payrollPerson,{clock_in_at:'2026-09-16T12:58:00Z',clock_out_at:'2026-09-16T17:00:00Z',break_seconds:0,status:'rejected'}),
  await seed(payrollPerson,{clock_in_at:'2026-09-17T13:00:00Z',clock_out_at:null,break_seconds:0,status:'open'}),
];
const hoursBefore=await read(hoursSql,[id(payrollPerson)]);

// --- Apply the migration, twice (a deploy can be retried) -------------------
// The migration also restates person_record_counts (the Removed door's census),
// whose SQL body names dozens of tables this minimal schema does not have;
// body checking is off for the apply only, the way the other harnesses do it.
const migration=await source('20261028000000_clock_integrity.sql');
await db.exec('set check_function_bodies = off');
await db.exec(migration);
await db.exec(migration);
await db.exec('set check_function_bodies = on');

const hoursAfter=await read(hoursSql,[id(payrollPerson)]);
equal(hoursAfter,hoursBefore,'existing rows keep their hours, status and timestamps byte-for-byte across the migration');
equal(fixtures.length,4);
equal((await row('select count(*)::int n from time_shifts where review_reason is not null')).n,0,'no existing row is marked for review by the migration');

// --- Helpers that call the RPCs the way the phone does ----------------------
const KEYED_IN='select * from clock_in(p_project_id=>$1,p_cost_code_id=>$2,p_photo=>null,p_lat=>null,p_lng=>null,p_note=>$3,p_mode=>$4,p_client_id=>$5,p_tapped_at=>$6,p_clock_checked_at=>$7,p_clock_skew_ms=>$8)';
async function clockIn(person,clientId,{note='morning',mode='data',tap=null,checked=null,skew=null}={}) {
  await asUser(person);
  return (await db.query(KEYED_IN,[uuid(90),uuid(91),note,mode,clientId,tap,checked,skew])).rows[0];
}
const KEYED_OUT='select * from clock_out(p_shift_id=>$1,p_photo=>null,p_injured=>false,p_time_confirmed=>true,p_break_seconds=>$2,p_lat=>null,p_lng=>null,p_injury_note=>null,p_client_id=>$3,p_tapped_at=>$4,p_clock_checked_at=>$5,p_clock_skew_ms=>$6)';
async function clockOut(person,shiftId,clientId,{breakSeconds=null,tap=null,checked=null,skew=null}={}) {
  await asUser(person);
  return (await db.query(KEYED_OUT,[shiftId,breakSeconds,clientId,tap,checked,skew])).rows[0];
}
const KEYED_START='select * from start_break(p_shift_id=>$1,p_break_type=>$2,p_client_id=>$3,p_tapped_at=>$4,p_clock_checked_at=>$5,p_clock_skew_ms=>$6)';
async function startBreak(person,shiftId,clientId,{type='lunch',tap=null,checked=null,skew=null}={}) {
  await asUser(person);
  return (await db.query(KEYED_START,[shiftId,type,clientId,tap,checked,skew])).rows[0];
}
const KEYED_END='select end_break(p_shift_id=>$1,p_client_id=>$2,p_tapped_at=>$3,p_clock_checked_at=>$4,p_clock_skew_ms=>$5) r';
async function endBreak(person,shiftId,clientId,{tap=null,checked=null,skew=null}={}) {
  await asUser(person);
  return (await db.query(KEYED_END,[shiftId,clientId,tap,checked,skew])).rows[0].r;
}
async function ledger(clientId) { return row('select * from time_clock_actions where client_id=$1',[clientId]); }
async function shift(shiftId) { return row('select * from time_shifts where id=$1',[shiftId]); }

// --- K0.2: the same clock-in id twice is one shift ----------------------------
let s=await clockIn(1,uuid(1));
ok(s.id,'keyed clock-in makes a shift');
equal(s.job_mode,'data','the keyed overload records the mode the queued path could never send before');
equal(s.note,'morning');
equal(s.client_id,uuid(1));
let again=await clockIn(1,uuid(1),{note:'different words, same tap'});
equal(again.id,s.id,'a repeat of the same id answers with the original shift');
equal(again.note,'morning','and changes nothing on it');
equal((await row('select count(*)::int n from time_shifts where profile_id=$1',[id(1)])).n,1,'one shift, not two');
equal((await ledger(uuid(1))).action,'clock_in');
equal((await ledger(uuid(1))).outcome,'clocked_in');
// A punch that went through the OLDER client_id overload (time_shifts.client_id
// only, no ledger row) and is then retried through the keyed one.
await admin(); await db.query('delete from time_clock_actions where client_id=$1',[uuid(1)]);
again=await clockIn(1,uuid(1));
equal(again.id,s.id,'a shift keyed only by time_shifts.client_id is still recognised as the same punch');
equal((await row('select count(*)::int n from time_shifts where profile_id=$1',[id(1)])).n,1);

// A clock-in with no tap at all (an old bundle) is arrival time with NO mark.
equal(s.review_reason,null,'no tap sent: arrival time, no review mark — exactly what every punch before this migration was');
equal((await ledger(uuid(1)))?.used_tap_time??false,false);

// --- K0.2: clock_out twice — time and status stay put -------------------------
let closed=await clockOut(1,s.id,uuid(2),{breakSeconds:600});
equal(closed.status,'submitted');
ok(closed.clock_out_at,'first clock-out closes the shift');
equal(closed.break_seconds,600);
const firstOut=closed.clock_out_at;
await new Promise(r=>setTimeout(r,20));
let replay=await clockOut(1,s.id,uuid(2),{breakSeconds:9999});
equal(replay.clock_out_at.toISOString(),firstOut.toISOString(),'the same id again: clock_out_at did not move');
equal(replay.break_seconds,600,'and the break total did not change');
equal(replay.status,'submitted');
await denied(()=>clockOut(1,s.id,uuid(3)),/already clocked out/);
equal((await shift(s.id)).clock_out_at.toISOString(),firstOut.toISOString(),'a second close with a NEW id is refused and moves nothing');
equal(await ledger(uuid(3)),undefined,'a refused close leaves no ledger row');

// --- K0.2: an approved shift survives every resend --------------------------
await admin(); await db.query("update time_shifts set status='approved',approved_by=$2,approved_at=now() where id=$1",[s.id,id(3)]);
replay=await clockOut(1,s.id,uuid(2),{breakSeconds:0});
equal(replay.status,'approved','a resend of the original clock-out never re-submits an approved shift');
equal(replay.clock_out_at.toISOString(),firstOut.toISOString());
equal(replay.break_seconds,600);
await denied(()=>clockOut(1,s.id,uuid(4)),/already clocked out/);
await denied(()=>startBreak(1,s.id,uuid(5)),/already clocked out/);
let r=await endBreak(1,s.id,uuid(6));
equal(r.outcome,'shift_closed','a break end reaching a closed shift is nothing to do, not an error and not a flag');
equal((await shift(s.id)).review_reason,null);
equal((await shift(s.id)).status,'approved','still approved after every kind of resend');
// The legacy signatures, as a stale bundle would call them.
await asUser(1);
await denied(()=>db.query('select clock_out($1,null,false,true,0,null,null,null)',[s.id]),/already clocked out/);
await denied(()=>db.query("select start_break($1,'lunch')",[s.id]),/already clocked out/);
await denied(()=>db.query('select end_break($1)',[s.id]),/find the start of that break/);
equal((await shift(s.id)).status,'approved');
equal((await shift(s.id)).clock_out_at.toISOString(),firstOut.toISOString(),'the legacy clock_out cannot move an approved shift either');

// --- K0.4: a break end with no running break --------------------------------
s=await clockIn(2,uuid(10));
const breakShift=s.id;
r=await endBreak(2,s.id,uuid(11));
equal(r.outcome,'no_break_running','ending a break that never started is refused out loud');
equal(r.shift.review_reason,'break_end_without_break','and the shift is marked for the foreman');
equal((await shift(s.id)).break_seconds,0,'nothing was added to the break total');
equal((await shift(s.id)).break_started_at,null);
equal((await shift(s.id)).status,'open','the shift itself is untouched');
equal((await ledger(uuid(11))).outcome,'no_break_running','the refusal is kept, not thrown away');
equal((await ledger(uuid(11))).review_reason,'break_end_without_break');
let edits=await read("select field,new_value,reason from time_shift_edits where shift_id=$1",[s.id]);
equal(edits.length,1,'one audit line the supervisors and the worker can read');
equal(edits[0].field,'review_reason');
ok(/no break running/.test(edits[0].reason),'the audit line says what happened in plain words');
r=await endBreak(2,s.id,uuid(11));
equal(r.outcome,'no_break_running','a replay of the refused id answers the same way');
equal((await read('select count(*)::int n from time_shift_edits where shift_id=$1',[s.id]))[0].n,1,'and does not write a second audit line');
equal((await read('select count(*)::int n from time_clock_actions where shift_id=$1',[s.id]))[0].n,2,'one ledger row per id, never two');

// --- K0.2: breaks keyed by id across a shift with two breaks ----------------
let b=await startBreak(2,s.id,uuid(12),{type:'lunch'});
ok(b.break_started_at,'break #1 started'); equal(b.break_type,'lunch');
const firstStart=b.break_started_at;
b=await startBreak(2,s.id,uuid(12));
equal(b.break_started_at.toISOString(),firstStart.toISOString(),'the same start id again keeps the first start');
b=await startBreak(2,s.id,uuid(13),{type:'rest'});
equal(b.break_started_at.toISOString(),firstStart.toISOString(),'a NEW start while on a break keeps the running one (as it always has)');
equal(b.break_type,'lunch');
equal((await ledger(uuid(13))).outcome,'already_on_break');
r=await endBreak(2,s.id,uuid(14));
equal(r.outcome,'ended'); equal(r.shift.break_started_at,null);
const afterFirst=(await shift(s.id)).break_seconds;
b=await startBreak(2,s.id,uuid(15),{type:'rest'});
ok(b.break_started_at,'break #2 started');
r=await endBreak(2,s.id,uuid(14));
equal(r.outcome,'ended',"a stale replay of break #1's end is answered with its original result");
ok((await shift(s.id)).break_started_at,'and does NOT close break #2');
b=await startBreak(2,s.id,uuid(12));
ok((await shift(s.id)).break_started_at,"a stale replay of break #1's start does not restart anything");
r=await endBreak(2,s.id,uuid(16));
equal(r.outcome,'ended');
ok((await shift(s.id)).break_seconds>=afterFirst,'break #2 was added to the total');
equal((await shift(s.id)).review_reason,'break_end_without_break','the first reason on the row is the one that stays');

// --- K0.5: the tap-time rule ------------------------------------------------
async function trusted(person,n,over={}) {
  return clockIn(person,uuid(n),{tap:new Date(Date.now()-2*3600e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:30000,...over});
}
// (a) trusted: checked an hour ago, 30 s fast, tapped two hours before arrival.
s=await trusted(3,20);
near(s.clock_in_at,new Date(Date.now()-2*3600e3-30000),5000,'pay uses the tap time, corrected by the measured 30 s');
equal(s.review_reason,null,'a trusted tap is not marked');
equal((await ledger(uuid(20))).used_tap_time,true);
near((await ledger(uuid(20))).tapped_at,new Date(Date.now()-2*3600e3),5000,"the phone's own tap time is kept as said");
near((await ledger(uuid(20))).arrived_at,new Date(),5000,'and the arrival time beside it');
await clockOut(3,s.id,uuid(21),{breakSeconds:0});
// (b) the phone was 5 minutes off at its check.
s=await trusted(3,22,{skew:300000});
near(s.clock_in_at,new Date(),5000,'more than 2 minutes off: pay uses arrival');
equal(s.review_reason,'clock_off');
edits=await read("select reason from time_shift_edits where shift_id=$1",[s.id]);
ok(/more than 2 minutes off/.test(edits[0].reason),'the audit line explains which rule failed: '+edits[0].reason);
await clockOut(3,s.id,uuid(23),{breakSeconds:0});
// (c) the last check is 30 hours old.
s=await trusted(3,24,{checked:new Date(Date.now()-30*3600e3).toISOString()});
near(s.clock_in_at,new Date(),5000,'a check older than a day: arrival');
equal(s.review_reason,'clock_unchecked');
await clockOut(3,s.id,uuid(25),{breakSeconds:0});
// (c2) never checked at all.
s=await trusted(3,26,{checked:null,skew:null});
equal(s.review_reason,'clock_unchecked','never checked: arrival, marked');
await clockOut(3,s.id,uuid(27),{breakSeconds:0});
// (d) the tap is five minutes AFTER arrival (a clock that jumped since the check).
s=await trusted(3,28,{tap:new Date(Date.now()+300e3).toISOString(),skew:0});
near(s.clock_in_at,new Date(),5000,'a tap later than arrival: arrival');
equal(s.review_reason,'tap_after_arrival');
await clockOut(3,s.id,uuid(29),{breakSeconds:0});
// (d2) a tap 40 s "after" arrival on a phone known to be 40 s fast IS a tap
// before arrival, and must not be marked — otherwise every online punch from a
// slightly fast phone would land on the foreman's desk.
s=await trusted(3,30,{tap:new Date(Date.now()+40e3).toISOString(),skew:41000});
equal(s.review_reason,null,'a known skew is corrected before "precedes arrival" is judged');
equal((await ledger(uuid(30))).used_tap_time,true);
await clockOut(3,s.id,uuid(31),{breakSeconds:0});
// (e) the tap is 20 hours old: no shift runs that long.
s=await trusted(3,32,{tap:new Date(Date.now()-20*3600e3).toISOString()});
near(s.clock_in_at,new Date(),5000,'older than the shift cap: arrival');
equal(s.review_reason,'tap_too_old');
await clockOut(3,s.id,uuid(33),{breakSeconds:0});
// (f) a clock-out whose tap is before the clock-in.
s=await trusted(3,34);
closed=await clockOut(3,s.id,uuid(35),{breakSeconds:0,tap:new Date(Date.now()-3*3600e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:0});
near(closed.clock_out_at,new Date(),5000,'a clock-out tapped before its clock-in: arrival');
equal(closed.review_reason,'tap_out_of_order');
// (g) a trusted clock-out is paid from its tap (an hour before it arrived).
s=await trusted(3,36);
closed=await clockOut(3,s.id,uuid(37),{breakSeconds:0,tap:new Date(Date.now()-3600e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:0});
near(closed.clock_out_at,new Date(Date.now()-3600e3),5000,'a trusted clock-out pays from the tap');
equal(closed.review_reason,null);
// (h) a trusted break: started 90 minutes ago (tap), ended 30 minutes ago (tap) → 60 min of break.
s=await trusted(3,38);
b=await startBreak(3,s.id,uuid(39),{tap:new Date(Date.now()-90*60e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:0});
near(b.break_started_at,new Date(Date.now()-90*60e3),5000,'break start pays from the tap');
r=await endBreak(3,s.id,uuid(40),{tap:new Date(Date.now()-30*60e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:0});
equal(r.outcome,'ended');
ok(Math.abs(r.shift.break_seconds-3600)<=5,'the break is the tap-to-tap length, not the arrival-to-arrival length: '+r.shift.break_seconds);
equal(r.shift.review_reason,null);
// (h2) a break end tapped before its start.
b=await startBreak(3,s.id,uuid(41),{tap:new Date(Date.now()-10*60e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:0});
r=await endBreak(3,s.id,uuid(42),{tap:new Date(Date.now()-20*60e3).toISOString(),checked:new Date(Date.now()-3600e3).toISOString(),skew:0});
equal(r.outcome,'ended'); equal(r.shift.review_reason,'tap_out_of_order','a break end tapped before its start: arrival, marked');
await clockOut(3,s.id,uuid(43),{breakSeconds:null});
// (i) a clock-in that has to close a still-open shift first starts at arrival.
s=await trusted(3,44);
let next=await trusted(3,45);
near(next.clock_in_at,new Date(),5000,'the previous shift was open: this one starts at arrival, not two hours ago');
equal(next.review_reason,'previous_shift_open');
equal((await shift(s.id)).status,'submitted','and the previous one was closed by the dangling-shift guard as before');
ok((await shift(next.id)).clock_in_at>=(await shift(s.id)).clock_out_at,'no overlap between the two shifts');
await clockOut(3,next.id,uuid(46),{breakSeconds:0});

// --- Refusals ---------------------------------------------------------------
await denied(()=>clockIn(9,uuid(50)),/Not available for your account/);
await asUser(9); await denied(()=>db.query(KEYED_OUT,[s.id,null,uuid(51),null,null,null]),/Not available/);
await denied(()=>clockOut(1,next.id,uuid(52)),/no open shift/);
await admin(); await db.exec('set role anon'); await denied(()=>db.query(KEYED_IN,[uuid(90),uuid(91),null,null,uuid(53),null,null,null]));
await admin();
await asUser(2); await denied(()=>db.query(KEYED_IN,[uuid(90),uuid(91),null,null,null,null,null,null]),/missing its id/);
equal((await row('select count(*)::int n from time_clock_actions where profile_id=$1',[id(9)])).n,0,'a partner login writes nothing');
// The ledger is invisible to every client role.
await asUser(1); await denied(()=>db.query('select * from time_clock_actions'));
await admin(); await db.exec('set role anon'); await denied(()=>db.query('select * from time_clock_actions'));
await admin();

// --- Payroll: an ordinary online punch pays the same hours either way ------------
// Inside one transaction now() is one value — the moment of BEGIN — so a tap
// taken just before it is exactly what an online phone sends (the tap precedes
// the request by a few milliseconds), and the two paths can be compared to the
// second rather than within a tolerance.
await clockOut(2,breakShift,uuid(59),{breakSeconds:0}); // person 2 still had the break-section shift open
const tapNow=new Date().toISOString(), tapFast=new Date(Date.now()+45000).toISOString();
await db.exec('begin');
await asUser(4);
const legacy=(await db.query("select * from clock_in(p_project_id=>$1,p_cost_code_id=>$2,p_photo=>null,p_lat=>null,p_lng=>null,p_note=>'legacy',p_mode=>'data')",[uuid(90),uuid(91)])).rows[0];
await db.query('select clock_out($1,null,false,true,0,null,null,null)',[legacy.id]);
await asUser(2);
const keyedSame=(await db.query(KEYED_IN,[uuid(90),uuid(91),'keyed','data',uuid(60),tapNow,tapNow,0])).rows[0];
await db.query(KEYED_OUT,[keyedSame.id,0,uuid(61),tapNow,tapNow,0]);
// And a phone 45 s fast: both ends are corrected by the same skew, so the hours
// do not move.
await asUser(3);
const keyedFast=(await db.query(KEYED_IN,[uuid(90),uuid(91),'fast','data',uuid(62),tapFast,tapNow,45000])).rows[0];
await db.query(KEYED_OUT,[keyedFast.id,0,uuid(63),tapFast,tapNow,45000]);
await admin();
const paid=await read("select id, round((extract(epoch from (clock_out_at-clock_in_at))/3600 - break_seconds/3600.0)::numeric,6)::text hours, status, break_seconds, review_reason from time_shifts where id in ($1,$2,$3) order by id",[legacy.id,keyedSame.id,keyedFast.id]);
await db.exec('commit');
const hoursOf=x=>paid.find(p=>p.id===x.id);
equal(hoursOf(keyedSame).hours,hoursOf(legacy).hours,'keyed and legacy overloads pay identical hours for an online punch');
equal(hoursOf(keyedFast).hours,hoursOf(legacy).hours,'a phone 45 s fast still pays identical hours — both punches are corrected by the same skew');
equal(paid.map(p=>p.review_reason),[null,null,null],'none of the three ordinary punches is marked for review');
equal(paid.map(p=>p.status),['submitted','submitted','submitted']);
// Hours, in every row this file wrote: what the migration must never do is
// invent time — every closed shift is bounded by its own clock-in.
const bad=await read("select count(*)::int n from time_shifts where clock_out_at is not null and clock_out_at < clock_in_at");
equal(bad[0].n,0,'no shift ends before it starts');

console.log(`${checks} clock-integrity database checks passed (minimal disposable schema; real RPCs, no production writes).`);
await db.close();
