// Disposable SQL checks for 20261049000000_foreman_unit_contributors.sql,
// against both the real custom-work base migration (20261011000000) and the
// real existing crew-ledger migration (20261023000000) — the same pattern
// verify-crew-unit-records.mjs uses. No network or production database
// connection. Auth and sandbox-visibility helpers here are fixture stubs
// that mirror the real functions' intent (retired_at/access_revoked_at,
// is_partner, is_test-partition, job deleted/visible); they are not the
// production definitions, which are covered by `scripts/db-dry-run.sh`.
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
create table profiles(id uuid primary key,role text,retired_at timestamptz,access_revoked_at timestamptz,is_partner boolean default false,is_test boolean default false);
create table projects(id uuid primary key,deleted_at timestamptz,is_test boolean default false);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz,opening_code text,window_type_id uuid);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
create function is_partner_user() returns boolean language sql security definer as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql as $$select coalesce((select is_test from profiles where id=p),false)$$;
-- Approximates the real rule: a test login sees only test jobs; a real login
-- sees only non-test jobs unless supervisor+. Not is_sandbox_project() itself.
create function _ai_job_visible(p_job uuid,p_uid uuid) returns boolean language sql as $$
  select exists(select 1 from projects p where p.id=p_job and p.deleted_at is null and (
    case when (select is_test from profiles where id=p_uid) then coalesce(p.is_test,false)
         else not coalesce(p.is_test,false) or exists(select 1 from profiles where id=p_uid and role in ('supervisor','owner')) end))
$$;
create function _ai_plan_facts(p_opening uuid) returns jsonb language sql as $$select jsonb_build_object('type_label','Bifold door')$$;
create function _ai_plan_seed(p_plan jsonb) returns jsonb language sql as $$select '{}'::jsonb$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
grant select on profiles,projects to authenticated;
`);
// Load the REAL base migration first — it CREATEs custom_work_internal()
// itself (against profiles.active, which this fixture does not carry; that
// body is dead code and is never executed, since check_function_bodies=off
// skips validating it at CREATE time and the override below replaces it
// before any query runs). Predefining the same function ahead of this file
// collided with it under its own name (Astra review: harness loading order).
await db.exec(
  await readFile(new URL("../supabase/migrations/20261011000000_custom_work.sql", import.meta.url), "utf8"),
);
// The effective replacement 20261024000000_ai_field_operations.sql makes in
// production (retired_at/access_revoked_at access, not the Off-today switch)
// — restated here rather than loading that 1269-line file's unrelated
// AI-field schema just for this one function.
await db.exec(`
create or replace function public.custom_work_internal() returns boolean language sql stable as $$
  select auth.uid() is not null and not public.is_partner_user() and exists(select 1 from profiles where id=auth.uid() and retired_at is null and access_revoked_at is null and role in ('installer','foreman','supervisor','owner'))
$$;
`);
await db.exec(
  "create trigger unit_sessions_follow_shift after update on time_shifts for each row execute function unit_sessions_follow_shift()",
);
await db.exec(`create table app_release_notes(id text,published_on date,audience int[],kind text,title_en text,title_es text,body_en text,body_es text,href text);`);
await db.exec(await readFile(new URL("../supabase/migrations/20261023000000_foreman_crew_unit_records.sql", import.meta.url), "utf8"));
await db.exec(await readFile(new URL("../supabase/migrations/20261049000000_foreman_unit_contributors.sql", import.meta.url), "utf8"));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.query(
  `insert into profiles(id,role,retired_at,access_revoked_at,is_partner,is_test) values
   ($1,'foreman',null,null,false,false),
   ($2,'installer',null,null,false,false),
   ($3,'installer',null,null,false,false),
   ($4,'installer',now(),null,false,false),
   ($5,'installer',null,now(),false,false),
   ($6,'installer',null,null,true,false),
   ($7,'owner',null,null,true,false),
   ($8,'installer',null,null,false,true),
   ($9,'installer',null,null,false,false)`,
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id),
);
await db.query("insert into projects(id,deleted_at,is_test) values ($1,null,false),($2,null,false),($3,now(),false)", [id(10), id(11), id(12)]);
await db.query("insert into project_openings(id,project_id,opening_code) values ($1,$2,'MAP-7')", [id(20), id(10)]);

let n = 100,
  checks = 0;
async function asUser(i) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [i ? id(i) : ""]);
  await db.exec("set role authenticated");
}
async function record(data, key = id(n++)) {
  return (await db.query("select record_stage_contributors($1,$2) id", [key, data])).rows[0].id;
}
async function correct(data, key = id(n++)) {
  return (await db.query("select correct_stage_contributors($1,$2) id", [key, data])).rows[0].id;
}
async function digest(unit, stage, workDate) {
  const r = await db.query("select digest from stage_contributor_summary($1) where stage=$2 and work_date=$3 limit 1", [unit, stage, workDate]);
  return r.rows[0].digest;
}
async function effective(unit, stage, workDate) {
  const r = await db.query("select profile_id from stage_contributor_summary($1) where stage=$2 and work_date=$3 order by profile_id", [unit, stage, workDate]);
  return r.rows.map((x) => x.profile_id);
}
async function denied(fn) {
  await assert.rejects(fn);
  checks++;
}

// 1. A saved unit, two installers, RO check for yesterday, off the clock.
// (Seeded as the system — custom_work_units has no INSERT grant for any
// client role; every real write goes through custom_work_command/this file's
// RPCs, which is exactly what the rest of this script exercises.)
const unitId = (
  await db.query(
    "insert into custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts) values ($1,$2,null,$3,'16','Bifold door','{}') returning id",
    [id(40), id(10), id(1)],
  )
).rows[0].id;
await asUser(1);
const base = { unit_id: unitId, stage: "RO checked", work_date: "2026-09-29", outcome: "finished", people: [id(2), id(3)] };
assert.equal(await record(base, id(500)), unitId);
checks++;
assert.deepEqual((await effective(unitId, "RO checked", "2026-09-29")).sort(), [id(2), id(3)].sort());
checks++;

// 2. Replay: same request id, same (reordered) payload → same result, no new rows.
assert.equal(await record({ ...base, people: [id(3), id(2)] }, id(500)), unitId);
checks++;
assert.equal((await db.query("select count(*) n from crew_work_record_people")).rows[0].n, 2);
checks++;
// A different payload under the same id is refused, not silently applied.
await denied(() => record({ ...base, description: "changed" }, id(500)));

// 3. Overlapping: Bob (id2) + Carol (id9) on a fresh id → only Carol is new.
assert.equal(await record({ ...base, people: [id(2), id(9)] }, id(501)), unitId);
checks++;
assert.deepEqual((await effective(unitId, "RO checked", "2026-09-29")).sort(), [id(2), id(3), id(9)].sort());
checks++;
assert.equal((await db.query("select count(*) n from crew_work_record_people where record_id=$1", [id(501)])).rows[0].n, 1);
checks++;

// 4. Exact repeat with an entirely fresh id creates no participants/report row.
assert.equal(await record({ ...base, people: [id(3), id(2)] }, id(502)), unitId);
checks++;
assert.equal((await db.query("select * from crew_work_record_people where record_id=$1", [id(502)])).rows.length, 0);
checks++;

// 5. A mapped opening with no saved unit yet creates exactly one companion,
//    even across two separate requests racing the same opening.
await Promise.all([
  record({ opening_id: id(20), stage: "Flashing", work_date: "2026-09-28", outcome: "partial", people: [id(2)] }, id(503)),
  record({ opening_id: id(20), stage: "Flashing", work_date: "2026-09-28", outcome: "partial", people: [id(3)] }, id(504)),
]);
checks++;
const mapped = (await db.query("select id from custom_work_units where opening_id=$1", [id(20)])).rows;
assert.equal(mapped.length, 1);
checks++;
assert.deepEqual((await effective(mapped[0].id, "Flashing", "2026-09-28")).sort(), [id(2), id(3)].sort());
checks++;

// 6. Eligibility and access refusals: no partial writes from any of these.
const before = (await db.query("select count(*) n from crew_work_record_people")).rows[0].n;
for (const bad of [[id(4)], [id(5)], [id(6)], [id(7)], [id(8)], [null]])
  await denied(() => record({ ...base, work_date: "2026-09-27", people: bad }));
await denied(() => record({ ...base, work_date: "2099-01-01" }));
await denied(() => record({ ...base, work_date: "2026-09-27", unit_id: null, opening_id: null }));
await denied(() => record({ ...base, work_date: "2026-09-27", unit_id: unitId, opening_id: id(20) }));
await db.exec("reset role");
const deletedJobUnit = (
  await db.query("insert into custom_work_units(id,project_id,created_by,label) values (gen_random_uuid(),$1,$2,'x') returning id", [id(12), id(1)])
).rows[0].id;
await asUser(1);
await denied(() => record({ unit_id: deletedJobUnit, stage: "RO checked", work_date: "2026-09-27", outcome: "finished", people: [id(2)] }));
assert.equal((await db.query("select count(*) n from crew_work_record_people")).rows[0].n, before);
checks++;

// 7. Only an active foreman+ can file; an installer and an anonymous caller cannot.
await asUser(2);
await denied(() => record({ ...base, work_date: "2026-09-27" }));
await asUser(null);
await denied(() => record({ ...base, work_date: "2026-09-27" }));
await asUser(1);

// 8. Correction: void Bob with a reason, add Dave (id3 already present — use a
//    fresh eligible person) as a replacement, under the digest the read handed back.
const liveDigest = await digest(unitId, "RO checked", "2026-09-29");
await denied(() =>
  correct({ unit_id: unitId, stage: "RO checked", work_date: "2026-09-29", expected_digest: "stale", reason: "Left the site early", remove: [id(2)] }),
);
await denied(() =>
  correct({ unit_id: unitId, stage: "RO checked", work_date: "2026-09-29", expected_digest: liveDigest, reason: "", remove: [id(2)] }),
);
assert.equal(
  await correct({ unit_id: unitId, stage: "RO checked", work_date: "2026-09-29", expected_digest: liveDigest, reason: "Did not actually work this unit", remove: [id(2)] }),
  unitId,
);
checks++;
assert.deepEqual((await effective(unitId, "RO checked", "2026-09-29")).sort(), [id(3), id(9)].sort());
checks++;
assert.equal(
  (await db.query("select voided_by,void_reason from crew_work_record_people p join crew_work_records r on r.id=p.record_id where r.unit_id=$1 and p.profile_id=$2 and r.stage='RO checked' and r.work_date='2026-09-29'", [unitId, id(2)])).rows[0].void_reason,
  "Did not actually work this unit",
);
checks++;

// 9. The ORIGINAL add request, replayed with its original id/payload after the
//    correction voided that person, does not resurrect them.
assert.equal(await record(base, id(500)), unitId);
checks++;
assert.deepEqual((await effective(unitId, "RO checked", "2026-09-29")).sort(), [id(3), id(9)].sort());
checks++;

// 10. Correction can add someone back under the fresh digest.
const digest2 = await digest(unitId, "RO checked", "2026-09-29");
assert.equal(
  await correct({ unit_id: unitId, stage: "RO checked", work_date: "2026-09-29", expected_digest: digest2, reason: "Confirmed with the crew", add: [id(2)], outcome: "finished" }),
  unitId,
);
checks++;
assert.deepEqual((await effective(unitId, "RO checked", "2026-09-29")).sort(), [id(2), id(3), id(9)].sort());
checks++;

// 11. No clock, timer or payroll table was ever touched by any of the above.
await db.exec("reset role");
for (const table of ["time_shifts", "unit_sessions", "task_sessions", "custom_work_sessions"]) {
  assert.equal((await db.query(`select * from ${table}`)).rows.length, 0);
  checks++;
}
assert.equal((await db.query("select untimed_work_present from custom_work_units where id=$1", [unitId])).rows[0].untimed_work_present, true);
checks++;
assert.equal((await db.query("select facts from custom_work_units where id=$1", [unitId])).rows[0].facts.installation_complete, undefined);
checks++;

// 12. A deleted job refuses, cleanly.
await db.exec("reset role");
await db.query("update projects set deleted_at=now() where id=$1", [id(10)]);
await asUser(1);
await denied(() => record({ ...base, work_date: "2026-09-27" }));
await denied(() =>
  correct({ unit_id: unitId, stage: "RO checked", work_date: "2026-09-29", expected_digest: digest2, reason: "x", remove: [id(3)] }),
);

// --------------------------------------------------------------------------
// The Astra concrete-review findings, each exercised directly (project id(10)
// is deleted as of step 12 above, so everything below uses fresh projects).
// --------------------------------------------------------------------------
await db.exec("reset role");
await db.query(
  `insert into profiles(id,role,retired_at,access_revoked_at,is_partner,is_test) values
   ($1,'foreman',null,null,false,false),
   ($2,'installer',null,null,false,false),
   ($3,'installer',null,null,false,false),
   ($4,'foreman',null,null,false,false)`,
  [10, 11, 12, 16].map(id),
);
await db.query("insert into projects(id,deleted_at,is_test) values ($1,null,false),($2,null,false),($3,null,true)", [id(13), id(15), id(14)]);
const unitA = (
  await db.query(
    "insert into custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts) values (gen_random_uuid(),$1,null,$2,'A1','Bifold door','{}') returning id",
    [id(13), id(1)],
  )
).rows[0].id;
await asUser(1);

// Finding #3: the digest hashes SOURCE EVIDENCE (record+person), not merely
// the distinct person set — so voiding someone and re-adding them under a
// brand-new report changes the digest even though the distinct people are
// unchanged, and a correction loaded before that swap is refused as stale.
await record({ unit_id: unitA, stage: "RO checked", work_date: "2026-09-20", outcome: "finished", people: [id(2), id(3)] });
const digestBeforeSwap = await digest(unitA, "RO checked", "2026-09-20");
await correct({ unit_id: unitA, stage: "RO checked", work_date: "2026-09-20", expected_digest: digestBeforeSwap, reason: "Testing evidence swap", remove: [id(3)], add: [id(3)], outcome: "finished" });
const digestAfterSwap = await digest(unitA, "RO checked", "2026-09-20");
assert.notEqual(digestAfterSwap, digestBeforeSwap);
checks++;
assert.deepEqual((await effective(unitA, "RO checked", "2026-09-20")).sort(), [id(2), id(3)].sort());
checks++;
// The pre-swap digest is now stale even though the distinct people match.
await denied(() =>
  correct({ unit_id: unitA, stage: "RO checked", work_date: "2026-09-20", expected_digest: digestBeforeSwap, reason: "Stale retry", remove: [id(2)] }),
);

// Finding #4: a linked opening removed after it was read is refused, not
// silently used, for both the existing-unit route and the opening route.
await db.exec("reset role");
const openingB = (
  await db.query("insert into project_openings(id,project_id,opening_code) values (gen_random_uuid(),$1,'DRY-B') returning id", [id(13)])
).rows[0].id;
await asUser(1);
await record({ opening_id: openingB, stage: "Flashing", work_date: "2026-09-20", outcome: "partial", people: [id(2)] });
const unitB = (await db.query("select id from custom_work_units where opening_id=$1", [openingB])).rows[0].id;
await db.exec("reset role");
await db.query("update project_openings set removed_at=now() where id=$1", [openingB]);
await asUser(1);
await denied(() => record({ unit_id: unitB, stage: "Flashing", work_date: "2026-09-21", outcome: "partial", people: [id(3)] }));
await denied(() => record({ opening_id: openingB, stage: "Flashing", work_date: "2026-09-21", outcome: "partial", people: [id(3)] }));
const digestB = await digest(unitB, "Flashing", "2026-09-20");
await denied(() =>
  correct({ unit_id: unitB, stage: "Flashing", work_date: "2026-09-20", expected_digest: digestB, reason: "Opening removed", remove: [id(2)] }),
);

// Finding #5: voided_by is ON DELETE SET NULL, independent of voided_at and
// void_reason, and an unvoided row never retains an actor. A throwaway
// foreman (id 16) performs the void so deleting them afterward hits no other
// FK (unlike id 1, which authored units throughout this file).
await record({ unit_id: unitA, stage: "Hardware", work_date: "2026-09-20", outcome: "finished", people: [id(11)] });
await asUser(16);
const digestHardware = await digest(unitA, "Hardware", "2026-09-20");
await correct({ unit_id: unitA, stage: "Hardware", work_date: "2026-09-20", expected_digest: digestHardware, reason: "FK probe", remove: [id(11)] });
await db.exec("reset role");
// custom_work_history.actor_id and custom_work_commands.profile_id have no
// ON DELETE action (RESTRICT); clear this throwaway actor's traces there so
// only voided_by's own ON DELETE SET NULL is what is actually proven below.
await db.query("delete from custom_work_history where actor_id=$1", [id(16)]);
await db.query("delete from custom_work_commands where profile_id=$1", [id(16)]);
await db.query("delete from profiles where id=$1", [id(16)]);
const afterDeleteActor = (
  await db.query(
    "select voided_at is not null as has_at, voided_by, void_reason from crew_work_record_people p join crew_work_records r on r.id=p.record_id where r.unit_id=$1 and r.stage='Hardware' and p.profile_id=$2",
    [unitA, id(11)],
  )
).rows[0];
assert.equal(afterDeleteActor.has_at, true);
checks++;
assert.equal(afterDeleteActor.voided_by, null);
checks++;
assert.equal(afterDeleteActor.void_reason, "FK probe");
checks++;
// An unvoided row cannot retain an actor (the second void constraint) — this
// must fail on the CHECK, not a dangling foreign key, so voided_by here is a
// still-live profile.
await assert.rejects(() =>
  db.query(
    "insert into crew_work_record_people(record_id,profile_id,voided_by) select id,$1,$2 from crew_work_records where unit_id=$3 limit 1",
    [id(12), id(10), unitA],
  ),
);
checks++;

// Finding #2: stage_contributor_summary must independently pass BOTH the
// unit's CURRENT project and the report's ORIGINAL project through the same
// deleted/test-partition visibility rule — a unit can move to a different
// job after a report was filed against it, and the report's own project_id
// never changes. A real actor must lose the read the moment either side
// becomes a hidden test project; a test actor never gains it either way.
await asUser(10);
await record({ unit_id: unitA, stage: "Glazing", work_date: "2026-09-20", outcome: "finished", people: [id(11)] });
assert.deepEqual(await effective(unitA, "Glazing", "2026-09-20"), [id(11)]);
checks++;
await db.exec("reset role");
await db.query("update custom_work_units set project_id=$1 where id=$2", [id(14), unitA]); // moved to the TEST project
await asUser(10);
assert.deepEqual(await effective(unitA, "Glazing", "2026-09-20"), []);
checks++;
await db.exec("reset role");
await db.query("update custom_work_units set project_id=$1 where id=$2", [id(15), unitA]); // moved to a different REAL project
await db.query("update projects set is_test=true where id=$1", [id(13)]); // the report's ORIGINAL project turns test
await asUser(10);
assert.deepEqual(await effective(unitA, "Glazing", "2026-09-20"), []);
checks++;
await db.exec("reset role");
await db.query("update projects set is_test=false where id=$1", [id(13)]);
await db.query("update custom_work_units set project_id=$1 where id=$2", [id(13), unitA]); // restore for the remaining tests
await asUser(1);

// Finding #6: a correction adding people must apply the same finite,
// not-in-the-future date bound record_stage_contributors applies — an empty
// (md5('')) digest is well-known and must not be a way around it. Removing
// from an existing (even invalid-dated) tuple is still allowed, to let a
// correction clean up old evidence.
const EMPTY_DIGEST = "d41d8cd98f00b204e9800998ecf8427e";
await denied(() =>
  correct({ unit_id: unitA, stage: "Detail work", work_date: "2099-01-01", expected_digest: EMPTY_DIGEST, reason: "Future add", add: [id(11)], outcome: "finished" }),
);
await db.exec("reset role");
const futureRecord = id(900);
await db.query(
  "insert into crew_work_records(id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description) values ($1,$2,$3,$4,'2099-06-01','Detail work','finished',false,'')",
  [futureRecord, id(13), unitA, id(1)],
);
await db.query("insert into crew_work_record_people(record_id,profile_id) values ($1,$2)", [futureRecord, id(12)]);
await asUser(1);
const futureDigest = await digest(unitA, "Detail work", "2099-06-01");
assert.equal(
  await correct({ unit_id: unitA, stage: "Detail work", work_date: "2099-06-01", expected_digest: futureDigest, reason: "Clean up invalid evidence", remove: [id(12)] }),
  unitA,
);
checks++;
assert.deepEqual(await effective(unitA, "Detail work", "2099-06-01"), []);
checks++;

// Astra's follow-up fix: a unit can move to a job that is still visible
// while the ORIGINAL report for one of its tuples stays filed under a
// project that is now deleted (or otherwise hidden from this actor). That
// tuple's historical evidence is not fully visible, so new mutations on it
// are refused outright — not partially applied, not silently guessed — and
// stage_contributor_summary omits the whole tuple rather than describing
// evidence it cannot show.
await db.exec("reset role");
await db.query("insert into projects(id,deleted_at,is_test) values ($1,null,false)", [id(17)]);
const unitD = (
  await db.query(
    "insert into custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts) values (gen_random_uuid(),$1,null,$2,'D1','Bifold door','{}') returning id",
    [id(17), id(1)],
  )
).rows[0].id;
await asUser(1);
await record({ unit_id: unitD, stage: "Setting frame", work_date: "2026-09-18", outcome: "finished", people: [id(2)] });
await db.exec("reset role");
await db.query("update custom_work_units set project_id=$1 where id=$2", [id(13), unitD]); // moved to a job that stays visible
await db.query("update projects set deleted_at=now() where id=$1", [id(17)]); // the ORIGINAL report's job is now gone
await asUser(1);
assert.deepEqual(await effective(unitD, "Setting frame", "2026-09-18"), []);
checks++;
await denied(() => record({ unit_id: unitD, stage: "Setting frame", work_date: "2026-09-18", outcome: "finished", people: [id(3)] }));
await denied(() =>
  correct({ unit_id: unitD, stage: "Setting frame", work_date: "2026-09-18", expected_digest: EMPTY_DIGEST, reason: "probe hidden source", remove: [id(2)] }),
);
await db.exec("reset role");
assert.equal((await db.query("select count(*) n from crew_work_record_people where record_id in (select id from crew_work_records where unit_id=$1)", [unitD])).rows[0].n, 1);
checks++;

await db.close();
console.log(
  `${checks} foreman-unit-contributor SQL assertions passed against the real 20261011000000, 20261023000000 and 20261049000000 migrations. Auth/visibility helpers above are fixture stubs; scripts/db-dry-run.sh checks the real schema with rollback, and scripts/test-stage-contributors.sh checks simultaneous PostgreSQL transactions. No production writes.`,
);
