// Disposable PostgreSQL checks for 20261033000000_offline_toolbox_signing.sql:
// a toolbox talk signed with no signal, kept in the phone's outbox, and sent —
// maybe twice, maybe hours later — through sign_toolbox_talk. Minimal schema,
// the REAL clock_in gate from 20261028000000, no network, no credentials, no
// production records.
//
// What has to hold, called the way the phone calls it:
//   * the same client id twice is ONE signature (a reply lost to a dead zone);
//   * only the signer can send their signature: anonymous callers cannot run
//     the function at all, another person is refused, and so is a partner;
//   * the phone's signing time is judged: kept when it is before arrival,
//     arrival (noted) when the phone's clock ran ahead, kept (noted) when it
//     arrived more than a day late — and a late one never opens a later day's
//     clock-in;
//   * a signature made offline earlier today, sent now, opens today's
//     clock-in through the real keyed clock_in;
//   * a talk deleted since the phone kept it still files, with no talk;
//   * the migration applies twice, and rows that exist before it keep every
//     value they had.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,is_partner boolean default false,display_name text);
create table safety_talks(id uuid primary key default gen_random_uuid(),title text not null,body text not null,
  talk_date date not null default current_date,created_at timestamptz not null default now());
create table toolbox_completions(
  id uuid primary key default gen_random_uuid(),
  talk_id uuid references safety_talks(id) on delete set null,
  profile_id uuid references profiles(id) on delete cascade,
  signed_at timestamptz not null default now(),
  typed_name text,signature_path text,talk_snapshot text,pdf_path text,
  created_at timestamptz not null default now(),
  signed_by uuid references profiles(id) on delete set null,
  signed_via text not null default 'self' check (signed_via in ('self','group')));
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
create table opening_phases(id uuid primary key default gen_random_uuid(),status text,started_by uuid,paused_at timestamptz);
create function public.is_partner_user() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select coalesce((select is_partner from public.profiles where id=auth.uid()),false)$$;
grant select on profiles, safety_talks to authenticated;
grant select,insert,update,delete on time_shifts, toolbox_completions to authenticated;
grant select,insert,update on opening_phases to authenticated;
`);
async function source(file) { return readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'); }
async function original(file,name) {
  const text=await source(file); const start=text.indexOf('create or replace function '+name+'(');
  assert.ok(start>=0,name); const end=text.indexOf('$$;',text.indexOf('as $$',start));
  await db.exec(text.slice(start,end+3));
}
// The clock_in gate as production has it: the keyed overload and what it calls.
await original('20260730230000_runaway_shift_guard.sql','shift_cap_hours');
await original('20260730230000_runaway_shift_guard.sql','_close_dangling_shift');
await db.exec('grant execute on function _close_dangling_shift(uuid) to authenticated');
await original('20260921000000_injury_note.sql','clock_out');
await original('20260811010000_phase_pause.sql','start_break');
await original('20260718040000_time_clock_horizon.sql','end_break');
await original('20260970000000_job_modes.sql','clock_in');
await db.exec('set check_function_bodies = off');
await db.exec(await source('20261028000000_clock_integrity.sql'));
await db.exec('set check_function_bodies = on');

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const people={installer:1,foreman:2,partner:9,late:3,other:4};
await db.query('insert into profiles(id,role,display_name) values($1,$2,$3),($4,$5,$6),($7,$8,$9),($10,$11,$12)',
  [id(1),'installer','installer',id(2),'foreman','foreman',id(3),'installer','late',id(4),'installer','other']);
await db.query('insert into profiles(id,role,is_partner,display_name) values($1,$2,true,$3)',[id(9),'installer','partner']);
const TALK=uuid(50), GONE=uuid(51);
await db.query("insert into safety_talks(id,title,body) values($1,'Ladders','Three points of contact.')",[TALK]);

// A row that exists before the migration: a group sign-in and an old
// self-signature. Both must come through with every value they had.
await db.query("insert into toolbox_completions(id,talk_id,profile_id,signed_at,typed_name,signature_path,pdf_path,talk_snapshot) values($1,$2,$3,'2026-09-20T13:00:00Z','Old Name','p/sig.png','p/talk.pdf','{}')",[uuid(70),TALK,id(4)]);
await db.query("insert into toolbox_completions(id,talk_id,profile_id,signed_at,signed_by,signed_via) values($1,$2,$3,'2026-09-21T13:00:00Z',$4,'group')",[uuid(71),TALK,id(4),id(2)]);
const before=(await db.query('select * from toolbox_completions order by id')).rows;

let checks=0;
async function admin() { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); }
async function asUser(i) { await admin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(i)]); await db.exec('set role authenticated'); }
async function asAnon() { await admin(); await db.exec('set role anon'); }
async function read(sql,args=[]) { await admin(); return (await db.query(sql,args)).rows; }
async function row(sql,args=[]) { return (await read(sql,args))[0]; }
async function denied(fn,pattern) { await assert.rejects(fn,pattern?{message:pattern}:undefined); checks++; }
const equal=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
const ok=(v,msg)=>{assert.ok(v,msg);checks++;};
const near=(a,b,ms,msg)=>{assert.ok(Math.abs(new Date(a).getTime()-new Date(b).getTime())<=ms,`${msg}: ${a} vs ${b}`);checks++;};

// --- Apply the migration, twice (a deploy can be retried) -------------------
const migration=await source('20261033000000_offline_toolbox_signing.sql');
await db.exec(migration);
await db.exec(migration);
const after=(await read('select * from toolbox_completions order by id'));
equal(after.map(r=>({...r,client_id:undefined,phone_signed_at:undefined,signed_at_note:undefined})),before.map(r=>({...r,client_id:undefined,phone_signed_at:undefined,signed_at_note:undefined})),'rows that existed keep every value across the migration');
ok(after.every(r=>r.client_id===null&&r.phone_signed_at===null&&r.signed_at_note===null),'and carry no client id, phone time or note');

// --- Grants and shape --------------------------------------------------------
const SIG='public.sign_toolbox_talk(uuid,uuid,uuid,text,text,text,text,timestamptz)';
const shape=await row(`select p.prosecdef definer, coalesce(array_to_string(p.proconfig,','),'') config,
  has_function_privilege('anon','${SIG}','EXECUTE') anon,
  has_function_privilege('authenticated','${SIG}','EXECUTE') authed
  from pg_proc p where p.oid='${SIG}'::regprocedure`);
equal(shape.definer,true,'sign_toolbox_talk runs as its owner (it writes past row security, so it checks the caller itself)');
ok(/search_path=public, ?pg_temp/.test(shape.config),`its search_path is pinned: ${shape.config}`);
equal(shape.anon,false,'an anonymous caller cannot execute it');
equal(shape.authed,true,'a signed-in crew member can');

// --- Helpers that call the RPC the way the phone does -------------------------
const SIGN='select * from sign_toolbox_talk(p_client_id=>$1,p_profile_id=>$2,p_talk_id=>$3,p_typed_name=>$4,p_signature_path=>$5,p_pdf_path=>$6,p_talk_snapshot=>$7,p_signed_at=>$8)';
const snap=JSON.stringify({id:TALK,title:'Ladders',sections:{dos:['✓ Face the ladder'],donts:['✗ Top step']}});
function paths(person,client){ return [`${id(person)}/${TALK}/2026-09-25-${client}-signature.png`,`${id(person)}/${TALK}/2026-09-25-${client}.pdf`]; }
async function sign(caller,{client,profile=caller,talk=TALK,name='Dana Reyes',at=null,sig,pdf}) {
  const [s,p]=paths(profile,client);
  await asUser(caller);
  return (await db.query(SIGN,[client,id(profile),talk,name,sig===undefined?s:sig,pdf===undefined?p:pdf,snap,at])).rows[0];
}
const nowMs=async()=>new Date((await row('select now() t')).t).getTime();
// Earlier today on the company's clock: an hour ago, or the start of the
// America/Denver day if that is less than an hour back.
const earlierToday=(await row(`select greatest(date_trunc('day', now() at time zone 'America/Denver') at time zone 'America/Denver', now() - interval '1 hour') t`)).t;

// --- Only the signer ---------------------------------------------------------
await asAnon();
await denied(()=>db.query(SIGN,[uuid(1),id(1),TALK,'Dana',null,null,snap,null]),/permission denied/);
await denied(()=>sign(2,{client:uuid(2),profile:1}),/belongs to someone else/);
await denied(()=>sign(9,{client:uuid(3)}),/Not available for your account/);
await denied(()=>sign(1,{client:uuid(4),sig:`${id(4)}/${TALK}/x-signature.png`}),/own folder/);
await denied(()=>sign(1,{client:uuid(5),pdf:`${id(2)}/${TALK}/x.pdf`}),/own folder/);
await denied(()=>sign(1,{client:uuid(6),name:'   '}),/Type your name/);
await denied(()=>sign(1,{client:null}),/missing its id/);
equal((await row('select count(*)::int n from toolbox_completions where profile_id=$1',[id(1)])).n,0,'nothing refused left a row behind');

// --- A signature made offline earlier today, sent now ------------------------
const first=await sign(1,{client:uuid(10),at:earlierToday});
ok(first.id,'the signature files');
equal(first.client_id,uuid(10));
equal(first.profile_id,id(1));
equal(first.talk_id,TALK);
equal(first.signed_via,'self');
equal(first.signed_by,null,'signed by the person themselves');
equal(first.typed_name,'Dana Reyes');
equal(first.signature_path,paths(1,uuid(10))[0]);
equal(first.pdf_path,paths(1,uuid(10))[1]);
equal(first.talk_snapshot,snap,'the talk exactly as it was signed, check marks and all');
equal(new Date(first.signed_at).toISOString(),new Date(earlierToday).toISOString(),'signed_at is when the phone says it was signed, not when it arrived');
equal(new Date(first.phone_signed_at).toISOString(),new Date(earlierToday).toISOString(),'and the phone\'s own claim is kept');
equal(first.signed_at_note,null,'a time inside the window needs no note');

// The same client id again — a resend after a lost reply, even with other words.
const again=await sign(1,{client:uuid(10),name:'Somebody Else',at:new Date().toISOString()});
equal(again.id,first.id,'a repeat of the client id answers with the signature it already made');
equal(again.typed_name,'Dana Reyes','and changes nothing on it');
equal(new Date(again.signed_at).toISOString(),new Date(earlierToday).toISOString());
equal((await row('select count(*)::int n from toolbox_completions where profile_id=$1 and client_id=$2',[id(1),uuid(10)])).n,1,'one row for the client id, not two');
await denied(()=>db.query("insert into toolbox_completions(profile_id,client_id,signed_at) values($1,$2,now())",[id(1),uuid(10)]),/duplicate key|unique/);

// The same client id from ANOTHER person is a different signature: ids are per signer.
const foremanSame=await sign(2,{client:uuid(10),name:'Foreman Fox'});
ok(foremanSame.id!==first.id,'the same client id from another signer is their own signature');

// --- Today's clock-in opens on it, through the real keyed clock_in -------------
const KEYED_IN='select * from clock_in(p_project_id=>$1,p_cost_code_id=>$2,p_photo=>null,p_lat=>null,p_lng=>null,p_note=>null,p_mode=>$3,p_client_id=>$4,p_tapped_at=>null,p_clock_checked_at=>null,p_clock_skew_ms=>null)';
await asUser(1);
const shift=(await db.query(KEYED_IN,[uuid(90),uuid(91),'data',uuid(20)])).rows[0];
ok(shift.id,'a clock-in after the signature passes the toolbox gate');
equal((await row("select (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date today from toolbox_completions where id=$1",[first.id])).today,true,'the offline signature is on today\'s company day');

// --- The sign-time rule ------------------------------------------------------
// Ahead of arrival by more than two minutes: the phone's clock is fast.
const aheadClaim=new Date((await nowMs())+60*60_000).toISOString();
const ahead=await sign(1,{client:uuid(11),at:aheadClaim});
near(ahead.signed_at,await nowMs(),5_000,'a phone time an hour in the future files at arrival');
equal(ahead.signed_at_note,'phone_clock_ahead','and says why');
equal(new Date(ahead.phone_signed_at).toISOString(),aheadClaim,'keeping what the phone claimed');
// Ahead by less than the drift allowance: clamped to arrival, no note.
const drift=await sign(1,{client:uuid(12),at:new Date((await nowMs())+60_000).toISOString()});
ok(new Date(drift.signed_at).getTime()<=await nowMs(),'a phone a minute fast is clamped to arrival — a signature never carries a time after it arrived');
equal(drift.signed_at_note,null,'ordinary clock drift needs no note');
// No time at all: signing now.
const bare=await sign(1,{client:uuid(13),at:null});
near(bare.signed_at,await nowMs(),5_000,'no phone time means signed now');
equal(bare.signed_at_note,null);

// More than a day late: kept for the day it was signed, noted.
const lateClaim=new Date((await nowMs())-3*24*3600_000).toISOString();
const late=await sign(3,{client:uuid(14),at:lateClaim});
equal(new Date(late.signed_at).toISOString(),lateClaim,'a signature that arrives three days late keeps its own day');
equal(late.signed_at_note,'arrived_late','and says it came in late');
await asUser(3);
await denied(()=>db.query(KEYED_IN,[uuid(90),uuid(91),'data',uuid(21)]),/complete today's toolbox talk/);
equal((await row('select count(*)::int n from time_shifts where profile_id=$1',[id(3)])).n,0,'a late signature never opens a LATER day\'s clock-in');
await sign(3,{client:uuid(15),at:new Date().toISOString()});
await asUser(3);
ok((await db.query(KEYED_IN,[uuid(90),uuid(91),'data',uuid(21)])).rows[0].id,'today\'s own signature does');

// --- A talk deleted since the phone kept it ----------------------------------
const orphan=await sign(4,{client:uuid(16),talk:GONE});
ok(orphan.id,'a signature of a talk that no longer exists still files');
equal(orphan.talk_id,null,'with no talk');
equal(orphan.talk_snapshot,snap,'and the snapshot of what was signed');

// --- The note is a closed list -----------------------------------------------
await denied(()=>db.query("update toolbox_completions set signed_at_note='whatever' where id=$1",[orphan.id]),/check constraint|violates/);

console.log(`${checks} offline toolbox signing database checks passed (minimal disposable schema; real RPCs, no production writes).`);
