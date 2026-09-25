// Disposable SQL checks for what a partner (builder) login may read on
// `projects`: the rule on master before 20261030100000 against the rule it
// writes. A partner reads a job only when the job is live and granted to that
// login; nobody else's view of the jobs moves by a row. No network and no
// production database: the real migrations over stubs of the platform (auth,
// profiles, the role helpers).
//   PGLITE_MODULE=/path/to/pglite/dist/index.js node scripts/verify-partner-visibility.mjs
//
// Real, not restated: partner_job_grants with its owner-only read rule (cut
// out of 20260950000000, because that rule is half of why the grant check
// needs a definer), the rules on master (cut out of the migrations that last
// wrote them, the read rule from whichever migration before this one wrote it
// last), the custom-work migration (a child table judged by its own policy,
// and custom_work_internal() for the test-login branch), and 20261030100000
// itself, whole. A LATER migration that rebuilds the jobs read rule is applied
// on top, so a future rebuild that drops the grant condition, or lets a crew
// branch reach a partner, fails here too.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const arg = process.argv.find((a) => a.startsWith("--pglite="));
const { PGlite } = await import(arg?.slice(9) ?? process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
process.on("uncaughtException", (e) => {
  console.error("FAILED after [" + globalThis.lastCheck + "]:", e.message,
    e.actual !== undefined ? JSON.stringify({ actual: e.actual, expected: e.expected }) : "");
  process.exit(1);
});
let checks = 0;
const check = (name) => { globalThis.lastCheck = name; checks++; };
const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
const migration = (name) => readFile(new URL(name, MIGRATIONS), "utf8");
const NEW = "20261030100000_partner_sees_granted_jobs_only.sql";

// One statement cut out of a migration: from `from` to the end of the first
// statement that starts with `create`, or to `until` when given.
function cut(text, from, create, until) {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `found ${JSON.stringify(from.slice(0, 60))}`);
  if (until) {
    const end = text.indexOf(until, start);
    assert.ok(end > start, `found ${JSON.stringify(until.slice(0, 60))}`);
    return text.slice(start, end + until.length);
  }
  const at = text.indexOf(create, start);
  const end = text.indexOf(";", at);
  assert.ok(at > start && end > at, `found ${JSON.stringify(create)}`);
  return text.slice(start, end + 1);
}
const READ_DROP = 'drop policy if exists "projects_select_visible" on projects;';
const READ_CREATE = 'create policy "projects_select_visible"';
// The read rule on master: the last migration before this one that wrote it.
const ALL = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
let MASTER_READ = null, MASTER_FILE = null;
for (const f of ALL.filter((f) => f < NEW)) {
  const text = await migration(f);
  if (text.includes(READ_CREATE)) { MASTER_READ = cut(text, READ_DROP, READ_CREATE); MASTER_FILE = f; }
}
assert.ok(MASTER_READ, "found the read rule on master");
const GRANTS = cut(await migration("20260950000000_partner_wall.sql"),
  "create table if not exists partner_job_grants (", null,
  "grant select on table partner_job_grants to authenticated;");
const NEW_SQL = await migration(NEW);
const NEW_READ = cut(NEW_SQL, READ_DROP, READ_CREATE);
// The last migration after this one that rebuilds the jobs read rule, if any.
const later = ALL.filter((f) => f > NEW);
let LATEST_READ = null, LATEST_FILE = null;
for (const f of later) {
  const text = await migration(f);
  if (text.includes(READ_CREATE)) { LATEST_READ = cut(text, READ_DROP, READ_CREATE); LATEST_FILE = f; }
}

const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text not null,active boolean default true,is_partner boolean not null default false,is_test boolean not null default false,retired_at timestamptz,access_revoked_at timestamptz);
create table projects(id uuid primary key default gen_random_uuid(),job_code text not null,name text not null default 'job',notes text,status text not null default 'active',is_test boolean not null default false,deleted_at timestamptz);
create table sandbox_projects(project_id uuid primary key references projects on delete cascade);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
-- The helpers the rules call, restated from 20260729200000, 20260810000000,
-- 20260950000000, 20260730120000 and 20260730220000 (definer, pinned
-- search_path, as there). Ranks: installer 0, foreman 1, supervisor 2, owner 3.
create function role_rank(r text) returns int language sql immutable as $$select case r when 'owner' then 3 when 'supervisor' then 2 when 'foreman' then 1 when 'installer' then 0 end$$;
create function my_role_rank() returns int language sql stable security definer set search_path=public as $$select role_rank((select role from profiles where id=auth.uid()))$$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer set search_path=public as $$select coalesce((select role in ('supervisor','owner','admin','big_boss') from profiles where id=p),false)$$;
create function is_partner_user() returns boolean language sql stable security definer set search_path=public as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer set search_path=public as $$select coalesce((select is_test from profiles where id=p),false)$$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer set search_path=public as $$select p is not null and exists(select 1 from sandbox_projects where project_id=p)$$;
create function _is_lead(p uuid) returns boolean language sql as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$select$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
alter table projects enable row level security;
grant select on profiles,projects to authenticated;
`);
await db.exec(GRANTS);
await db.exec(await migration("20261011000000_custom_work.sql"));
await db.exec(MASTER_READ);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Crew (the two QA test logins among them), and three partners: A holds
// three grants, B one, C none.
const CREW = { owner: id(1), supervisor: id(2), foreman: id(3), installer: id(4), qaInstaller: id(8), qaForeman: id(9) };
const PARTNERS = { partnerA: id(5), partnerB: id(6), partnerC: id(7) };
const PEOPLE = { ...CREW, ...PARTNERS };
for (const [who, role] of [["owner", "owner"], ["supervisor", "supervisor"], ["foreman", "foreman"], ["installer", "installer"],
  ["qaInstaller", "installer"], ["qaForeman", "foreman"],
  ["partnerA", "installer"], ["partnerB", "installer"], ["partnerC", "installer"]]) {
  await db.query("insert into profiles(id,role,is_partner,is_test) values($1,$2,$3,$4)",
    [PEOPLE[who], role, who.startsWith("partner"), who.startsWith("qa")]);
}
const JOBS = {
  REAL_A: id(100),       // live, real, granted to partnerA
  REAL_B: id(101),       // live, real, granted to partnerB
  REAL_NONE: id(102),    // live, real, granted to nobody
  TEST_A: id(103),       // a testing job granted to partnerA
  TEST_NONE: id(104),    // a testing job granted to nobody
  TRASH_A: id(105),      // a real job in the trash, granted to partnerA
  PRACTICE: id(106),     // a testing job on the sandbox list (the practice job)
};
for (const [code, uuid] of Object.entries(JOBS)) await db.query("insert into projects(id,job_code) values($1,$2)", [uuid, code]);
await db.query("update projects set is_test=true where id=any($1)", [[JOBS.TEST_A, JOBS.TEST_NONE, JOBS.PRACTICE]]);
await db.query("update projects set deleted_at=now() where id=$1", [JOBS.TRASH_A]);
await db.query("insert into sandbox_projects values($1)", [JOBS.PRACTICE]);
for (const [partner, job] of [["partnerA", "REAL_A"], ["partnerA", "TEST_A"], ["partnerA", "TRASH_A"], ["partnerB", "REAL_B"]]) {
  await db.query("insert into partner_job_grants(partner_profile_id,project_id,granted_by) values($1,$2,$3)", [PARTNERS[partner], JOBS[job], CREW.owner]);
}
let unit = 200;
for (const job of Object.values(JOBS)) {
  await db.query("insert into custom_work_units(id,project_id,created_by,label) values($1,$2,$3,'unit')", [id(unit++), job, CREW.owner]);
}

const codeOf = Object.fromEntries(Object.entries(JOBS).map(([code, uuid]) => [uuid, code]));
async function as(uuid) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uuid ?? ""]);
  await db.exec("set role authenticated");
}
async function read(uuid, sql, params = []) {
  await as(uuid);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const seen = async (uuid) => (await read(uuid, "select id from projects")).map((r) => codeOf[r.id] ?? "NEW").sort();
const unitsSeen = async (uuid) => (await read(uuid, "select project_id from custom_work_units")).map((r) => codeOf[r.project_id]).sort();
// One person at a time: the role and the caller are session settings.
async function everyone() {
  const out = {};
  for (const [who, uuid] of Object.entries(PEOPLE)) out[who] = { jobs: await seen(uuid), units: await unitsSeen(uuid) };
  return out;
}
// What each partner should read: its own grants, live ones only, testing ones included.
const GRANTED = { partnerA: ["REAL_A", "TEST_A"], partnerB: ["REAL_B"], partnerC: [] };
function partnerProblems(snapshot) {
  const bad = [];
  for (const who of Object.keys(PARTNERS)) {
    if (JSON.stringify(snapshot[who].jobs) !== JSON.stringify(GRANTED[who])) bad.push(`${who} reads ${snapshot[who].jobs.join(",") || "nothing"}`);
    if (snapshot[who].units.length) bad.push(`${who} reads units on ${snapshot[who].units.join(",")}`);
  }
  return bad;
}
async function useRead(ruleSql) {
  await db.exec("reset role");
  await db.exec(ruleSql);
}

// ---- before: the rule on master ------------------------------------------------
const old = await everyone();

// ---- after: the migration, and any later rebuild of the read rule ------------------
await db.exec(NEW_SQL);
if (LATEST_READ) await useRead(LATEST_READ);
const now = await everyone();
const rule = LATEST_FILE ? `${NEW} + the read rule of ${LATEST_FILE}` : NEW;
const master = `the rule on master (from ${MASTER_FILE})`;

for (const who of Object.keys(CREW)) {
  check(`after (${rule}): ${who} reads exactly the jobs, and the custom units, it read before`);
  assert.deepEqual(now[who], old[who]);
}
check("after: a supervisor and the owner still read every job, trash and testing jobs included");
assert.deepEqual(now.supervisor.jobs, Object.keys(JOBS).sort());
assert.deepEqual(now.owner.jobs, Object.keys(JOBS).sort());
check("after: an installer and a foreman still read every live real job and no testing job");
assert.deepEqual(now.installer.jobs, ["REAL_A", "REAL_B", "REAL_NONE"]);
assert.deepEqual(now.foreman.jobs, ["REAL_A", "REAL_B", "REAL_NONE"]);
check("after: the QA test logins still read the practice job on the sandbox list, and no other testing job");
assert.deepEqual(now.qaInstaller.jobs, ["PRACTICE", "REAL_A", "REAL_B", "REAL_NONE"]);
assert.deepEqual(now.qaForeman.jobs, ["PRACTICE", "REAL_A", "REAL_B", "REAL_NONE"]);
check("after: each partner reads exactly its own live grants (a granted testing job included) and no custom unit anywhere");
assert.deepEqual(partnerProblems(now), []);
check("after: a partner with no grants reads no job at all");
assert.deepEqual(now.partnerC.jobs, []);
check("after: one partner's grant is invisible to another");
assert.ok(!now.partnerA.jobs.includes("REAL_B") && !now.partnerB.jobs.includes("REAL_A"));
check("after: a granted job in the trash stays hidden from its partner");
assert.ok(!now.partnerA.jobs.includes("TRASH_A"));

// ---- the rule answers to the grant, the partner flag and the trash, live -------------------
check("a grant revoked hides the job at once; a grant added shows it");
await db.query("delete from partner_job_grants where partner_profile_id=$1 and project_id=$2", [PARTNERS.partnerA, JOBS.REAL_A]);
await db.query("insert into partner_job_grants(partner_profile_id,project_id,granted_by) values($1,$2,$3)", [PARTNERS.partnerA, JOBS.REAL_NONE, CREW.owner]);
assert.deepEqual(await seen(PARTNERS.partnerA), ["REAL_NONE", "TEST_A"]);
await db.query("delete from partner_job_grants where partner_profile_id=$1 and project_id=$2", [PARTNERS.partnerA, JOBS.REAL_NONE]);
await db.query("insert into partner_job_grants(partner_profile_id,project_id,granted_by) values($1,$2,$3)", [PARTNERS.partnerA, JOBS.REAL_A, CREW.owner]);
assert.deepEqual(await seen(PARTNERS.partnerA), GRANTED.partnerA);
check("a partner whose role column says supervisor still reads only its live grants: being a partner decides, not the role");
await db.query("update profiles set role='supervisor' where id=$1", [PARTNERS.partnerB]);
assert.deepEqual(await seen(PARTNERS.partnerB), GRANTED.partnerB);
assert.deepEqual(await unitsSeen(PARTNERS.partnerB), []);
await db.query("update profiles set role='installer' where id=$1", [PARTNERS.partnerB]);
check("a partner that also carries the test flag reads its grants and not the practice job");
await db.query("update profiles set is_test=true where id=$1", [PARTNERS.partnerA]);
assert.deepEqual(await seen(PARTNERS.partnerA), GRANTED.partnerA);
await db.query("update profiles set is_test=false where id=$1", [PARTNERS.partnerA]);
check("the partner flag cleared, the same login reads what an installer reads, as before");
await db.query("update profiles set is_partner=false where id=$1", [PARTNERS.partnerC]);
assert.deepEqual(await seen(PARTNERS.partnerC), now.installer.jobs);
await db.query("update profiles set is_partner=true where id=$1", [PARTNERS.partnerC]);
check("a signed-in role with no caller id reads what it read before (no job is granted to a NULL id)");
const anonymousAfter = await seen(null);
await useRead(MASTER_READ);
assert.deepEqual(anonymousAfter, await seen(null));
await useRead(LATEST_READ ?? NEW_READ);

// ---- the helper -------------------------------------------------------------------------------
check("partner_has_job_grant answers only about the caller's own grants");
const asks = async (who, job) => (await read(PEOPLE[who], "select public.partner_has_job_grant($1) as g", [JOBS[job]]))[0].g;
assert.equal(await asks("partnerA", "REAL_A"), true);
assert.equal(await asks("partnerA", "REAL_B"), false);
assert.equal(await asks("partnerB", "REAL_B"), true);
assert.equal(await asks("owner", "REAL_A"), false);
check("partner_has_job_grant is a definer with a pinned search_path, runnable signed in and never signed out");
const fn = (await db.query(`select prosecdef, proconfig from pg_proc where proname='partner_has_job_grant'`)).rows[0];
assert.equal(fn.prosecdef, true);
assert.ok((fn.proconfig ?? []).some((c) => /^search_path=public, pg_temp$/.test(c)), JSON.stringify(fn.proconfig));
const can = async (role) => (await db.query(`select has_function_privilege($1,'public.partner_has_job_grant(uuid)','execute') as x`, [role])).rows[0].x;
assert.equal(await can("anon"), false);
assert.equal(await can("authenticated"), true);
check("partner_job_grants itself stays unreadable to a partner, as THE WALL built it");
assert.deepEqual(await read(PARTNERS.partnerA, "select * from partner_job_grants"), []);

// ---- the checks above catch a rule that loses the grant condition -----------------------------
// Each broken copy of the rule is applied for real and must make the partner
// checks fail. A copy that no longer differs from the rule is itself a failure,
// so an edit that renames the helper cannot quietly turn these into no-ops.
async function mustCatch(label, broken) {
  check(`the partner checks catch a rule that ${label}`);
  assert.notEqual(broken, NEW_READ, `could not build the rule that ${label}`);
  await useRead(broken);
  const snap = await everyone();
  await useRead(LATEST_READ ?? NEW_READ);
  assert.notDeepEqual(partnerProblems(snap), [], `a rule that ${label} passed the partner checks`);
}
await mustCatch("drops the grant condition",
  NEW_READ.replace("and public.partner_has_job_grant(projects.id)", ""));
await mustCatch("asks the grant through an inline select, under the partner's own row security",
  NEW_READ.replace("public.partner_has_job_grant(projects.id)",
    "exists (select 1 from partner_job_grants g where g.project_id = projects.id and g.partner_profile_id = auth.uid())"));
await mustCatch("lets the crew branches reach a partner",
  NEW_READ.replace("not public.is_partner_user()\n        and (\n", "(\n"));
check("and the rule itself is back in place and still passes");
assert.deepEqual(partnerProblems(await everyone()), []);

// ---- the migration is safe to run twice ------------------------------------------------------
check("applied twice, the rule is the same and there is still one read rule on projects");
await db.exec(NEW_SQL);
if (LATEST_READ) await useRead(LATEST_READ);
assert.deepEqual(await everyone(), now);
assert.equal((await db.query("select count(*)::int as n from pg_policies where tablename='projects' and cmd='SELECT'")).rows[0].n, 1);

await db.close();
console.log(`${checks} partner visibility checks passed: ${master} against ${rule}, with the real partner_job_grants rule and the real custom-work unit policy. Helpers are restated stubs; no production database.`);
