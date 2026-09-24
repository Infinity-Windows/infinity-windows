// Disposable SQL checks for Forge AI field operations. No network, no production
// database. Loads the real custom-work, crew-record and AI field migrations over
// stubs of the platform (auth, storage, sandbox fence, clock RPCs).
//   node scripts/verify-ai-field-operations.mjs [--pglite=/path/to/pglite/dist/index.js]
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const arg = process.argv.find((a) => a.startsWith("--pglite="));
const { PGlite } = await import(arg?.slice(9) ?? process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
// Print the database's own message, not PGlite's bundled source.
process.on("uncaughtException", (e) => { console.error("FAILED after [" + globalThis.lastCheck + "]:", e.message, e.where ?? "", e.actual !== undefined ? JSON.stringify({ actual: e.actual, expected: e.expected }) : ""); process.exit(1); });
const db = new PGlite();
const migration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean default true,partner boolean default false,display_name text,retired_at timestamptz,access_revoked_at timestamptz,is_test boolean default false);
create table projects(id uuid primary key,deleted_at timestamptz,name text,job_code text,address text,is_test boolean default false,allowed_modes text[] default '{data}',created_at timestamptz default now());
create table project_pipeline(project_id uuid primary key references projects on delete cascade,ready_state text not null default 'ready',updated_at timestamptz,updated_by uuid);
create table window_types(id uuid primary key,name text,width_in numeric,height_in numeric);
create table project_mark_specs(project_id uuid,mark_code text,style text,operation text,width_in int,height_in int);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz,opening_code text,label text,window_type_id uuid,assigned_to uuid,assigned_by uuid,assigned_at timestamptz);
create table opening_assignment_events(opening_id uuid,from_profile uuid,to_profile uuid,changed_by uuid,via text);
create function log_assignment() returns trigger language plpgsql security definer as $$begin if new.assigned_to is distinct from old.assigned_to then insert into opening_assignment_events values(new.id,old.assigned_to,new.assigned_to,auth.uid(),case when new.assigned_to is null then 'unassign' else coalesce(nullif(current_setting('app.assignment_via',true),''),'dispatch') end); end if; return new; end$$;
create trigger log_assignment after update of assigned_to on project_openings for each row execute function log_assignment();
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid,opening_id uuid,started_at timestamptz default now(),ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid references profiles on delete cascade,opening_id uuid,state text default 'on_task',started_at timestamptz default now(),ended_at timestamptz);
create table opening_phases(id uuid primary key default gen_random_uuid(),opening_id uuid,started_by uuid,status text,paused_at timestamptz);
create table project_messages(id uuid primary key default gen_random_uuid(),project_id uuid,author_id uuid,body text,mentions uuid[]);
create table service_job_supervisors(project_id uuid,profile_id uuid);
create table sandbox_projects(project_id uuid primary key);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,owner uuid default auth.uid(),created_at timestamptz default now(),primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to authenticated;
create function is_partner_user() returns boolean language sql stable security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql stable as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer as $$select exists(select 1 from profiles where id=p and role in ('supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer as $$select coalesce((select is_test from profiles where id=p),false)$$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer as $$select p is not null and exists(select 1 from sandbox_projects where project_id=p)$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
-- Same semantics as guard_test_account_sandbox_only for project_id tables and projects.id.
create function guard_stub() returns trigger language plpgsql security definer as $$
declare pid uuid; begin
  if auth.uid() is null or not is_test_profile(auth.uid()) then return coalesce(new,old); end if;
  pid := case when tg_table_name='projects' then (to_jsonb(coalesce(new,old))->>'id')::uuid else (to_jsonb(coalesce(new,old))->>'project_id')::uuid end;
  if not is_sandbox_project(pid) then raise exception 'This is a test login. It can only change the automation sandbox job, not a real one.' using errcode='42501'; end if;
  return coalesce(new,old); end $$;
create function attach_sandbox_guards() returns void language plpgsql as $$
declare t text; begin
  for t in select table_name::text from information_schema.columns c join information_schema.tables x using(table_schema,table_name)
    where c.table_schema='public' and c.column_name='project_id' and x.table_type='BASE TABLE' and table_name<>'sandbox_projects' union select 'projects' loop
    execute format('drop trigger if exists zz_sandbox on public.%I', t);
    execute format('create trigger zz_sandbox before insert or update or delete on public.%I for each row execute function guard_stub()', t);
  end loop; end $$;
-- The real end_break closes the break into break_seconds.
create function end_break(p uuid) returns time_shifts language sql security definer as $$
  update time_shifts set break_seconds=coalesce(break_seconds,0)+extract(epoch from now()-break_started_at)::int,break_started_at=null where id=p returning *$$;
grant select on profiles,projects to authenticated;
`);
await db.exec(await migration("20261011000000_custom_work.sql"));
await db.exec("create trigger unit_sessions_follow_shift after update on time_shifts for each row execute function unit_sessions_follow_shift()");
await db.exec(`alter table profiles add column is_partner boolean generated always as (partner) stored;
create table app_release_notes(id text primary key,published_on date,audience int[],kind text,title_en text,title_es text,body_en text,body_es text,href text);
create table ai_spend_limits(id int primary key,min_role text not null default 'foreman',monthly_cap_cents int default 15000,per_user_daily_calls int default 40,enforced boolean default true,updated_at timestamptz);
insert into ai_spend_limits(id) values(1);`);
await db.exec(await migration("20261023000000_foreman_crew_unit_records.sql"));
await db.exec(await migration("20261024000000_ai_field_operations.sql"));
await db.exec(await migration("20261024010000_installer_ai_floor.sql"));
await db.exec(await migration("20261024020000_ai_field_operations_note.sql"));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const F = 1, A = 2, B = 3, P = 4, OFF = 5, S = 6, O = 7, T = 8, R = 9, X = 10, C = 11;
const people = [[F,'foreman','Frank'],[A,'installer','Ana'],[B,'installer','Ben'],[P,'owner','Partner'],[OFF,'foreman','Olga'],[S,'supervisor','Sam'],[O,'owner','Owen'],[T,'installer','Test bot'],[R,'installer','Retired Rae'],[X,'installer','Revoked Rex'],[C,'installer','Cal']];
for (const [n, role, name] of people) await db.query("insert into profiles(id,role,display_name) values($1,$2,$3)", [id(n), role, name]);
await db.query("update profiles set partner=true where id=$1", [id(P)]);
await db.query("update profiles set active=false where id=$1", [id(OFF)]); // Off today, login current
await db.query("update profiles set active=false where id=$1", [id(C)]);
await db.query("update profiles set is_test=true where id=$1", [id(T)]);
await db.query("update profiles set retired_at=now(),active=false where id=$1", [id(R)]);
await db.query("update profiles set access_revoked_at=now() where id=$1", [id(X)]);
const JOB = id(100), LODGE = id(101), SANDBOX = id(102), GONE = id(103), TESTJOB = id(104);
await db.query(`insert into projects(id,name,job_code,address,deleted_at,is_test) values
 ($1,'Smith Residence','SMITH','12 Oak St',null,false),($2,'Canyon Lodge','LODGE','4 Canyon Rd',null,false),
 ($3,'Automation sandbox','SANDBOX','Nowhere',null,true),($4,'Deleted Job','DEL','1 Gone Way',now(),false),($5,'Office test job','TEST','Lab',null,true)`, [JOB, LODGE, SANDBOX, GONE, TESTJOB]);
await db.query("insert into sandbox_projects values($1)", [SANDBOX]);
const WT = id(300);
await db.query("insert into window_types values($1,'Slider 60x48',60,48)", [WT]);
const MAP7 = id(200), MAP8 = id(201), MAP9 = id(202), MAP10 = id(204);
await db.query(`insert into project_openings(id,project_id,opening_code,label,window_type_id,assigned_to) values
 ($1,$4,'MAP-7','Kitchen north',null,$5),($2,$4,'MAP-8','Bedroom',$6,null),($3,$4,'MAP-9',null,null,null),($7,$4,'MAP-10','Porch',$6,null)`, [MAP7, MAP8, MAP9, JOB, id(B), WT, MAP10]);
await db.query("insert into project_mark_specs values($1,'MAP-9','Thermal break aluminum fixed','Fixed',36,72)", [JOB]);

let checks = 0, seq = 1000;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; globalThis.lastCheck = msg; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; globalThis.lastCheck = msg; };
async function asUser(n) { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [n ? id(n) : ""]); await db.exec("set role authenticated"); }
async function asAdmin() { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
async function denied(fn, pattern) { await assert.rejects(fn, pattern); checks++; }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
// The phone reads its clock version before Send (ai_field_clock_version); by
// default it read it just now. `epoch` models a read taken earlier.
async function version(user) { await asUser(user); return Number((await one("select ai_field_clock_version() r")).r.epoch); }
async function begin(user, text, { sentAgoMs = 0, epoch, kind = "text", audio = null, client = {}, rid = id(seq++) } = {}) {
  const seen = epoch === undefined ? await version(user) : epoch;
  await asUser(user);
  // Align the synthetic phone clock with this database. Docker's guest clock
  // can be a fraction of a millisecond behind the host; explicit skew cases
  // below still move this timestamp forwards/backwards deliberately.
  const databaseNow = (await one("select clock_timestamp() at")).at;
  const sent = new Date(new Date(databaseNow).getTime() - sentAgoMs).toISOString();
  const res = (await one("select ai_field_begin($1,$2,$3,$4,$5,$6,$7) r", [rid, kind, text, sent, seen, audio, client])).r;
  return { rid, sent, seen, res };
}
const cmd = async (rid, key, action, data) => (await one("select ai_field_command($1,$2,$3,$4) r", [rid, key, action, data])).r;
const resolve = async (actionId, choice, hash) => (await one("select ai_field_resolve($1,$2,$3) r", [actionId, choice, hash])).r;
async function clockIn(user, job, { minutesAgo = 120 } = {}) {
  await asAdmin();
  const sid = id(seq++);
  await db.query("update time_shifts set clock_out_at=now(),status='submitted' where profile_id=$1 and clock_out_at is null", [id(user)]);
  await db.query("insert into time_shifts(id,profile_id,project_id,clock_in_at,status) values($1,$2,$3,now()-make_interval(mins=>$4),'open')", [sid, id(user), job, minutesAgo]);
  // Make the clock look long-settled, as it would be by the time a request is sent.
  await db.query("update ai_clock_epochs set changed_at=now()-interval '1 hour' where profile_id=$1", [id(user)]);
  return sid;
}
const settle = async (user) => { await asAdmin(); await db.query("update ai_clock_epochs set changed_at=now()-interval '1 hour' where profile_id=$1", [id(user)]); };

// --- Access: partner, retired, revoked and anonymous are refused everywhere ---
for (const who of [P, R, X, null]) {
  await denied(() => begin(who, "hello"));
  await asUser(who); await denied(() => db.query("select ai_field_context()"));
}
// Off today is not access removed: an installer and a foreman marked off can act.
for (const who of [C, OFF]) { const { res } = await begin(who, "What jobs are there?"); ok(res.id, "off-today crew can begin a request"); }
await asUser(C); ok((await one("select ai_field_context() r")).r.jobs.length >= 2, "off-today installer reads jobs");
await asUser(C); ok((await one("select custom_work_internal() r")).r === true, "off-today is internal");
for (const who of [R, X, P]) { await asUser(who); ok((await one("select custom_work_internal() r")).r === false, "removed access is not internal"); }

// --- Discovery and partition ---
await asUser(A);
let ctx = (await one("select ai_field_context(null,'') r")).r;
const jobIds = ctx.jobs.map((j) => j.id);
ok(jobIds.includes(JOB) && jobIds.includes(LODGE), "installer sees real jobs");
ok(!jobIds.includes(GONE) && !jobIds.includes(TESTJOB) && !jobIds.includes(SANDBOX), "deleted/testing jobs hidden from installer");
eq(ctx.crew, null, "installer gets no crew list");
await asUser(T);
eq((await one("select ai_field_context(null,'') r")).r.jobs.map((j) => j.id), [SANDBOX], "test login sees only the sandbox");
await denied(() => db.query("select ai_field_context($1)", [JOB]));
await asUser(S);
ok((await one("select ai_field_context(null,'') r")).r.jobs.some((j) => j.id === TESTJOB), "supervisor sees testing jobs");
await asUser(F);
ctx = (await one("select ai_field_context(null,'') r")).r;
const crewIds = ctx.crew.map((c) => c.id);
ok(crewIds.includes(id(OFF)) && crewIds.includes(id(C)), "crew picker includes Off today people");
ok(!crewIds.includes(id(R)) && !crewIds.includes(id(X)) && !crewIds.includes(id(P)) && !crewIds.includes(id(T)), "crew picker excludes removed, partner and test logins");
ctx = (await one("select ai_field_context($1) r", [JOB])).r;
const map9 = ctx.units.find((u) => u.label === "MAP-9"), map8 = ctx.units.find((u) => u.label === "MAP-8"), map7 = ctx.units.find((u) => u.label === "MAP-7");
eq([map9.from_plans.plan_call_width_in, map9.from_plans.plan_call_height_in, map9.from_plans.plan_style], [36, 72, "Thermal break aluminum fixed"], "map-only unit carries the schedule's call size for reference");
eq([map9.from_plans.width_in, map9.type], [undefined, null], "a call size is not a frame size, and no placeholder type is invented");
eq([map8.type, map8.from_plans.width_in, map8.from_plans.location], ["Slider 60x48", 60, "Bedroom"], "map-only unit carries its window type");
eq([map7.status, map7.assigned_to], ["assigned", "Ben"], "map owner shown");
eq(ctx.unit_counts.map_only, 4, "counts map-only units");

// --- Job creation: duplicate warning, actual person's choice, notice ---
let r1 = await begin(A, "New project Smith house at 12 Oak St");
let a1 = await cmd(r1.rid, "job:smithhouse", "create_job", { name: "Smith House", location: "12 Oak St" });
eq(a1.status, "needs_choice", "similar job asks first");
ok(a1.matches.some((m) => m.id === JOB), "existing Smith Residence offered");
await asAdmin(); eq(await count("select count(*) n from projects"), 5, "no job created before the choice");
await asUser(A);
eq((await cmd(r1.rid, "job:smithhouse", "create_job", { name: "Smith House", location: "12 Oak St" })).replay, "same", "replay returns the receipt");
eq((await cmd(r1.rid, "job:smithhouse", "create_job", { name: "Smith Hovel", location: "12 Oak St" })).replay, "changed", "changed replay refused");
// A model-supplied confirmation field changes nothing.
eq((await cmd(r1.rid, "job:smithhouse2", "create_job", { name: "Smith House", location: "12 Oak St", confirmed: true, choice: "create_new" })).status, "needs_choice", "confirmation flags in data are ignored");
await asUser(B); await denied(() => resolve(a1.action_id, "create_new", a1.preview_hash), /another account/);
await denied(() => cmd(r1.rid, "job:x", "create_job", { name: "Mine", location: "Somewhere 1" }), /another account/);
await asUser(A);
await denied(() => resolve(a1.action_id, "create_new", "wrong"), /changed/);
await denied(() => resolve(a1.action_id, "approve_everything", a1.preview_hash), /options/);
// A similar job appears after the preview: the tap re-asks, it does not create.
await asAdmin(); await db.query("insert into projects(id,name,job_code,address) values($1,'Smith House Annex','ANNEX','14 Oak St')", [id(105)]);
await asUser(A);
let a1b = await resolve(a1.action_id, "create_new", a1.preview_hash);
eq(a1b.status, "needs_choice", "changed duplicate set re-asks");
ok(a1b.matches.some((m) => m.id === id(105)) && a1b.preview_hash !== a1.preview_hash, "new match shown with a new seal");
await denied(() => resolve(a1.action_id, "create_new", a1.preview_hash), /changed/);
let created = await resolve(a1.action_id, "create_new", a1b.preview_hash);
eq([created.status, created.outcome, created.ready_state], ["done", "created", "not_ready"], "explicit new job created");
eq((await resolve(a1.action_id, "create_new", a1b.preview_hash)).project_id, created.project_id, "second tap returns the receipt");
await asAdmin();
eq(await count("select count(*) n from projects where name='Smith House'"), 1, "exactly one job");
eq((await one("select ready_state from project_pipeline where project_id=$1", [created.project_id])).ready_state, "not_ready", "born not ready");
let notice = await one("select * from project_messages where project_id=$1", [created.project_id]);
eq(notice.mentions, [id(S)], "all supervisors notified");
eq(await count("select count(*) n from project_messages"), 1, "one notice");
// Supervisor marked Off today still receives it; with none, owners (not partner owners) do.
await db.query("update profiles set active=false where id=$1", [id(S)]);
let r2 = await begin(A, "Create Zephyr Ranch at 900 Mesa Rd");
let a2 = await cmd(r2.rid, "job:zephyr", "create_job", { name: "Zephyr Ranch", location: "900 Mesa Rd" });
eq([a2.status, a2.outcome], ["done", "created"], "unique job created immediately");
await asAdmin();
eq((await one("select mentions from project_messages where project_id=$1", [a2.project_id])).mentions, [id(S)], "off-today supervisor still notified");
await db.query("update profiles set retired_at=now() where id=$1", [id(S)]);
let r3 = await begin(A, "Create Quartz Mill at 77 River Rd");
let a3 = await cmd(r3.rid, "job:quartz", "create_job", { name: "Quartz Mill", location: "77 River Rd" });
await asAdmin();
eq((await one("select mentions from project_messages where project_id=$1", [a3.project_id])).mentions, [id(O)], "owner fallback, never the partner owner");
await db.query("update profiles set retired_at=null,active=true where id=$1", [id(S)]);
// Use existing: no job, no notice.
let r4 = await begin(A, "Start a project Canyon Lodge");
let a4 = await cmd(r4.rid, "job:canyon", "create_job", { name: "Canyon Lodge", location: "4 Canyon Rd" });
let a4b = await resolve(a4.action_id, `use_existing:${LODGE}`, a4.preview_hash);
eq([a4b.outcome, a4b.project_id], ["used_existing", LODGE], "existing job chosen");
await asAdmin(); eq(await count("select count(*) n from projects where name='Canyon Lodge'"), 1, "no twin created");
// Cancel is final.
let r5 = await begin(A, "New job Smith");
let a5 = await cmd(r5.rid, "job:smith", "create_job", { name: "Smith", location: "12 Oak St" });
eq((await resolve(a5.action_id, "cancel", a5.preview_hash)).status, "cancelled", "cancel recorded");
eq((await resolve(a5.action_id, "create_new", a5.preview_hash)).status, "cancelled", "cancelled action cannot be revived");
await denied(async () => { await begin(T, "new job"); return cmd((await begin(T, "new job 2")).rid, "job:t", "create_job", { name: "Bot Job", location: "Lab 1" }); });

// --- Units: identity, components, conflicts, review ---
const unitFacts = { material: "Aluminum", story: "1", width_in: 72, height_in: 96, components: [{ label: "Door panel", quantity: 2 }, { label: "Frame", quantity: 1 }],
  opening_direction: "Left to right", direction_viewpoint: "outside looking in (default)", measurement_source: "6 feet by 8 feet", unknown_fields: ["electrical", "access"] };
let u1r = await begin(A, "Unit 4 bifold aluminum 6 by 8");
let u1 = await cmd(u1r.rid, "unit:4", "save_unit", { project_id: JOB, label: "4", type_label: "Bifold door", facts: unitFacts });
eq([u1.status, u1.outcome, u1.unit.facts.width_in, u1.unit.facts.components.length], ["done", "created", 72, 2], "one unit with components");
const U4 = u1.unit.unit_id;
let u1again = await cmd((await begin(A, "unit 4 again")).rid, "unit:4", "save_unit", { project_id: JOB, label: "4", type_label: "Bifold door", facts: unitFacts });
eq([u1again.outcome, u1again.unit.unit_id], ["unchanged", U4], "saying unit 4 again reuses it");
await asAdmin(); eq(await count("select count(*) n from custom_work_units where project_id=$1 and label='4'", [JOB]), 1, "no second unit 4");
await asUser(A);
await denied(() => cmd(u1r.rid, "unit:bad", "save_unit", { project_id: JOB, label: "5", type_label: "Fixed window", facts: { components: [{ label: "Pane", quantity: 1.5 }] } }), /whole-number/);
// Map identity: a spoken map code becomes the map unit, seeded from the plans.
let m8 = await cmd((await begin(A, "unit map-8")).rid, "unit:map8", "save_unit", { project_id: JOB, label: "map-8", type_label: null, facts: { story: "2" } });
eq([m8.outcome, m8.unit.opening_id, m8.unit.label, m8.unit.type, m8.unit.facts.width_in, m8.unit.facts.story], ["created_from_map", MAP8, "MAP-8", "Slider 60x48", 60, "2"], "map unit linked and seeded from plans");
// A spoken size that disagrees with the plans is shown, not chosen.
let m10r = await begin(A, "map-10 is 40 wide");
let m10 = await cmd(m10r.rid, "unit:map10", "save_unit", { project_id: JOB, label: "MAP-10", type_label: "Slider 60x48", facts: { width_in: 40 } });
eq([m10.status, m10.reason, m10.differences.width_in.plans, m10.differences.width_in.said], ["needs_choice", "plan_conflict", 60, 40], "plan conflict shown");
await asAdmin(); eq(await count("select count(*) n from custom_work_units where opening_id=$1", [MAP10]), 0, "nothing created while asking");
await asUser(A);
let m10b = await resolve(m10.action_id, "use_plans", m10.preview_hash);
eq([m10b.outcome, m10b.unit.facts.width_in, m10b.unit.facts.height_in, m10b.unit.facts.location], ["created_from_map", 60, 48, "Porch"], "plans kept");
// MAP-9 has only a schedule call size: the new record gets no invented frame size.
let m9b = await cmd((await begin(A, "map-9 fixed")).rid, "unit:map9", "save_unit", { project_id: JOB, label: "MAP-9", type_label: "Fixed window", facts: {} });
eq([m9b.outcome, m9b.unit.facts.width_in, m9b.unit.type], ["created_from_map", undefined, "Fixed window"], "call size not seeded as frame size");
// Conflict by a non-author installer: no correction offered; review saves an observation.
let c1r = await begin(B, "unit 4 is vinyl");
let c1 = await cmd(c1r.rid, "unit:4:v", "save_unit", { project_id: JOB, label: "4", type_label: null, facts: { material: "Vinyl" } });
eq([c1.reason, c1.can_edit, c1.differences.material.stored, c1.differences.material.said], ["fact_conflict", false, "Aluminum", "Vinyl"], "vinyl vs aluminum shown");
ok(!c1.options.some((o) => o.id === "correct_record"), "no correction option without authority");
await denied(() => resolve(c1.action_id, "correct_record", c1.preview_hash), /options/);
// Differences only, no additions: the observation must still be saved (root finding 1).
let c1b = await resolve(c1.action_id, "send_for_review", c1.preview_hash);
eq(c1b.outcome, "sent_for_review", "review outcome");
await asAdmin();
let obs = await one("select * from custom_work_history where action='ai_observation' and entity_id=$1", [U4]);
ok(obs && obs.after_value.differences.material.said === "Vinyl" && obs.actor_id === id(B), "observation with only differences is saved");
eq((await one("select facts->>'material' m from custom_work_units where id=$1", [U4])).m, "Aluminum", "record unchanged");
// The author corrects; a stale preview is refused.
let c2r = await begin(A, "unit 4 is actually vinyl");
let c2 = await cmd(c2r.rid, "unit:4:v", "save_unit", { project_id: JOB, unit_id: U4, label: "4", type_label: null, facts: { material: "Vinyl" } });
ok(c2.options.some((o) => o.id === "correct_record"), "author may correct");
// Someone else edits the unit after the preview.
let other = await cmd((await begin(A, "unit 4 electrical yes")).rid, "unit:4:e", "save_unit", { project_id: JOB, label: "4", type_label: null, facts: { electrical: "Yes" } });
eq(other.outcome, "details_added", "additions apply for the author");
ok(!other.unit.facts.unknown_fields.includes("electrical") && other.unit.facts.unknown_fields.includes("access"), "answered unknowns cleared, others kept");
await asUser(A);
let stale = await resolve(c2.action_id, "correct_record", c2.preview_hash);
eq(stale.status, "stale", "correction against a changed unit is refused");
await asAdmin(); eq((await one("select facts->>'material' m from custom_work_units where id=$1", [U4])).m, "Aluminum", "no unseen overwrite");
let c3 = await cmd((await begin(A, "unit 4 vinyl")).rid, "unit:4:v", "save_unit", { project_id: JOB, label: "4", type_label: null, facts: { material: "Vinyl" } });
let c3b = await resolve(c3.action_id, "correct_record", c3.preview_hash);
eq([c3b.outcome, c3b.unit.facts.material], ["corrected", "Vinyl"], "fresh correction applied");
await asAdmin();
let hist = await one("select * from custom_work_history where entity_id=$1 and reason='Crew correction through Forge AI'", [U4]);
ok(hist.before_value.facts.material === "Aluminum" && hist.after_value.facts.material === "Vinyl", "history keeps before and after");
let c4 = await cmd((await begin(A, "unit 4 steel")).rid, "unit:4:s", "save_unit", { project_id: JOB, label: "4", type_label: null, facts: { material: "Steel" } });
eq([(await resolve(c4.action_id, "keep_original", c4.preview_hash)).outcome], ["unchanged"], "keep original");
await asAdmin(); eq((await one("select facts->>'material' m from custom_work_units where id=$1", [U4])).m, "Vinyl", "kept");
// Test login writes only the sandbox.
let tr = await begin(T, "unit 1 in sandbox");
eq((await cmd(tr.rid, "unit:s1", "save_unit", { project_id: SANDBOX, label: "S1", type_label: "Fixed window", facts: {} })).outcome, "created", "sandbox unit");
await denied(() => cmd(tr.rid, "unit:s2", "save_unit", { project_id: JOB, label: "S2", type_label: "Fixed window", facts: {} }), /unavailable|test login/);

// --- Starting work: clock route, staleness, claims ---
let s1 = await cmd((await begin(A, "start unit 4")).rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" });
eq([s1.status, s1.reason], ["needs_choice", "needs_clock"], "not clocked in: job clock first");
await asAdmin(); eq(await count("select count(*) n from custom_work_sessions"), 0, "no timer without a shift");
await clockIn(A, LODGE);
await asUser(A);
let s1b = await resolve(s1.action_id, "start_now", s1.preview_hash);
eq(s1b.reason, "wrong_job", "wrong job: switch through the job clock");
await clockIn(A, JOB, { minutesAgo: 1 });
await asUser(A);
let s1c = await resolve(s1.action_id, "start_now", s1b.preview_hash);
eq([s1c.status, s1c.claimed, s1c.start_time_basis], ["running", true, "tapped_start"], "starts at the tap after clocking in, claims");
await asAdmin(); eq((await one("select assigned_to from custom_work_units where id=$1", [U4])).assigned_to, id(A), "unmapped claim on the unit");
// Repeat start: same timer.
await settle(A);
let rep = await cmd((await begin(A, "start unit 4")).rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" });
eq([rep.outcome, new Date(rep.started_at).getTime()], ["already_running", new Date(s1c.started_at).getTime()], "repeat never resets");
await asAdmin(); eq(await count("select count(*) n from custom_work_sessions where profile_id=$1", [id(A)]), 1, "one session");
// Send-time rule: an unchanged open shift starts at the send moment.
await asAdmin(); await db.query("insert into custom_work_units(id,project_id,created_by,label,type_label) values($1,$2,$3,'10','Fixed window')", [id(400), JOB, id(A)]);
// Unit 4 has been running a while by the time the next request is sent.
await db.query("update custom_work_sessions set started_at=now()-interval '5 minutes' where profile_id=$1", [id(A)]);
await db.query("update time_shifts set clock_in_at=now()-interval '10 minutes' where profile_id=$1 and clock_out_at is null", [id(A)]);
await settle(A);
let sendReq = await begin(A, "switch me to unit 10", { sentAgoMs: 45000 });
let st2 = await cmd(sendReq.rid, "start:10", "start_unit", { project_id: JOB, unit_id: id(400), stage: "Installing", participation: "install" });
eq(st2.start_time_basis, "request_sent", "send time used");
await asAdmin();
let sess = await one("select started_at from custom_work_sessions where unit_id=$1", [id(400)]);
eq(sess.started_at.getTime(), new Date(sendReq.sent).getTime(), "session starts exactly at the phone's Send moment");
eq((await one("select end_reason from custom_work_sessions where unit_id=$1", [U4])).end_reason, "switch", "previous unit ended, not deleted");
// Stale arrival over the network (review 2, blocker 1). The phone read its clock
// version, pressed Send 40 s ago and put that time in the request; the network
// held it. 20 s ago a newer idle timer started. The HTTP body carries no age.
await asAdmin(); await db.query("update custom_work_sessions set started_at=now()-interval '10 minutes' where profile_id=$1 and ended_at is null", [id(A)]);
await settle(A);
const seenBeforeSend = await version(A);
await asAdmin(); await db.query("update time_shifts set clock_in_at=now()-interval '2 hours' where profile_id=$1 and clock_out_at is null", [id(A)]);
await settle(A);
const seenEpoch = await version(A);
await asUser(A);
const idleStarted = await cmd((await begin(A, "idle, waiting on glass", { sentAgoMs: 0 })).rid, "idle", "start_idle", { description: "Waiting on material" });
eq(idleStarted.status, "running", "newer idle timer started during transit");
await asAdmin(); await db.query("update custom_work_sessions set started_at=now()-interval '20 seconds' where profile_id=$1 and ended_at is null", [id(A)]);
let delayed = await begin(A, "start unit 4", { sentAgoMs: 40000, epoch: seenEpoch });
let st3 = await cmd(delayed.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" });
eq(st3.status, "stale", "request delayed in transit refuses the start");
await asAdmin();
eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and ended_at is null and kind='idle'", [id(A)]), 1, "newer idle left running");
eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and unit_id=$2 and ended_at is null", [id(A), U4]), 0, "no unit timer started over it");
ok(seenBeforeSend <= seenEpoch, "versions only move forward");
// A phone that did not say what it had seen gets no timing action.
let noSeen = await begin(A, "start unit 4", { epoch: null });
eq((await cmd(noSeen.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" })).status, "stale", "unknown phone view refuses");
// Device clock behind the server: the version matches but Send appears to come
// before the last change. The person taps Start now; nothing is backdated.
let skew = await begin(A, "start unit 4", { sentAgoMs: 90000 });
let sk = await cmd(skew.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" });
eq([sk.status, sk.reason], ["needs_choice", "confirm_time"], "clock disagreement asks");
await asAdmin(); eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and unit_id=$2 and ended_at is null", [id(A), U4]), 0, "nothing started while asking");
await asUser(A);
let sk2 = await resolve(sk.action_id, "start_now", sk.preview_hash);
eq([sk2.status, sk2.start_time_basis], ["running", "tapped_start"], "tap starts now");
ok(new Date(sk2.started_at).getTime() > new Date(skew.sent).getTime(), "not backdated to the doubtful send time");
// A mildly fast device clock also needs a real tap; never silently clamp the
// original timestamp to server-now and label that as request-sent timing.
const future = await begin(A, "start unit 10", { sentAgoMs: -60000 });
const futureResult = await cmd(future.rid, "start:10", "start_unit", { project_id: JOB, unit_id: id(400), stage: "Installing", participation: "install" });
eq([futureResult.status, futureResult.reason], ["needs_choice", "confirm_time"], "future device time asks before starting");
await asAdmin();
eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and unit_id=$2 and ended_at is null", [id(A), U4]), 1, "future device request leaves existing work alone");
await asUser(A); await resolve(futureResult.action_id, "cancel", futureResult.preview_hash);
// The sent time is evidence: bounded and finite.
await asUser(A);
for (const bad of ["infinity", "-infinity", new Date(Date.now() + 86400000).toISOString(), "2099-01-01T00:00:00Z", new Date(Date.now() - 8 * 86400000).toISOString()]) {
  await denied(() => db.query("select ai_field_begin($1,'text','x',$2,0,null,'{}')", [id(seq++), bad]), /future|week old/);
}
await asAdmin(); await db.query("update custom_work_sessions set ended_at=now(),end_reason='stop' where profile_id=$1 and ended_at is null", [id(A)]);
// (The existing legacy trigger ended unit 10 when the task timer began; that is
// the canonical route's behaviour, not this request's.) Put unit 10 back on.
await asAdmin();
await db.query("update task_sessions set ended_at=now() where profile_id=$1", [id(A)]);
eq((await cmd((await begin(A, "back on unit 10", { sentAgoMs: 0 })).rid, "start:10", "start_unit", { project_id: JOB, unit_id: id(400), stage: "Installing", participation: "install" })).status, "running", "fresh request restarts unit 10");
// Stale after arrival: break taken and ended while the model works (changed and back).
await settle(A);
let during = await begin(A, "start unit 4");
await asAdmin();
await db.query("update time_shifts set break_started_at=now() where profile_id=$1 and clock_out_at is null", [id(A)]);
await db.query("select end_break(id) from time_shifts where profile_id=$1 and clock_out_at is null", [id(A)]);
await asUser(A);
eq((await cmd(during.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" })).status, "stale", "break and back still stale");
// Flashing timer started meanwhile is a timing route too.
await settle(A);
let during2 = await begin(A, "start unit 4");
await asAdmin(); await db.query("insert into opening_phases(opening_id,started_by,status) values($1,$2,'active')", [MAP8, id(A)]);
await asUser(A);
eq((await cmd(during2.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" })).status, "stale", "flashing timer change is seen");
await asAdmin(); await db.query("update opening_phases set status='submitted' where started_by=$1", [id(A)]);
// Old request: evidence kept, no timer.
await settle(A);
let old = await begin(A, "start unit 4", { sentAgoMs: 6 * 60000 });
eq((await cmd(old.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" })).status, "stale", "old request never starts a timer");
await asAdmin(); ok(await count("select count(*) n from ai_field_requests where id=$1", [old.rid]) === 1, "old request kept as evidence");
// Pending clock sync on the phone.
await settle(A);
let pend = await begin(A, "start unit 4", { client: { clock_pending_sync: true } });
eq((await cmd(pend.rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" })).status, "stale", "pending clock sync refuses");
// Stale stop: the old stop must not end newer work. (The break test above ended
// unit 10 through the canonical break trigger; start it again with a fresh request.)
eq((await cmd((await begin(A, "unit 10 again", { sentAgoMs: 0 })).rid, "start:10", "start_unit", { project_id: JOB, unit_id: id(400), stage: "Installing", participation: "install" })).status, "running", "fresh start");
await settle(A);
let stopReq = await begin(A, "stop");
await asAdmin(); await db.query("update ai_clock_epochs set epoch=epoch+1 where profile_id=$1", [id(A)]);
await asUser(A);
eq((await cmd(stopReq.rid, "stop", "stop_work", { outcome: "partial", note: null })).status, "stale", "stale stop refused");
await asAdmin(); eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and ended_at is null", [id(A)]), 1, "timer still running");
// Break: the person's own tap resumes, never backdated.
await asAdmin(); await db.query("update time_shifts set break_started_at=now()-interval '10 minutes' where profile_id=$1 and clock_out_at is null", [id(A)]);
await settle(A);
let br = await cmd((await begin(A, "start unit 4")).rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" });
eq([br.status, br.reason], ["needs_choice", "on_break"], "on break asks");
let brOk = await resolve(br.action_id, "end_break_and_start", br.preview_hash);
eq([brOk.status, brOk.break_ended, brOk.start_time_basis], ["running", true, "tapped_start"], "break ended by the person's tap, start now");
await asAdmin(); ok((await one("select break_seconds from time_shifts where profile_id=$1 and clock_out_at is null", [id(A)])).break_seconds >= 590, "break time preserved");
// Break preview then clock changes: stale.
await db.query("update time_shifts set break_started_at=now() where profile_id=$1 and clock_out_at is null", [id(A)]);
await settle(A);
let br2 = await cmd((await begin(A, "start unit 10")).rid, "start:10b", "start_unit", { project_id: JOB, unit_id: id(400), stage: "Installing", participation: "install" });
await asAdmin(); await db.query("select end_break(id) from time_shifts where profile_id=$1 and clock_out_at is null", [id(A)]);
await asUser(A);
eq((await resolve(br2.action_id, "end_break_and_start", br2.preview_hash)).status, "stale", "break preview after a clock change is stale");
// Claims: occupied map unit and helper join.
await clockIn(B, JOB);
await asUser(B);
let hb = await cmd((await begin(B, "start unit 4")).rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "install" });
eq([hb.reason, hb.unit.assigned_to], ["claimed", "Ana"], "assigned unit is not taken");
let hb2 = await resolve(hb.action_id, "join_helper", hb.preview_hash);
eq([hb2.status, hb2.participation, hb2.claimed], ["running", "helper", false], "helper joins with own time");
await asAdmin();
eq((await one("select assigned_to from custom_work_units where id=$1", [U4])).assigned_to, id(A), "assignee unchanged by helper");
eq((await one("select shift_id from custom_work_sessions where profile_id=$1 and ended_at is null", [id(B)])).shift_id, (await one("select id from time_shifts where profile_id=$1 and clock_out_at is null", [id(B)])).id, "helper time on helper's own shift");
// Map unit owned on the map: Ana cannot claim MAP-7 (Ben's) as a fresh custom unit.
await settle(A);
let m7 = await cmd((await begin(A, "start map-7")).rid, "unit:map7", "save_unit", { project_id: JOB, label: "MAP-7", type_label: "Fixed window", facts: {} });
eq([m7.outcome, m7.unit.opening_id, m7.unit.assigned_to], ["created_from_map", MAP7, "Ben"], "map-7 resolves to the map identity and its owner");
await settle(A);
let m7s = await cmd((await begin(A, "start map-7")).rid, "start:m7", "start_unit", { project_id: JOB, unit_id: m7.unit.unit_id, stage: "Installing", participation: "install" });
eq(m7s.reason, "claimed", "occupied map unit needs the helper choice");
// A free map unit: claiming writes the map owner, not a second owner.
await settle(A);
let m8s = await cmd((await begin(A, "start map-8")).rid, "start:m8", "start_unit", { project_id: JOB, unit_id: m8.unit.unit_id, stage: "Installing", participation: "install" });
eq([m8s.status, m8s.claimed], ["running", true], "free map unit claimed");
await asAdmin();
eq((await one("select assigned_to from project_openings where id=$1", [MAP8])).assigned_to, id(A), "map owner set");
eq((await one("select assigned_to from custom_work_units where opening_id=$1", [MAP8])).assigned_to, null, "no second owner on the custom record");
eq((await one("select via,changed_by from opening_assignment_events where opening_id=$1", [MAP8])), { via: "map", changed_by: id(A) }, "assignment history written");
// Linking a claimed custom unit to a map unit owned by someone else is refused.
await db.query("insert into custom_work_units(id,project_id,created_by,label,type_label,assigned_to) values($1,$2,$3,'11','Fixed window',$3)", [id(401), JOB, id(C)]);
await db.query("insert into project_openings(id,project_id,opening_code,assigned_to) values($1,$2,'MAP-11',$3)", [id(203), JOB, id(B)]);
await denied(() => db.query("update custom_work_units set opening_id=$1 where id=$2", [id(203), id(401)]), /different people/);
// Finished and unknown-type units.
await db.query("insert into custom_work_units(id,project_id,created_by,label,type_label,facts) values($1,$2,$3,'12','Fixed window','{\"installation_complete\":\"Yes\"}'),($4,$2,$3,'13','Unknown','{}')", [id(402), JOB, id(A), id(403)]);
await settle(A);
let fin = await begin(A, "start unit 12");
await denied(() => cmd(fin.rid, "start:12", "start_unit", { project_id: JOB, unit_id: id(402), stage: "Installing", participation: "install" }), /already finished/);
await denied(() => cmd(fin.rid, "start:13", "start_unit", { project_id: JOB, unit_id: id(403), stage: "Installing", participation: "install" }), /type of unit/);
// Stop: own timer only; helpers and the job clock continue; no QC.
await settle(A);
let stp = await cmd((await begin(A, "done for now on this one")).rid, "stop", "stop_work", { outcome: "partial", note: "Left side shimmed" });
eq([stp.outcome, stp.job_clock_still_running, stp.qc], ["stopped", true, "not_approved"], "stop is stage-only, no QC");
await asAdmin();
eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and ended_at is null", [id(B)]), 1, "helper keeps working");
// Idle time through the same route.
await settle(A);
let idle = await cmd((await begin(A, "idle, loading the truck")).rid, "idle", "start_idle", { description: "Loading or unloading" });
eq([idle.status, idle.stage], ["running", "Idle time"], "idle timer via custom work");
// Claims survive clock-out.
await asAdmin(); await db.query("update time_shifts set clock_out_at=now(),status='submitted' where profile_id=$1 and clock_out_at is null", [id(A)]);
eq((await one("select assigned_to from custom_work_units where id=$1", [U4])).assigned_to, id(A), "claim survives clock-out");
// Release: only the owner or a foreman; helpers keep working.
await asUser(B);
await denied(async () => cmd((await begin(B, "release unit 4")).rid, "release:4", "release_unit", { project_id: JOB, unit_id: U4 }), /assigned installer or a foreman/);
let rel = await cmd((await begin(A, "release unit 4")).rid, "release:4", "release_unit", { project_id: JOB, unit_id: U4 });
eq([rel.outcome, Number(rel.helpers_still_working)], ["released", 1], "released; helper unaffected");
let relMap = await cmd((await begin(A, "release map-8")).rid, "release:m8", "release_unit", { project_id: JOB, unit_id: m8.unit.unit_id });
eq(relMap.outcome, "released", "map claim released");
await asAdmin(); eq((await one("select assigned_to from project_openings where id=$1", [MAP8])).assigned_to, null, "map owner cleared");
// A retired login loses a pending confirmation.
await clockIn(C, JOB);
await asUser(C);
let rc = await cmd((await begin(C, "start unit 4")).rid, "start:4", "start_unit", { project_id: JOB, unit_id: U4, stage: "Installing", participation: "helper" });
ok(["running", "needs_choice"].includes(rc.status), "off-today installer can time their own work");
let pendingJob = await cmd((await begin(C, "new job Smith")).rid, "job:s", "create_job", { name: "Smith", location: "12 Oak St" });
await asAdmin(); await db.query("update profiles set access_revoked_at=now() where id=$1", [id(C)]);
await asUser(C); await denied(() => resolve(pendingJob.action_id, "create_new", pendingJob.preview_hash), /current access/);
await asAdmin(); await db.query("update profiles set access_revoked_at=null where id=$1", [id(C)]);

// --- Foreman retrospective crew record: zero payroll ---
await asAdmin();
const shiftsBefore = await count("select count(*) n from time_shifts"), sessionsBefore = await count("select count(*) n from custom_work_sessions");
const factsBefore = (await one("select facts,revision from custom_work_units where id=$1", [U4]));
let fr = await begin(F, "Olga and Ben installed unit 4 yesterday");
let crew = await cmd(fr.rid, "crew:4", "crew_record", { project_id: JOB, unit_id: U4, label: null, type_label: null, people: [id(OFF), id(B)], work_date: "2026-09-21", stage: "Hardware", outcome: "partial", description: "Handles and locks" });
eq([crew.outcome, crew.payroll_changed, crew.people], ["crew_recorded", false, ["Ben", "Olga"]], "crew record with an off-today person");
await asAdmin();
eq([await count("select count(*) n from time_shifts"), await count("select count(*) n from custom_work_sessions")], [shiftsBefore, sessionsBefore], "no payroll or timer rows");
eq((await one("select facts from custom_work_units where id=$1", [U4])).facts, factsBefore.facts, "crew record does not change facts");
eq((await one("select filed_by from crew_work_records where unit_id=$1", [U4])).filed_by, id(F), "filer separate from workers");
let crewMap = await cmd((await begin(F, "Ben did map-9 flashing")).rid, "crew:m9", "crew_record", { project_id: JOB, unit_id: null, label: "MAP-9", type_label: null, people: [id(B)], work_date: "2026-09-21", stage: "Flashing", outcome: "finished", description: "" });
eq(crewMap.unit.unit_id, m9b.unit.unit_id, "crew record resolves the existing map unit");
await asUser(A);
await denied(async () => cmd((await begin(A, "record crew")).rid, "crew:x", "crew_record", { project_id: JOB, unit_id: U4, people: [id(B)], work_date: "2026-09-21", stage: "Hardware", outcome: "partial" }), /foreman/);
for (const bad of [[id(R)], [id(X)], [id(P)]]) {
  await denied(async () => cmd((await begin(F, "record")).rid, "crew:bad", "crew_record", { project_id: JOB, unit_id: U4, people: bad, work_date: "2026-09-21", stage: "Hardware", outcome: "partial" }), /current access/);
}
// Off-today foreman may file too.
let offF = await cmd((await begin(OFF, "Ana did unit 10 detail yesterday")).rid, "crew:10", "crew_record", { project_id: JOB, unit_id: id(400), people: [id(A)], work_date: "2026-09-21", stage: "Detail work", outcome: "finished", description: "" });
eq(offF.outcome, "crew_recorded", "off-today foreman files");

// --- Voice evidence: private, immutable, must exist ---
const vr = id(seq++);
await asUser(A);
await denied(() => begin(A, "voice", { kind: "voice", rid: vr }), /recording/);
await denied(() => begin(A, "voice", { kind: "voice", rid: vr, audio: `${id(B)}/${vr}/memo.webm` }), /not saved/);
await denied(() => begin(A, "voice", { kind: "voice", rid: vr, audio: `${id(A)}/${vr}/memo.webm` }), /not saved/);
await denied(() => db.query("insert into storage.objects(bucket_id,name) values('ai-field-memos',$1)", [`${id(B)}/${vr}/memo.webm`]));
await db.query("insert into storage.objects(bucket_id,name) values('ai-field-memos',$1)", [`${id(A)}/${vr}/memo.webm`]);
let voice = await begin(A, "start unit four", { kind: "voice", rid: vr, audio: `${id(A)}/${vr}/memo.webm` });
eq(voice.res.id, vr, "voice request saved with its recording");
eq((await db.query("update storage.objects set name=name||'x' where bucket_id='ai-field-memos'")).affectedRows ?? 0, 0, "memo cannot be overwritten");
eq((await db.query("delete from storage.objects where bucket_id='ai-field-memos'")).affectedRows ?? 0, 0, "memo cannot be deleted");
await asUser(B); eq(await count("select count(*) n from storage.objects where bucket_id='ai-field-memos'"), 0, "another installer cannot hear it");
await asUser(S); eq(await count("select count(*) n from storage.objects where bucket_id='ai-field-memos'"), 1, "supervisor can review it");
await asUser(P); eq(await count("select count(*) n from storage.objects where bucket_id='ai-field-memos'"), 0, "partner cannot");
// Replay must match the original.
await asUser(A);
await denied(() => db.query("select ai_field_begin($1,'voice','different words',$2,1000,$3,'{}')", [vr, voice.sent, `${id(A)}/${vr}/memo.webm`]), /does not match/);

// --- Finish, reload, reads ---
await asUser(A);
await db.query("select ai_field_finish($1,$2,$3)", [vr, { answer: "Started." }, { unit: { label: "4" } }]);
await db.query("select ai_field_finish($1,$2,$3)", [vr, { answer: "Second answer" }, null]);
let reload = (await one("select ai_field_begin($1,'voice','start unit four',$2,99999,$3,'{}') r", [vr, voice.sent, `${id(A)}/${vr}/memo.webm`])).r;
eq([reload.finished, reload.reply.answer, reload.captured.unit.label], [true, "Started.", "4"], "reload returns the first saved answer and fields");
await denied(() => cmd(vr, "late", "stop_work", { outcome: "partial" }), /finished/);
await asUser(A); const mine = await count("select count(*) n from ai_field_requests");
ok(mine > 0 && (await count("select count(*) n from ai_field_requests where profile_id<>$1", [id(A)])) === 0, "installer reads only own requests");
await asUser(S); ok(await count("select count(*) n from ai_field_requests") > mine, "supervisor reads all requests");
for (const who of [P, R, X]) { await asUser(who); eq(await count("select count(*) n from ai_field_requests") + await count("select count(*) n from ai_field_actions") + await count("select count(*) n from ai_field_jobs"), 0, "removed/partner read nothing"); }
await asUser(B); eq(await count("select count(*) n from ai_field_jobs"), 0, "installer cannot list others' field jobs");
await asUser(A); eq(await count("select count(*) n from ai_field_jobs"), 3, "creator sees own field jobs");
await asUser(F); eq(await count("select count(*) n from ai_field_jobs"), 3, "foreman sees field jobs");
// Direct writes are closed.
await asUser(A);
await denied(() => db.query("insert into ai_field_actions(id,request_id,profile_id,action,action_key,data) values($1,$2,$3,'create_job','k','{}')", [id(seq++), vr, id(A)]));
await denied(() => db.query("update ai_field_actions set status='done'"));
await denied(() => db.query("update custom_work_units set assigned_to=$1", [id(A)]));
await denied(() => db.query("select _ai_field_apply($1,'create_new')", [a1.action_id]));

// --- A large job: bounded list, scoped search finds a unit past the first 300 ---
await asAdmin();
await db.query("insert into custom_work_units(id,project_id,created_by,label,type_label) select gen_random_uuid(),$1,$2,'L'||lpad(g::text,3,'0'),'Fixed window' from generate_series(1,350) g", [LODGE, id(F)]);
await asUser(A);
let big = (await one("select ai_field_context($1,'') r", [LODGE])).r;
eq([big.units.length, big.units_truncated, big.unit_counts.total], [300, true, 350], "large job list is bounded and says so");
ok(!big.units.some((u) => u.label === "L347"), "L347 is beyond the first page");
big = (await one("select ai_field_context($1,'l347') r", [LODGE])).r;
eq([big.units[0].label, big.unit_counts.matching_search, big.unit_counts.total, big.units_truncated], ["L347", 1, 350, false], "search within the job finds it, counts stay whole-job");
big = (await one("select ai_field_context($1,'L34') r", [LODGE])).r;
eq(big.units.map((u) => u.label), ["L340", "L341", "L342", "L343", "L344", "L345", "L346", "L347", "L348", "L349"], "partial label search");
big = (await one("select ai_field_context($1,'MAP-8') r", [JOB])).r;
eq(big.units[0].map_code, "MAP-8", "map code search, exact first");

// --- A guided setup spans many messages (review 3) ---
const CONV = id(900);
const turn1 = await begin(A, "new job Pine Hollow", { client: { conversation_id: CONV } });
const answers1 = { answers: { job: { name: "Pine Hollow", location: null }, unit: { label: "4", material: "Aluminum", unknown: ["electrical"] } }, checklist: null };
await db.query("select ai_field_save_draft($1,$2)", [turn1.rid, answers1]);
for (let i = 0; i < 10; i++) {
  const t = await begin(A, `turn ${i}`, { client: { conversation_id: CONV } });
  const draft = (await one("select ai_field_draft($1,$2) r", [CONV, t.rid])).r;
  eq(draft.answers.unit.material, "Aluminum", `turn ${i + 2} still has the first answers`);
  await db.query("select ai_field_save_draft($1,$2)", [t.rid, { ...draft, answers: { ...draft.answers, turn: i } }]);
  await db.query("select ai_field_finish($1,$2,null)", [t.rid, { answer: "ok" }]);
}
eq((await one("select ai_field_draft($1,null) r", [CONV])).r.answers.turn, 9, "finish keeps the saved draft");
await denied(() => db.query("select ai_field_save_draft($1,$2)", [turn1.rid, { answers: {} }]).then(() => db.query("select ai_field_finish($1,$2,null)", [turn1.rid, { answer: "x" }])).then(() => db.query("select ai_field_save_draft($1,$2)", [turn1.rid, { answers: {} }])), /finished/);
await asUser(B);
eq((await one("select ai_field_draft($1,null) r", [CONV])).r, {}, "another account on the same conversation id starts empty");
await denied(() => db.query("select ai_field_save_draft($1,$2)", [turn1.rid, { answers: {} }]), /another account/);
await denied(async () => begin(A, "turn 0", { rid: (await (async () => { await asUser(A); return (await one("select id from ai_field_requests where transcript='turn 0'")).id; })()), client: { conversation_id: id(901) } }), /does not match/);
await asUser(A);
eq((await cmd((await begin(A, "size source unknown")).rid, "unit:u4src", "save_unit", { project_id: JOB, label: "4", type_label: null, facts: { unknown_fields: ["area_source", "weight_lb"] } })).status, "done", "size source and weight can be 'unknown'");

// --- Unreferenced recordings: listed for byte removal, evidence never ---
await asAdmin();
await db.query("insert into storage.objects(bucket_id,name,created_at) values('ai-field-memos',$1,now()-interval '91 days'),('ai-field-memos',$2,now())", [`${id(A)}/${id(990)}/memo.webm`, `${id(A)}/${id(991)}/memo.webm`]);
await db.query("update storage.objects set created_at=now()-interval '91 days' where name=$1", [`${id(A)}/${vr}/memo.webm`]);
const lease1 = id(980);
const claimed = (await db.query("select * from ai_field_claim_orphan_memos($1,100) n", [lease1])).rows.map((r) => r.n);
eq(claimed, [`${id(A)}/${id(990)}/memo.webm`], "only the old unreferenced recording is claimed; recent uploads and evidence are not");
eq(await count("select count(*) n from ai_field_memo_cleanup where lease=$1", [lease1]), 1, "claim leaves a recoverable marker");
// Claimed first: the recording can no longer be attached to a request.
await asUser(A);
await denied(() => db.query("select ai_field_begin($1,'voice','late',$2,0,$3,'{}')", [id(990), new Date().toISOString(), `${id(A)}/${id(990)}/memo.webm`]), /being removed/);
// Attached first: a recording on a request is never claimed.
await asAdmin(); await db.query("insert into storage.objects(bucket_id,name,created_at) values('ai-field-memos',$1,now()-interval '91 days')", [`${id(A)}/${id(992)}/memo.webm`]);
await asUser(A);
eq((await begin(A, "attached in time", { kind: "voice", rid: id(992), audio: `${id(A)}/${id(992)}/memo.webm` })).res.id, id(992), "attached before the sweep");
await asAdmin();
eq((await db.query("select * from ai_field_claim_orphan_memos($1,100) n", [id(981)])).rows.length, 0, "an attached recording is never claimed (and a live lease is not re-claimed)");
// Storage deletion failed: the marker stays, the lease is freed, and it is retried.
let fin1 = (await one("select ai_field_finish_memo_cleanup($1,$2) r", [lease1, { [`${id(A)}/${id(990)}/memo.webm`]: "storage unavailable" }])).r;
eq([fin1.removed, fin1.retry], [0, 1], "failed deletion is kept for retry");
eq((await one("select lease,last_error from ai_field_memo_cleanup where name=$1", [`${id(A)}/${id(990)}/memo.webm`])), { lease: null, last_error: "storage unavailable" }, "marker records the failure");
const lease2 = id(982);
eq((await db.query("select * from ai_field_claim_orphan_memos($1,100) n", [lease2])).rows.map((r) => r.n), [`${id(A)}/${id(990)}/memo.webm`], "retried on the next run");
// Bytes really removed (the Storage API deletes the object row): marker cleared.
await db.query("delete from storage.objects where name=$1", [`${id(A)}/${id(990)}/memo.webm`]);
await asUser(A);
await denied(() => db.query("insert into storage.objects(bucket_id,name) values('ai-field-memos',$1)", [`${id(A)}/${id(990)}/memo.webm`]), /being removed/);
await asAdmin();
let fin2 = (await one("select ai_field_finish_memo_cleanup($1,'{}') r", [lease2])).r;
eq([fin2.removed, fin2.retry, await count("select count(*) n from ai_field_memo_cleanup")], [1, 0, 0], "finished cleanup leaves nothing behind");
ok(await count("select count(*) n from storage.objects where name=$1", [`${id(A)}/${vr}/memo.webm`]) === 1, "evidence recording untouched");
// A recording younger than 90 days is never claimed, even if unsent.
await db.query("insert into storage.objects(bucket_id,name,created_at) values('ai-field-memos',$1,now()-interval '30 days')", [`${id(A)}/${id(993)}/memo.webm`]);
eq((await db.query("select * from ai_field_claim_orphan_memos($1,100) n", [id(984)])).rows.length, 0, "unsent recordings get 90 days' grace");
// After a completed cleanup the phone's own copy can go up again on the same path and be sent.
await asUser(A);
await db.query("insert into storage.objects(bucket_id,name) values('ai-field-memos',$1)", [`${id(A)}/${id(990)}/memo.webm`]);
eq((await begin(A, "sent at last", { kind: "voice", rid: id(990), audio: `${id(A)}/${id(990)}/memo.webm` })).res.id, id(990), "same-path retry after cleanup is accepted");
for (const who of [A, S, O]) {
  await asUser(who);
  await denied(() => db.query("select * from ai_field_claim_orphan_memos($1,10)", [id(983)]));
  await denied(() => db.query("select ai_field_finish_memo_cleanup($1,'{}')", [id(983)]));
  await denied(() => db.query("select * from ai_field_memo_cleanup"));
}

// --- Registrations ---
await asAdmin();
eq((await one("select min_role from ai_spend_limits")).min_role, "installer", "installer AI floor");
eq((await one("select monthly_cap_cents,per_user_daily_calls,enforced from ai_spend_limits")), { monthly_cap_cents: 15000, per_user_daily_calls: 40, enforced: true }, "caps and switch untouched");
await db.query("update ai_spend_limits set min_role='supervisor'");
await db.exec(await migration("20261024010000_installer_ai_floor.sql"));
eq((await one("select min_role from ai_spend_limits")).min_role, "supervisor", "an owner-raised floor is kept");
eq(await count("select count(*) n from app_release_notes where id like '2026-09-22-%'"), 4, "release notes present");
// Removing a login whose timing rows cascade must not be blocked by the epoch
// trigger recreating the person's epoch row (review 2, blocker 2).
const Z = id(12);
await db.query("insert into profiles(id,role,display_name) values($1,'installer','Zed')", [Z]);
await db.query("insert into task_sessions(profile_id,state,ended_at) values($1,'on_task',null),($1,'off_task',now())", [Z]);
ok(await count("select count(*) n from ai_clock_epochs where profile_id=$1", [Z]) === 1, "epoch row exists for the person");
await asUser(12);
const zReq = await begin(12, "what jobs are there");
await asAdmin();
await db.query("delete from profiles where id=$1", [Z]);
eq([await count("select count(*) n from profiles where id=$1", [Z]), await count("select count(*) n from ai_clock_epochs where profile_id=$1", [Z]),
  await count("select count(*) n from task_sessions where profile_id=$1", [Z]), await count("select count(*) n from ai_field_requests where id=$1", [zReq.rid])], [0, 0, 0, 0], "profile deletion cascades cleanly");

// --- Release 1 (20261031000000): start_unit_work AND start_idle_time wait for today's toolbox signature ---
// The new front door puts the unit-work gate on custom_work_command's unit
// start and the Prep-time gate on its no-unit start, which is where
// start_unit_work and start_idle_time land (ai_field_command →
// _ai_field_apply → custom_work_command). Loaded last, over the tables it
// touches that this harness had no need of until now; nobody above signed a
// talk, and nobody needed to.
await asAdmin();
await db.exec(`create table company_settings(id int primary key,updated_at timestamptz not null default now(),updated_by uuid); insert into company_settings(id) values(1);
create function _close_dangling_shift(p uuid) returns void language sql as $$update time_shifts set clock_out_at=now(),status='submitted' where profile_id=p and clock_out_at is null$$;
create table summons(id uuid primary key default gen_random_uuid(),project_id uuid,opening_id uuid,requested_by uuid,needed int,status text default 'open',created_at timestamptz default now());
create table summon_helpers(id uuid primary key default gen_random_uuid(),summon_id uuid,profile_id uuid,joined_at timestamptz default now(),completed_at timestamptz,canceled_at timestamptz,minutes int);
create table summon_declines(summon_id uuid,profile_id uuid,primary key(summon_id,profile_id));
create table points_ledger(id uuid primary key default gen_random_uuid(),profile_id uuid,kind text,points int,ref text,status text);`);
await db.exec(await migration("20261031000000_new_front_door.sql"));
const U77 = id(777);
await db.query("insert into custom_work_units(id,project_id,created_by,label,type_label) values($1,$2,$3,'77','Slider')", [U77, JOB, id(A)]);
await db.query("update custom_work_sessions set ended_at=now(),end_reason='stop' where ended_at is null");
await clockIn(A, JOB);
// Clocked in, unsigned (as Start day allows from the owner's date): the unit
// start is refused with the one plain sentence, and nothing starts.
const unsigned77 = await begin(A, "start unit 77");
await denied(() => cmd(unsigned77.rid, "start:77", "start_unit", { project_id: JOB, unit_id: U77, stage: "Installing", participation: "install" }), /Sign today's toolbox talk before starting work on a unit/);
await asAdmin();
eq(await count("select count(*) n from custom_work_sessions where unit_id=$1", [U77]), 0, "an unsigned start wrote no session");
// Prep time waits for the same signature, in its own sentence (owner, 2026-09-24).
await settle(A);
const unsignedPrep = await begin(A, "hauling");
await denied(() => cmd(unsignedPrep.rid, "idle:hauling", "start_idle", { description: "Hauling" }), /Sign today's toolbox talk before starting work\./);
await asAdmin();
eq(await count("select count(*) n from custom_work_sessions where profile_id=$1 and kind='idle' and ended_at is null", [id(A)]), 0, "an unsigned prep start wrote no session");
// Signed: prep time starts exactly as before, and the unit request then runs
// exactly as before (ending the prep timer).
await db.query("insert into toolbox_completions values($1,now())", [id(A)]);
await settle(A);
let prep = await cmd((await begin(A, "hauling")).rid, "idle:hauling", "start_idle", { description: "Hauling" });
eq([prep.status, prep.stage], ["running", "Idle time"], "signed, start_idle_time runs as before");
await settle(A);
let signedStart = await cmd((await begin(A, "start unit 77")).rid, "start:77", "start_unit", { project_id: JOB, unit_id: U77, stage: "Installing", participation: "install" });
eq([signedStart.status, signedStart.outcome, signedStart.previous_timer_ended], ["running", "started", true], "signed, start_unit_work runs as before");
await db.close();
console.log(`${checks} AI field-operation SQL assertions passed against the actual custom-work, crew-record, AI field and new-front-door migrations. Platform auth, storage, sandbox fence and clock RPCs are stubs; single-connection PGlite cannot exercise true concurrent transactions. No production writes.`);
