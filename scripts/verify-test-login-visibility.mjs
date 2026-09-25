// Disposable SQL checks for who can see a testing job: the projects read rule
// before and after 20261030030000 (a test login that is a current crew login
// sees a job that is both a testing project and on the sandbox list). No
// network, no production database: the real migrations over stubs of the
// platform (auth, profiles, the sandbox list, partner grants, the role helpers).
//   PGLITE_MODULE=/path/to/pglite/dist/index.js node scripts/verify-test-login-visibility.mjs
//
// The rule BEFORE is read out of 20260974000000 itself rather than restated,
// so "nobody else's access changes" is measured against what master really
// holds. The custom-work migration is applied for real too, so the child rows
// (custom units) are judged by their own policy, not a copy of it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const arg = process.argv.find((a) => a.startsWith("--pglite="));
const { PGlite } = await import(arg?.slice(9) ?? process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
process.on("uncaughtException", (e) => {
  console.error("FAILED after [" + globalThis.lastCheck + "]:", e.message,
    e.actual !== undefined ? JSON.stringify({ actual: e.actual, expected: e.expected }) : "");
  process.exit(1);
});
let checks = 0;
const check = (name) => { globalThis.lastCheck = name; checks++; };
const migration = (name) => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const NEW = "20261030030000_test_logins_see_practice_jobs.sql";

// The rule on master: the drop and create of projects_select_visible, cut out
// of the last migration that wrote it.
const before = await migration("20260974000000_job_deletion_supervisor.sql");
const start = before.indexOf('drop policy if exists "projects_select_visible" on projects;');
const end = before.indexOf("\n  );\n", start);
assert.ok(start >= 0 && end > start, "the rule on master was found in 20260974000000");
const OLD_RULE = before.slice(start, end + "\n  );\n".length);

// The current-crew-login check the new branch leans on, as master defines it
// today (20261024000000: partner, retired and revoked out; on-site does not
// matter). Cut out rather than restated, for the same reason as the rule.
const ai = await migration("20261024000000_ai_field_operations.sql");
const cwStart = ai.indexOf("create or replace function public.custom_work_internal()");
const cwEnd = ai.indexOf("\n$$;", cwStart);
assert.ok(cwStart >= 0 && cwEnd > cwStart, "custom_work_internal was found in 20261024000000");
const CREW_LOGIN = ai.slice(cwStart, cwEnd + "\n$$;".length);
assert.ok(/retired_at is null and access_revoked_at is null/.test(CREW_LOGIN) && /not public\.is_partner_user\(\)/.test(CREW_LOGIN),
  "the check cut out is the one that asks about partner, retired and revoked");

const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text not null,active boolean default true,is_partner boolean not null default false,is_test boolean not null default false,retired_at timestamptz,access_revoked_at timestamptz);
create table projects(id uuid primary key,job_code text not null,status text not null default 'active',is_test boolean not null default false,deleted_at timestamptz);
create table sandbox_projects(project_id uuid primary key references projects on delete cascade);
create table partner_job_grants(project_id uuid references projects on delete cascade,partner_profile_id uuid references profiles on delete cascade,primary key(project_id,partner_profile_id));
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
-- The helpers the rule calls, restated from 20260810000000, 20260950000000,
-- 20260730120000 and 20260730220000 (definer, pinned search_path, as there).
create function _is_supervisor(p uuid) returns boolean language sql stable security definer set search_path=public as $$select coalesce((select role in ('supervisor','owner','admin','big_boss') from profiles where id=p),false)$$;
create function is_partner_user() returns boolean language sql stable security definer set search_path=public as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer set search_path=public as $$select coalesce((select is_test from profiles where id=p),false)$$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer set search_path=public as $$select p is not null and exists(select 1 from sandbox_projects where project_id=p)$$;
create function _is_lead(p uuid) returns boolean language sql as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$select$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
alter table projects enable row level security;
grant select on profiles,projects,partner_job_grants to authenticated;
`);
await db.exec(await migration("20261011000000_custom_work.sql"));
await db.exec(CREW_LOGIN);
await db.exec(OLD_RULE);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// People. The two QA logins are the test-flagged current crew logins. The
// three after them carry the test flag too but are NOT current crew logins —
// a partner, a login whose access was revoked, a retired one — and a still-valid
// token must not carry any of them onto a testing job (Codex review of #657).
const PEOPLE = {
  installer: id(1), foreman: id(2), supervisor: id(3), owner: id(4), partner: id(5),
  "qa.installer": id(6), "qa.foreman": id(7),
  "test+partner": id(8), "test+revoked": id(9), "test+retired": id(10),
};
for (const [who, role] of [["installer", "installer"], ["foreman", "foreman"], ["supervisor", "supervisor"], ["owner", "owner"],
  ["partner", "installer"], ["qa.installer", "installer"], ["qa.foreman", "foreman"],
  ["test+partner", "installer"], ["test+revoked", "installer"], ["test+retired", "foreman"]]) {
  await db.query("insert into profiles(id,role) values($1,$2)", [PEOPLE[who], role]);
}
await db.query("update profiles set is_partner=true where id=any($1)", [[PEOPLE.partner, PEOPLE["test+partner"]]]);
await db.query("update profiles set is_test=true where id=any($1)",
  [[PEOPLE["qa.installer"], PEOPLE["qa.foreman"], PEOPLE["test+partner"], PEOPLE["test+revoked"], PEOPLE["test+retired"]]]);
await db.query("update profiles set access_revoked_at=now() where id=$1", [PEOPLE["test+revoked"]]);
await db.query("update profiles set retired_at=now() where id=$1", [PEOPLE["test+retired"]]);
const NOT_CURRENT = ["test+partner", "test+revoked", "test+retired"];
const TESTING = ["PRACTICE", "HIDDEN", "TRASHED", "GRANTED"];

// Jobs: every combination of testing / sandbox list / trash that matters.
const JOBS = {
  REAL: id(100),         // a real job
  PRACTICE: id(101),     // testing AND on the sandbox list: PECAN14's shape
  HIDDEN: id(102),       // testing, NOT on the sandbox list
  TRASHED: id(103),      // testing, on the sandbox list, in the trash
  ZZTEST: id(104),       // on the sandbox list, not flagged testing
  REALTRASH: id(105),    // a real job in the trash
  GRANTED: id(106),      // testing, granted to the partner, not on the list
};
for (const [code, uuid] of Object.entries(JOBS)) await db.query("insert into projects(id,job_code) values($1,$2)", [uuid, code]);
await db.query("update projects set is_test=true where id=any($1)", [[JOBS.PRACTICE, JOBS.HIDDEN, JOBS.TRASHED, JOBS.GRANTED]]);
await db.query("update projects set deleted_at=now() where id=any($1)", [[JOBS.TRASHED, JOBS.REALTRASH]]);
await db.query("insert into sandbox_projects values($1),($2),($3)", [JOBS.PRACTICE, JOBS.TRASHED, JOBS.ZZTEST]);
await db.query("insert into partner_job_grants values($1,$2)", [JOBS.GRANTED, PEOPLE.partner]);
// One custom unit on each live job the question is about: the rows the drill opens.
let unit = 200;
for (const job of [JOBS.REAL, JOBS.PRACTICE, JOBS.HIDDEN, JOBS.ZZTEST]) {
  await db.query("insert into custom_work_units(id,project_id,created_by,label) values($1,$2,$3,'unit')", [id(unit++), job, PEOPLE.owner]);
}

const codeOf = Object.fromEntries(Object.entries(JOBS).map(([code, uuid]) => [uuid, code]));
async function as(uuid) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uuid ?? ""]);
  await db.exec("set role authenticated");
}
async function seen(uuid) {
  await as(uuid);
  const rows = (await db.query("select job_code from projects order by job_code")).rows;
  await db.exec("reset role");
  return rows.map((r) => r.job_code).sort();
}
async function unitsSeen(uuid) {
  await as(uuid);
  const rows = (await db.query("select project_id from custom_work_units")).rows;
  await db.exec("reset role");
  return rows.map((r) => codeOf[r.project_id]).sort();
}
// One person at a time: the role and the caller are session settings, so two
// readers interleaved would read as each other.
async function everyone() {
  const out = {};
  for (const [who, uuid] of Object.entries(PEOPLE)) out[who] = await seen(uuid);
  return out;
}

// ---- before: the rule on master ------------------------------------------------
const old = await everyone();
check("before: a test login cannot see the practice job it may write (the bug)");
assert.deepEqual(old["qa.installer"], ["REAL", "ZZTEST"]);
assert.deepEqual(old["qa.foreman"], ["REAL", "ZZTEST"]);
check("before: nor the practice job's units");
assert.deepEqual(await unitsSeen(PEOPLE["qa.installer"]), ["REAL", "ZZTEST"]);

// ---- after: the migration --------------------------------------------------------
await db.exec(await migration(NEW));
const now = await everyone();

for (const who of ["qa.installer", "qa.foreman"]) {
  check(`after: ${who} sees the practice job, and nothing else new`);
  assert.deepEqual(now[who], ["PRACTICE", "REAL", "ZZTEST"]);
  check(`after: ${who} gains exactly the job that is testing AND on the sandbox list`);
  assert.deepEqual(now[who].filter((c) => !old[who].includes(c)), ["PRACTICE"]);
  assert.deepEqual(old[who].filter((c) => !now[who].includes(c)), []);
  check(`after: ${who} still cannot see a testing job off the sandbox list, a trashed practice job, or a partner's granted testing job`);
  for (const hidden of ["HIDDEN", "TRASHED", "GRANTED", "REALTRASH"]) assert.ok(!now[who].includes(hidden), hidden);
  check(`after: ${who} opens the practice job's units, and still not the hidden testing job's`);
  assert.deepEqual(await unitsSeen(PEOPLE[who]), ["PRACTICE", "REAL", "ZZTEST"]);
}
for (const who of ["installer", "foreman", "supervisor", "owner", "partner", ...NOT_CURRENT]) {
  check(`after: ${who} sees exactly the jobs the rule on master showed`);
  assert.deepEqual(now[who], old[who]);
}
for (const who of NOT_CURRENT) {
  check(`after: ${who} — test-flagged but not a current crew login — sees no testing job, the practice job included`);
  assert.deepEqual(now[who].filter((c) => TESTING.includes(c)), []);
  assert.deepEqual(now[who], ["REAL", "ZZTEST"]);
  check(`after: ${who} opens none of the practice job's units`);
  assert.ok(!(await unitsSeen(PEOPLE[who])).includes("PRACTICE"));
}
check("after: a real installer still never sees a testing job, the practice job included");
assert.deepEqual(now.installer, ["REAL", "ZZTEST"]);
assert.deepEqual(await unitsSeen(PEOPLE.installer), ["REAL", "ZZTEST"]);
check("after: a supervisor still sees every job, trash included");
assert.deepEqual(now.supervisor, Object.keys(JOBS).sort());
check("after: the partner still sees its granted testing job, and not the practice job");
assert.ok(now.partner.includes("GRANTED") && !now.partner.includes("PRACTICE"));

// ---- the exception is the flag, not the name or the role ---------------------------
check("a test login whose flag is cleared loses the practice job again");
await db.query("update profiles set is_test=false where id=$1", [PEOPLE["qa.installer"]]);
assert.deepEqual(await seen(PEOPLE["qa.installer"]), ["REAL", "ZZTEST"]);
assert.deepEqual(await unitsSeen(PEOPLE["qa.installer"]), ["REAL", "ZZTEST"]);
await db.query("update profiles set is_test=true where id=$1", [PEOPLE["qa.installer"]]);
check("a practice job taken off the sandbox list disappears for a test login");
await db.query("delete from sandbox_projects where project_id=$1", [JOBS.PRACTICE]);
assert.deepEqual(await seen(PEOPLE["qa.foreman"]), ["REAL", "ZZTEST"]);
await db.query("insert into sandbox_projects values($1)", [JOBS.PRACTICE]);
check("a practice job unflagged as testing is a real sandbox job: visible to everyone, as ZZTEST is");
await db.query("update projects set is_test=false where id=$1", [JOBS.PRACTICE]);
assert.deepEqual(await seen(PEOPLE.installer), ["PRACTICE", "REAL", "ZZTEST"]);
await db.query("update projects set is_test=true where id=$1", [JOBS.PRACTICE]);
// The branch's own `is_test` is implied for every row the NOT NULL column
// allows (a job whose flag is false already passed `is_test = false`), so
// deleting it changes nothing on this database. What it still decides is a
// flag that is unknown: were the column ever nullable, a NULL job on the
// sandbox list would otherwise count as a practice job for a test login. That
// is the one place removing it shows, so it is checked here, on a copy of the
// table's rule with the constraint lifted for one row and put back.
check("if a job's testing flag could be unknown (it cannot: NOT NULL), a test login would not see it as a practice job");
await db.exec("alter table projects alter column is_test drop not null");
await db.query("insert into projects(id,job_code,is_test) values($1,'UNKNOWN',null)", [id(107)]);
await db.query("insert into sandbox_projects values($1)", [id(107)]);
assert.ok(!(await seen(PEOPLE["qa.installer"])).includes("UNKNOWN"));
await db.query("delete from projects where id=$1", [id(107)]);
await db.exec("alter table projects alter column is_test set not null");
check("a signed-in role with no caller id gets no testing job from the new branch (a NULL uid is not a test login)");
assert.deepEqual(await seen(null), ["REAL", "ZZTEST"]);

// ---- the migration is safe to run twice ------------------------------------------
check("applied twice, the rule is the same and there is still one read rule on projects");
await db.exec(await migration(NEW));
assert.deepEqual(await everyone(), now);
assert.equal((await db.query("select count(*)::int as n from pg_policies where tablename='projects' and cmd='SELECT'")).rows[0].n, 1);
check("the migration adds no function (so none a signed-out caller could run)");
assert.ok(!/create\s+(or\s+replace\s+)?function/i.test(await migration(NEW)));

await db.close();
console.log(`${checks} test-login visibility checks passed: the rule on master (read from 20260974000000) against ${NEW}, with the real custom-work unit policy. Helpers are restated stubs; no production database.`);
