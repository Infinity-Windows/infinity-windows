// Execute the actual new snapshot function on populated disposable SQL
// fixtures. Permission helpers are fixture substitutes; the candidate-bound
// real-schema rollback probe remains a separate release gate.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
await db.exec(`
create role authenticated; create role anon; create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
create table profiles(id uuid primary key, display_name text, role text, active boolean default true, partner boolean default false, test boolean default false);
create table projects(id uuid primary key, job_code text, name text, deleted boolean default false, sandbox boolean default false, is_test boolean default false, service_access boolean default true);
create function custom_work_internal() returns boolean language sql stable as $$ select coalesce((select active and not partner from profiles where id=auth.uid()),false) $$;
create function _is_supervisor(uid uuid) returns boolean language sql stable as $$ select coalesce((select role in ('supervisor','owner') from profiles where id=uid),false) $$;
create function _ai_job_visible(j uuid,u uuid) returns boolean language sql stable as $$ select exists(select 1 from projects p join profiles pr on pr.id=u where p.id=j and not p.deleted and (case when pr.test then p.sandbox else not p.is_test or _is_supervisor(u) end)) $$;
create function service_job_access(j uuid) returns boolean language sql stable as $$ select exists(select 1 from projects where id=j and service_access and not deleted) $$;
create table time_shifts(id uuid primary key, profile_id uuid, project_id uuid, clock_in_at timestamptz, clock_out_at timestamptz, break_seconds integer default 0, break_started_at timestamptz, status text, review_reason text);
create table project_openings(id uuid primary key, project_id uuid, removed_at timestamptz, opening_code text, status text);
create table custom_work_units(id uuid primary key, project_id uuid, opening_id uuid, label text, facts jsonb default '{}', untimed_work_present boolean default false);
create table custom_work_sessions(id uuid primary key, revision integer default 1, profile_id uuid, project_id uuid, shift_id uuid, unit_id uuid, kind text, stage text, description text default '', started_at timestamptz, ended_at timestamptz, review_required boolean default false, shift_status text default 'open', outcome text);
create table unit_sessions(id uuid primary key, profile_id uuid, opening_id uuid, role text, started_at timestamptz, ended_at timestamptz, end_reason text, is_rework boolean default false);
create table task_sessions(id uuid primary key, profile_id uuid, project_id uuid, opening_id uuid, state text, started_at timestamptz, ended_at timestamptz);
create table service_visits(id uuid primary key, project_id uuid);
create table service_visit_units(id uuid primary key, visit_id uuid, project_id uuid, opening_id uuid, work_unit_id uuid);
create table service_time_sessions(id uuid primary key, profile_id uuid, project_id uuid, shift_id uuid, unit_id uuid, visit_id uuid, kind text, stage text, description text default '', started_at timestamptz, ended_at timestamptz, review_required boolean default false);
create table opening_phases(id uuid primary key, started_by uuid, opening_id uuid, kind text, started_at timestamptz, minutes integer);
create table install_events(id uuid primary key, installer_id uuid, project_opening_id uuid, started_at timestamptz, created_at timestamptz, minutes integer);
create table crew_work_records(id uuid primary key, project_id uuid, unit_id uuid, stage text, work_date date, outcome text);
create table crew_work_record_people(record_id uuid, profile_id uuid, voided_at timestamptz);
insert into profiles(id,display_name,role,test) values
('${id(1)}','Supervisor','supervisor',true),('${id(2)}','Owner','owner',false),('${id(3)}','Installer','installer',true),('${id(4)}','Foreman','foreman',true);
insert into projects(id,job_code,name,sandbox,is_test,deleted) values
('${id(10)}','TEST','Fixture job',true,true,false),('${id(11)}','HIDDEN','Hidden fixture',false,true,true),('${id(12)}','VISIBLE','Other visible job',false,false,false);
insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status) values
('${id(20)}','${id(3)}','${id(10)}','2026-10-02 08:00Z','2026-10-02 12:00Z','approved');
insert into project_openings(id,project_id,opening_code,status) values
('${id(30)}','${id(10)}','W1','assigned'),('${id(31)}','${id(11)}','Private','assigned');
insert into custom_work_units(id,project_id,label,facts) values
('${id(40)}','${id(10)}','U1','{}'),('${id(41)}','${id(11)}','Private unit','{}');
insert into custom_work_units(id,project_id,opening_id,label,facts) values
('${id(42)}','${id(10)}','${id(31)}','Hidden mapped unit','{}'),
('${id(43)}','${id(10)}','${id(30)}','Mapped W1','{"width_in":"48","height_in":"72","story":"1"}');
insert into custom_work_sessions(id,profile_id,project_id,shift_id,unit_id,kind,stage,started_at,ended_at) values
('${id(50)}','${id(3)}','${id(10)}','${id(20)}','${id(40)}','unit','Frame','2026-10-02 08:00Z','2026-10-02 09:00Z'),
('${id(51)}','${id(3)}','${id(11)}','${id(20)}','${id(40)}','unit','Hidden original job','2026-10-02 09:00Z','2026-10-02 10:00Z'),
('${id(52)}','${id(3)}','${id(10)}','${id(20)}','${id(41)}','unit','Hidden current unit','2026-10-02 09:00Z','2026-10-02 10:00Z'),
('${id(53)}','${id(3)}','${id(10)}','${id(20)}','${id(42)}','unit','Hidden mapped opening','2026-10-02 09:00Z','2026-10-02 10:00Z'),
('${id(54)}','${id(4)}','${id(10)}','${id(20)}','${id(40)}','unit','Wrong person','2026-10-02 09:00Z','2026-10-02 10:00Z'),
('${id(55)}','${id(3)}','${id(10)}','${id(20)}','${id(43)}','unit','Mapped','2026-10-02 10:00Z',null);
insert into unit_sessions(id,profile_id,opening_id,role,started_at,ended_at) values
('${id(60)}','${id(3)}','${id(30)}','install','2026-09-01 08:00Z','2026-09-01 09:00Z'),
('${id(61)}','${id(3)}','${id(30)}','helper','2026-10-02 09:00Z','2026-10-02 10:00Z');
insert into crew_work_records values
('${id(70)}','${id(10)}','${id(40)}','Frame','2026-10-02','assigned'),
('${id(71)}','${id(10)}','${id(42)}','Frame','2026-10-02','finished'),
('${id(72)}','${id(10)}','${id(40)}','Frame','2026-10-02','partial');
insert into crew_work_record_people values ('${id(70)}','${id(3)}',null),('${id(71)}','${id(3)}',null),('${id(72)}','${id(3)}',null);
insert into service_visits values ('${id(80)}','${id(10)}'),('${id(81)}','${id(11)}');
insert into service_visit_units values ('${id(82)}','${id(80)}','${id(10)}',null,'${id(42)}');
insert into service_time_sessions(id,profile_id,project_id,shift_id,unit_id,visit_id,kind,stage,started_at,ended_at) values
('${id(83)}','${id(3)}','${id(10)}','${id(20)}','${id(82)}','${id(80)}','unit','Hidden mapped service','2026-10-02 09:00Z','2026-10-02 10:00Z'),
('${id(84)}','${id(3)}','${id(10)}','${id(20)}',null,'${id(81)}','idle','Hidden visit','2026-10-02 09:00Z','2026-10-02 10:00Z');
`);
await db.exec(readFileSync(new URL('../supabase/migrations/20261107000000_work_data_snapshot.sql', import.meta.url), 'utf8'));
const act = async n => db.exec(`select set_config('test.uid','${n ? id(n) : ''}',false)`);
const snap = async (project = 10) => (await db.query(`select work_data_snapshot('${id(project)}','2026-10-01Z','2026-10-04Z') as data`)).rows[0].data;
const denied = async (fn, regex) => { await assert.rejects(fn, regex); checks++; };
for (const n of [0,3,4]) { await act(n); await denied(snap, /supervisor or owner/); }
await act(1);
let data = await snap();
check(data.shifts.length === 1, 'selected authoritative shift');
check(data.claims.length === 3, 'only visible same-person source chains');
for (const n of [51,52,53,54,60,70,71,83,84,31,41,42]) check(!JSON.stringify(data).includes(id(n)), `hidden/unrelated source ${n} absent from all payload fields`);
check(data.claims.find(c => c.sourceId.endsWith(id(55))).pending === false, 'server-confirmed running is not locally pending');
check(data.claims.every(c => typeof c.rework === 'boolean' && typeof c.unresolved === 'boolean'), 'nullable predicates normalized');
check(data.units.find(u => u.id.endsWith(id(40))).complete === false, 'missing completion fact returns false');
check(data.units.find(u => u.id.endsWith(id(30))).widthIn === 48, 'mapped unit facts preserved');
check(data.untimed.length === 1 && data.untimed[0].sourceId.includes(id(72)), 'only performed visible retrospective evidence');
await denied(() => snap(11), /unavailable/);
await db.exec(`update profiles set partner=true where id='${id(1)}'`);
await denied(snap, /supervisor or owner/);
await db.exec(`update profiles set partner=false where id='${id(1)}'`);
await act(2);
await db.exec(`insert into custom_work_sessions(id,profile_id,project_id,shift_id,kind,stage,started_at,ended_at) values
('${id(56)}','${id(3)}','${id(12)}','${id(20)}','idle','Visible mismatch','2026-10-02 09:00Z','2026-10-02 10:00Z')`);
data = await snap();
check(data.claims.find(c => c.sourceId.endsWith(id(56))).unresolved === true, 'authorized project mismatch retained as an exception');
await denied(() => db.query(`select work_data_snapshot('${id(10)}','2026-10-04Z','2026-10-01Z')`), /window/);
await denied(() => db.query(`select work_data_snapshot('${id(10)}','2026-01-01Z','2026-10-01Z')`), /window/);
await denied(() => db.query(`select work_data_snapshot(null,'2026-10-01Z','2026-10-04Z')`), /required/);
const before = (await db.query('select count(*)::int as n from time_shifts')).rows[0].n;
await snap();
check((await db.query('select count(*)::int as n from time_shifts')).rows[0].n === before, 'read leaves payroll records unchanged');
await db.close();
console.log(`${checks} Work Data SQL fixture checks passed. Real-schema rollback probe remains required.`);
