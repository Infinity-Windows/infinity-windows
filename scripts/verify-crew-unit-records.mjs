// Disposable SQL checks. No network or production database connection.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(
  process.env.PGLITE_MODULE ?? "@electric-sql/pglite"
);
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean default true,partner boolean default false);
create table projects(id uuid primary key,deleted_at timestamptz);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
create function is_partner_user() returns boolean language sql security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql as $$select false$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
grant select on profiles,projects to authenticated;
`);
await db.exec(
  await readFile(
    new URL(
      "../supabase/migrations/20261011000000_custom_work.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
await db.exec(
  "create trigger unit_sessions_follow_shift after update on time_shifts for each row execute function unit_sessions_follow_shift()",
);
await db.exec(`alter table project_openings add column opening_code text;
alter table profiles add column is_partner boolean generated always as (partner) stored;
create table app_release_notes(id text,published_on date,audience int[],kind text,title_en text,title_es text,body_en text,body_es text,href text);`);
await db.exec(await readFile(new URL('../supabase/migrations/20261023000000_foreman_crew_unit_records.sql', import.meta.url),'utf8'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.query(`insert into profiles(id,role,active,partner) values ($1,'foreman',true,false),($2,'installer',true,false),($3,'installer',true,false),($4,'owner',true,true),($5,'foreman',false,false),($6,'supervisor',true,false),($7,'owner',true,false)`,[1,2,3,4,5,6,7].map(id));
await db.query('insert into projects values ($1,null),($2,null)',[id(10),id(11)]);
await db.query("insert into project_openings(id,project_id,opening_code) values ($1,$2,'MAP-7')",[id(20),id(10)]);
let n=100, checks=0;
async function asUser(i){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[i ? id(i) : '']);await db.exec('set role authenticated');}
async function record(data,key=id(n++)){return (await db.query('select record_crew_work($1,$2) id',[key,data])).rows[0].id;}
async function denied(fn){await assert.rejects(fn);checks++;}
const unit={id:id(40),revision:0,project_id:id(10),opening_id:null,label:'16',type_label:'Bifold door',facts:{material:'Aluminum'}};
const payload={unit,people:[id(2),id(3)],work_date:'2026-09-18',stage:'Installing',outcome:'finished',description:'Installed together Friday'};
for(const actor of [2,4,5,null]){await asUser(actor);await denied(()=>record(payload));
await denied(()=>record({...payload,unit:{...unit,revision:1},stage:'Flashing',whole_complete:true}));}
await asUser(1);
assert.equal(await record(payload,id(500)),id(40));checks++;
assert.equal(await record(payload,id(500)),id(40));checks++;
assert.equal((await db.query('select * from crew_work_records')).rows.length,1);checks++;
assert.equal((await db.query('select * from crew_work_record_people')).rows.length,2);checks++;
await denied(()=>record({...payload,description:'changed retry'},id(500)));
await denied(()=>db.exec("update crew_work_records set outcome='assigned'"));
await denied(()=>db.exec('delete from crew_work_record_people'));
// Calling the old RPC with this receipt cannot replay or overwrite the new action.
await denied(()=>db.query("select custom_work_command($1,'unit',$2)",[id(500),unit]));
await denied(()=>record({...payload,unit:{...unit,id:id(41)}}));
await denied(()=>record({...payload,unit:{...unit,id:id(41),label:'map-7'}}));
for(const patch of [{people:[]},{people:[id(5)]},{people:[id(4)]},{people:[null]},{work_date:'2099-01-01'},{work_date:'invalid'},{stage:'QC approved'},{outcome:'approved'}]) await denied(()=>record({...payload,...patch,unit:{...unit,id:id(41),label:'17'}}));
assert.equal((await db.query('select * from custom_work_units')).rows.length,1);checks++;
// Existing unit uses revision protection; mapped units keep their original identity.
await denied(()=>record(payload));
await denied(()=>record({...payload,unit:{...unit,revision:1},stage:'Flashing',whole_complete:true}));
assert.equal(await record({...payload,unit:{...unit,revision:1},stage:'Hardware',outcome:'partial'}),id(40));checks++;
assert.equal(await record({...payload,unit:{...unit,id:id(41),label:'MAP-7',opening_id:id(20)},work_date:'2099-01-01',outcome:'assigned'}),id(41));checks++;
await denied(()=>record({...payload,unit:{...unit,id:id(42),label:'different name',opening_id:id(20)}}));
await denied(()=>record({...payload,unit:{...unit,revision:2,project_id:id(11)}}));
for(const actor of [6,7]){await asUser(actor);assert.equal(await record({...payload,unit:{...unit,id:id(actor+50),label:`Crew-${actor}`}}),id(actor+50));checks++;}
// Installers can read work attribution but cannot write it; partner/inactive cannot read either table.
await asUser(2);assert.equal((await db.query('select * from crew_work_records')).rows.length,5);checks++;
for(const actor of [4,5,null]){await asUser(actor);for(const table of ['crew_work_records','crew_work_record_people']){assert.equal((await db.query(`select * from ${table}`)).rows.length,0);checks++;}}
await db.exec('reset role');
for(const table of ['time_shifts','unit_sessions','custom_work_sessions']){assert.equal((await db.query(`select * from ${table}`)).rows.length,0);checks++;}
assert.equal((await db.query('select status from project_openings')).rows[0].status,'planned');checks++;
assert.equal((await db.query('select facts from custom_work_units where id=$1',[id(40)])).rows[0].facts.installation_complete,undefined);checks++;
assert.equal((await db.query('select untimed_work_present from custom_work_units where id=$1',[id(40)])).rows[0].untimed_work_present,true);checks++;
await asUser(1);
await record({...payload,unit:{...unit,revision:2},whole_complete:true});
await db.exec('reset role');
assert.equal((await db.query('select facts from custom_work_units where id=$1',[id(40)])).rows[0].facts.installation_complete,'Yes');checks++;
await db.query('update projects set deleted_at=now() where id=$1',[id(10)]);
await asUser(1);assert.equal((await db.query('select * from crew_work_records')).rows.length,0);checks++;
await denied(()=>record({...payload,unit:{...unit,id:id(99),label:'deleted job'}}));
await db.close();
console.log(`${checks} crew-record SQL assertions passed against both actual custom-work migrations. Existing auth and sandbox helper fixtures remain stubs; no production writes.`);
