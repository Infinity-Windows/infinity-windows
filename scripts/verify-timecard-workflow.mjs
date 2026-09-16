// Disposable PostgreSQL checks. Uses a minimal schema and real timecard RPCs;
// no network, credentials, production records, or real notifications.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,partner boolean default false);
create table time_shifts(id uuid primary key default gen_random_uuid(),profile_id uuid references profiles,project_id uuid,cost_code_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_seconds int default 0,status text,note text,edited_note text,edited_by uuid,edited_at timestamptz,edited_after_signing boolean default false,approved_by uuid,approved_at timestamptz,rejected_by uuid,rejected_at timestamptz,reject_reason text,signed_at timestamptz,break_started_at timestamptz,break_type text,injured boolean,time_confirmed boolean);
create table time_shift_edits(id uuid default gen_random_uuid(),shift_id uuid,edited_by uuid,field text,old_value text,new_value text,reason text);
create table timecard_periods(profile_id uuid,period_start timestamptz,employee_signed_at timestamptz);
create function is_partner_user() returns boolean language sql security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
grant select on profiles to authenticated;
grant select,insert,update,delete on time_shifts to authenticated;
`);
async function source(file) { return readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'); }
async function original(file,name) {
  const text=await source(file); const start=text.indexOf('create or replace function '+name+'(');
  assert.ok(start>=0,name); const end=text.indexOf('$$;',text.indexOf('as $$',start));
  await db.exec(text.slice(start,end+3));
}
await original('20260718050000_time_timecard.sql','_is_lead');
await original('20260810000000_team_timecards.sql','_is_supervisor');
await original('20260718050000_time_timecard.sql','lead_add_shift');
await original('20260718050000_time_timecard.sql','reject_shift');
await original('20260730230000_runaway_shift_guard.sql','finish_shift_at');
const migration=await source('20261012000000_timecard_descriptions_and_weekly_approval.sql');
await db.exec(migration);
await db.exec(migration); // replay is safe and never changes stored time
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const roles=['installer','foreman','foreman','supervisor','owner','admin','lead','big_boss','owner'];
for (let i=0;i<roles.length;i++) await db.query('insert into profiles values($1,$2,$3)',[id(i+1),roles[i],i===8]);
let checks=0,n=100;
async function admin() { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); }
async function asUser(i) { await admin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(i)]); await db.exec('set role authenticated'); }
async function read(sql,args=[]) { await admin(); return (await db.query(sql,args)).rows; }
async function denied(fn) { await assert.rejects(fn); checks++; }
const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
async function seed(person=2,over={}) {
  await admin(); const row={id:id(n++),profile_id:id(person),project_id:id(90),cost_code_id:id(91),clock_in_at:'2026-09-14T14:00:13Z',clock_out_at:'2026-09-14T22:00:41Z',break_seconds:31,status:'submitted',note:'Clock-in context',...over};
  const keys=Object.keys(row);
  await db.query(`insert into time_shifts(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
  return row.id;
}
async function edit(shift,description='Installed frames\nWaiting for glass',reason='Added job details') {
  return (await db.query('select * from edit_shift_with_description($1,p_note=>$2,p_description=>$3)',[shift,reason,description])).rows[0];
}
const editAllowed=(actor,target)=>actor!==9 && (actor>=4&&actor!==7 || actor!==1&&(actor===target||target===1));
const approveAllowed=(actor,target)=>actor!==9 && (actor>=4&&actor!==7 || actor!==1&&[1,2,3,7].includes(target));
for(const actor of [1,2,4,5,6,7,8,9]) for(const target of [1,2,3,4,5,6,7,8]) {
  await asUser(actor);
  const permissions=(await db.query('select can_edit_timecard($1) edit, can_approve_timecard($1) approve',[id(target)])).rows[0];
  equal(permissions,{edit:editAllowed(actor,target),approve:approveAllowed(actor,target)});
}
const s=await seed(); await asUser(2);
let saved=await edit(s); equal(saved.note,'Installed frames\nWaiting for glass'); equal(saved.edited_note,'Added job details'); equal(saved.break_seconds,31);
equal(new Date(saved.clock_in_at).toISOString(),'2026-09-14T14:00:13.000Z');
await denied(()=>edit(s,'Lost note','  '));
await denied(()=>edit(s,'x'.repeat(4001)));
saved=await edit(s,'   '); equal(saved.note,null);
equal((await read('select field from time_shift_edits where shift_id=$1',[s])).map(r=>r.field),['note','note']);
const installer=await seed(1); await asUser(2); await edit(installer); checks++;
const supervisor=await seed(4); await asUser(2); await denied(()=>edit(supervisor));
await denied(()=>db.query('select lead_edit_shift($1,p_note=>$2)',[supervisor,'Bypass attempt']));
await denied(()=>db.query('update time_shifts set note=$2 where id=$1',[supervisor,'Direct bypass']));
await denied(()=>db.query('select lead_add_shift($1,$2,$3,$4)',[id(4),id(90),id(91),'2026-09-14T14:00:00Z']));
const unfinished=await seed(4,{status:'needs_finish',clock_out_at:null}); await asUser(2);
await denied(()=>db.query('select finish_shift_at($1,$2)',[unfinished,'2026-09-14T22:00:00Z']));
const peer=await seed(3); await asUser(2); await denied(()=>edit(peer));
await asUser(4); await edit(supervisor); checks++;
await asUser(1); await denied(()=>edit(installer));
await asUser(9); await denied(()=>edit(supervisor));
await db.exec('reset role; set role anon'); await denied(()=>edit(s));
await admin(); await db.exec('truncate time_shifts,time_shift_edits,timecard_periods');
const start='2026-09-14T06:00:00Z',end='2026-09-21T06:00:00Z';
async function snapshot(person=2) { return read("select id,project_id,cost_code_id,clock_in_at,clock_out_at,break_seconds,note,edited_at from time_shifts where profile_id=$1 and clock_in_at >= $2 and clock_in_at < $3 and status<>'voided' order by id",[id(person),start,end]); }
async function approve(actor,person,expected,until=end) {
  await asUser(actor); return (await db.query('select approve_timecard_week($1,$2,$3,$4) n',[id(person),start,until,JSON.stringify(expected)])).rows[0].n;
}
const a=await seed(),b=await seed(2,{project_id:id(92),clock_in_at:'2026-09-15T14:00:00Z',clock_out_at:'2026-09-15T22:00:00Z'});
const before=await seed(2,{clock_in_at:'2026-09-14T05:59:59Z'}),after=await seed(2,{clock_in_at:end});
const other=await seed(1),voided=await seed(2,{status:'voided'});
let expected=await snapshot(); equal(await approve(2,2,expected),2);
let rows=await read('select id,status,approved_by,approved_at from time_shifts order by id');
equal(rows.filter(r=>[a,b].includes(r.id)).every(r=>r.status==='approved'&&r.approved_by===id(2)),true);
equal(rows.filter(r=>[before,after,other].includes(r.id)).every(r=>r.status==='submitted'),true);
equal(rows.find(r=>r.id===voided).status,'voided');
equal(await approve(4,2,expected),0);
equal(await read('select id,status,approved_by,approved_at from time_shifts order by id'),rows);
await asUser(2); await denied(()=>db.query('select approve_shift($1)',[a]));
await denied(()=>db.query("update time_shifts set status='approved',approved_by=$2 where id=$1",[other,id(2)]));
// A description alone preserves approved hours; a changed time needs review.
await edit(a,'Additional details');
equal((await read('select status from time_shifts where id=$1',[a]))[0].status,'approved');
await asUser(2); await db.query('select edit_shift($1,p_break_seconds=>60,p_note=>$2)',[a,'Corrected break']);
equal((await read('select status,approved_by from time_shifts where id=$1',[a]))[0],{status:'submitted',approved_by:null});
await denied(()=>approve(2,2,expected)); // stale values
expected=await snapshot(); equal(await approve(2,2,expected),1);
await denied(()=>approve(2,2,expected,'2026-09-28T06:00:00Z'));
await denied(()=>approve(2,2,[expected[0],expected[0]]));
await denied(()=>approve(2,2,null));
for(const status of ['open','needs_finish','rejected']) {
  const bad=await seed(2,{status,clock_out_at:status==='rejected'?'2026-09-14T22:00:00Z':null});
  expected=await snapshot(); await denied(()=>approve(2,2,expected)); await admin(); await db.query('delete from time_shifts where id=$1',[bad]);
}
expected=await snapshot(); await seed(); await denied(()=>approve(2,2,expected));
const sup=await seed(4); expected=await snapshot(4); await denied(()=>approve(2,4,expected)); equal(await approve(4,4,expected),1);
await seed(3); expected=await snapshot(3); equal(await approve(2,3,expected),1);
await asUser(2); await denied(()=>db.query('select reject_shift($1)',[sup]));
const rejected=await seed(1,{status:'rejected'}); await asUser(2); saved=await edit(rejected,'Corrected details','Reviewed correction'); equal(saved.status,'submitted');
await admin(); await db.query('insert into timecard_periods values($1,$2,now())',[id(2),start]);
await asUser(2); saved=await edit(a,'Signed-period detail'); equal(saved.edited_after_signing,true);
console.log(`${checks} timecard database checks passed (minimal disposable schema; real RPCs, no production writes).`);
await db.close();
