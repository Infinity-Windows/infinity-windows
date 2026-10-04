// Execute the actual corrected migration (20261108100000_work_unit_observations.sql)
// and its actual real dependency helper bodies on a disposable embedded
// PostgreSQL. Synthetic profiles/projects/units only -- no production
// credentials, no clocks/payroll changes. Follows
// scripts/verify-work-configuration.mjs's exact pattern: extract each real
// helper body from its actual migration file text rather than
// reimplementing or always-true-mocking permission logic. Loads real base
// schema/migrations in actual historical order, then applies the real
// "create or replace" bodies that supersede them -- never the reverse, and
// never an unqualified no-op where a real guard exists (sandbox trigger
// included).
//
// Corrected 2026-10-03 against UNIT-OBSERVATION-INDEPENDENT-REVIEW.md B9:
// refuse() no longer swallows its own failure; a self-test proves that
// first. Dependency load order fixed (base migration before the "or
// replace" extracts that supersede it). Real sandbox guard loaded instead
// of a no-op stub.
//
// NOT a substitute for the parent's gates: no two-backend concurrency, no
// candidate-bound actual-schema rollback, no record_crew_work integration
// (that RPC and the crew_work_records/crew_work_record_people tables it
// needs are outside this slice's owned fixture; only custom_work_command's
// own atomicity is exercised here, directly, against the private helper).
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const schemaSql = [];
const schemaExec = async sql => { schemaSql.push(sql); await db.exec(sql); };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const one = async sql => (await db.query(sql)).rows[0];
const all = async sql => (await db.query(sql)).rows;

// B9 fix: the SQL call and the assertion are now separate try/catch scopes.
// If `sql` unexpectedly succeeds, `threw` stays false and the assert.ok
// below throws OUTSIDE any catch -- it is never swallowed as "the SQL
// refused" the way the previous draft's version did.
const refuse = async (sql, expectedCode) => {
  let threw = false, actualCode;
  try { await db.exec(sql); }
  catch (error) { threw = true; actualCode = error.code; }
  assert.ok(threw, 'Expected refusal, but the statement succeeded: ' + sql);
  if (expectedCode) assert.equal(actualCode, expectedCode, sql + ' -> ' + actualCode);
  checks++;
};
const quote = v => "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
const migrationFunction = (file, name) => {
  const source = readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
  const prefixes = ['create or replace function public.', 'create function public.',
    'create or replace function ', 'create function '];
  let start = -1;
  for (const p of prefixes) { start = source.indexOf(p + name + '('); if (start >= 0) break; }
  assert.ok(start >= 0, 'Actual helper must exist: ' + name);
  const end = source.indexOf('$$;', start);
  assert.ok(end > start);
  return source.slice(start, end + 3);
};

// ---------------------------------------------------------------------------
// refuse() self-test (B9): a deliberately successful statement must make
// refuse() itself fail. Run this BEFORE trusting any other negative check
// in this file.
// ---------------------------------------------------------------------------
{
  let selfTestThrew = false;
  try { await refuse('select 1'); }
  catch { selfTestThrew = true; }
  assert.ok(selfTestThrew, 'refuse() must throw when the given SQL unexpectedly succeeds -- it did not');
  checks++;
}

// ---------------------------------------------------------------------------
// Base fixture. check_function_bodies=off (matching verify-custom-work.mjs's
// proven convention): the real 20261011000000 base migration references
// profiles.active and functions not yet defined when it loads; deferring
// body validation to first CALL (never actually needed, since every one of
// those is superseded before any call happens) avoids a brittle exact
// dependency order while still running every function's REAL body at the
// only time it matters -- execution.
// ---------------------------------------------------------------------------
await schemaExec(`
set check_function_bodies = off;
create role authenticated; create role anon; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public, auth to authenticated, anon;
create table profiles(id uuid primary key, role text, active boolean not null default true,
  retired_at timestamptz, access_revoked_at timestamptz,
  is_partner boolean not null default false, is_test boolean not null default false);
create table projects(id uuid primary key, deleted_at timestamptz, is_test boolean not null default false);
create table project_openings(id uuid primary key, project_id uuid, opening_code text, removed_at timestamptz);
create table sandbox_projects(project_id uuid primary key);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
-- Minimal real shape (20261107020000): the one capability table my new
-- permission predicate reads.
create table work_job_management_grants(
  id uuid primary key default gen_random_uuid(),project_id uuid not null,profile_id uuid not null,
  capability text not null check(capability in('menu_select','dimensions_edit','final_qc')),
  granted_by uuid not null,granted_at timestamptz not null default now(),revoked_at timestamptz,revoked_by uuid);
create unique index work_job_management_active on work_job_management_grants(project_id,profile_id,capability) where revoked_at is null;
grant select on profiles,projects,project_openings to authenticated;`);

// ---------------------------------------------------------------------------
// Real dependency bodies, extracted verbatim and loaded in actual
// historical order (B9): the base migration first, then each real
// "create or replace" that genuinely supersedes it.
// ---------------------------------------------------------------------------
for (const [file, names] of [
  ['20260950000000_partner_wall.sql', ['is_partner_user']],
  ['20260730120000_test_accounts_excluded_from_learning.sql', ['is_test_profile']],
  ['20260730220000_test_accounts_sandbox_only.sql', ['is_sandbox_project', 'row_project_id', 'guard_test_account_sandbox_only']],
  ['20260967000000_sandbox_guard_rearm.sql', ['sandbox_scoped_tables', 'attach_sandbox_guards']],
  ['20260810000000_team_timecards.sql', ['_is_supervisor']],
  ['20260718050000_time_timecard.sql', ['_is_lead']],
]) for (const name of names) await schemaExec(migrationFunction(file, name));

// The real base: tables + the ORIGINAL custom_work_internal/validate_custom_work_facts/custom_work_command.
await schemaExec(readFileSync(new URL('../supabase/migrations/20261011000000_custom_work.sql', import.meta.url), 'utf8'));

// The real "or replace" bodies that supersede the base, loaded AFTER it,
// in their actual order.
for (const [file, names] of [
  ['20261024000000_ai_field_operations.sql', ['custom_work_internal', 'validate_custom_work_facts', '_ai_job_visible']],
  ['20261107020000_work_capture_foundation.sql', ['work_capture_immutable_record']],
  ['20261108000000_work_configuration.sql', ['_work_config_internal', '_work_config_is_supervisor', '_work_config_is_foreman']],
]) for (const name of names) await schemaExec(migrationFunction(file, name));

// The actual new slice under review. Export contains DDL only, in the exact
// order executed here. Used by the parent's isolated real PostgreSQL harness.
await schemaExec(readFileSync(new URL('../supabase/migrations/20261108100000_work_unit_observations.sql', import.meta.url), 'utf8'));
if (process.env.WORK_UNIT_SCHEMA_OUT) {
  writeFileSync(process.env.WORK_UNIT_SCHEMA_OUT, schemaSql.join('\n\n') + '\n');
  await db.close();
  console.log('Exported verified unit-observation fixture schema (no fixture records).');
  process.exit(0);
}

// The ACTUAL latest validator is active, not an obsolete convenience body.
await refuse(`select validate_custom_work_facts('{"measurement_source":"x"}')`.replace('x', 'x'.repeat(4001)));
await db.exec(`select validate_custom_work_facts('{"measurement_source":"ok"}')`);
checks++;

const as = uid => db.exec(`select set_config('request.jwt.claim.sub','${uid}',false)`);
const command = async (action, data, key) => (await one(
  `select custom_work_command('${key}','${action}',${quote(data)})`
)).custom_work_command;
let n = 100;
const nextId = () => id(n++);
const unitRow = async unitId => one(`select * from custom_work_units where id='${unitId}'`);
const currentFact = async unitId => one(`select r.* from work_unit_fact_revisions r join work_unit_fact_current c on c.current_revision_id=r.id where c.unit_id='${unitId}'`);
const factCount = async unitId => (await one(`select count(*)::int as n from work_unit_fact_revisions where unit_id='${unitId}'`)).n;
const obs = (width, height, unit, source, sourceReference) => ({ width, height, unit, source, ...(sourceReference !== undefined ? { sourceReference } : {}) });

// ---------------------------------------------------------------------------
// Fixture people and jobs
// ---------------------------------------------------------------------------
const AUTHOR = id(1), FOREMAN_UNGRANTED = id(2), FOREMAN_GRANTED = id(3), SUPERVISOR = id(4), OWNER = id(5),
  OTHER_INSTALLER = id(6), RETIRED_FOREMAN = id(7), TEST_LOGIN = id(8);
const JOB_A = id(50), JOB_B = id(51), SANDBOX_JOB = id(52);
await db.exec(`
insert into profiles(id,role) values('${AUTHOR}','installer'),('${FOREMAN_UNGRANTED}','foreman'),
  ('${FOREMAN_GRANTED}','foreman'),('${SUPERVISOR}','supervisor'),('${OWNER}','owner'),('${OTHER_INSTALLER}','installer');
insert into profiles(id,role,retired_at) values('${RETIRED_FOREMAN}','foreman',now());
insert into profiles(id,role,is_test) values('${TEST_LOGIN}','owner',true);
insert into projects(id) values('${JOB_A}'),('${JOB_B}');
insert into projects(id,is_test) values('${SANDBOX_JOB}',true);
insert into sandbox_projects(project_id) values('${SANDBOX_JOB}');`);

// ---------------------------------------------------------------------------
// 1. Legacy save with no observation key remains legal; no fact revision.
// ---------------------------------------------------------------------------
await as(AUTHOR);
const legacyUnit = nextId();
await command('unit', { id: legacyUnit, revision: 0, project_id: JOB_A, label: 'Legacy 1', facts: {} }, nextId());
check(Object.keys((await unitRow(legacyUnit)).facts).length === 0, 'Legacy empty-facts save remains legal');
check((await factCount(legacyUnit)) === 0, 'An untouched legacy unit records no private revision');

// ---------------------------------------------------------------------------
// 1b. B2 (third defect): a BRAND NEW unit created with real flat dimensions
// records revision 1, not none.
// ---------------------------------------------------------------------------
const freshLegacyDims = nextId();
await command('unit', { id: freshLegacyDims, revision: 0, project_id: JOB_A, label: 'Fresh dims', facts: { width_in: 30, height_in: 40 } }, nextId());
check((await factCount(freshLegacyDims)) === 1, 'A brand-new unit created with real flat dimensions records revision 1 (B2)');
check((await currentFact(freshLegacyDims)).event_kind === 'legacy_observation', 'Fresh flat-dimension creation is legacy_observation, not silently dropped');
check(Number((await currentFact(freshLegacyDims)).width_in) === 30, 'Its width is recorded from the final validated facts, not left null (B2)');
check((await currentFact(freshLegacyDims)).raw_observation === null, 'A flat legacy creation carries no raw-unit provenance');

// ---------------------------------------------------------------------------
// 2. Object observation normalizes equivalent in/ft/mm/cm consistently;
//    area_source mirrors the exact mapping (B3).
// ---------------------------------------------------------------------------
const unitIn = nextId(), unitFt = nextId(), unitMm = nextId(), unitCm = nextId();
await command('unit', { id: unitIn, revision: 0, project_id: JOB_A, label: 'U-in', facts: {}, dimension_observation: obs(12, 24, 'in', 'measured', 'Plan p3'), expected_fact_revision: 0 }, nextId());
await command('unit', { id: unitFt, revision: 0, project_id: JOB_A, label: 'U-ft', facts: {}, dimension_observation: obs(1, 2, 'ft', 'measured'), expected_fact_revision: 0 }, nextId());
await command('unit', { id: unitMm, revision: 0, project_id: JOB_A, label: 'U-mm', facts: {}, dimension_observation: obs(304.8, 609.6, 'mm', 'measured'), expected_fact_revision: 0 }, nextId());
await command('unit', { id: unitCm, revision: 0, project_id: JOB_A, label: 'U-cm', facts: {}, dimension_observation: obs(30.48, 60.96, 'cm', 'estimated'), expected_fact_revision: 0 }, nextId());
for (const u of [unitIn, unitFt, unitMm, unitCm]) {
  const row = await unitRow(u);
  check(Number(row.facts.width_in) === 12 && Number(row.facts.height_in) === 24, `${u} normalizes to 12x24in`);
}
check((await unitRow(unitIn)).facts.measurement_source === 'measured', 'measurement_source mirrors the observation source');
check((await unitRow(unitIn)).facts.area_source === 'Measured', 'area_source mirrors measured -> Measured exactly (B3)');
check((await unitRow(unitCm)).facts.area_source === 'Estimated', 'area_source mirrors estimated -> Estimated exactly (B3)');
const fact1 = await currentFact(unitIn);
check(fact1.revision === 1 && fact1.event_kind === 'observation', 'First observation is revision 1');
check(Number(fact1.raw_observation.width) === 12 && fact1.source_reference === 'Plan p3', 'Raw original width and source reference survive privately');
check(fact1.observation_actor_id === AUTHOR, 'Observation actor is the acting author');
check(fact1.origin_project_id === JOB_A, 'A fresh observation establishes its origin at the current job (B1)');

// ---------------------------------------------------------------------------
// 3. Normalization refusals, and B8 strict-DTO refusals.
// ---------------------------------------------------------------------------
const tryObs = async (observation, extra = {}) =>
  refuse(`select custom_work_command('${nextId()}','unit',${quote({ id: nextId(), revision: 0, project_id: JOB_A, label: 'Bad', facts: {}, dimension_observation: observation, expected_fact_revision: 0, ...extra })})`);
await tryObs(obs(0, 24, 'in', 'measured'));
await tryObs(obs(-1, 24, 'in', 'measured'));
await tryObs({ width: '12', height: 24, unit: 'in', source: 'measured' });
await tryObs({ width: [12], height: 24, unit: 'in', source: 'measured' });
await tryObs({ width: 12, height: 24, unit: 'in', source: 'measured', verified: true });
await tryObs({ width: 12, height: 24, unit: 'parsecs', source: 'measured' });
await tryObs({ width: 12, height: 24, unit: 'in', source: 'telepathy' });
await tryObs({ width: 12, height: 24, unit: 'in' });
await tryObs(obs(120001, 24, 'in', 'measured'));
await tryObs(obs(12, 24, 'in', 'measured', 'x'.repeat(501)));

// Contradictory client-supplied mirrors refuse rather than silently preferring either.
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: nextId(), revision: 0, project_id: JOB_A, label: 'Contradict', facts: { width_in: 99 },
  dimension_observation: obs(12, 24, 'in', 'measured'), expected_fact_revision: 0,
})})`);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: nextId(), revision: 0, project_id: JOB_A, label: 'ContradictArea', facts: { area_source: 'Something else' },
  dimension_observation: obs(12, 24, 'in', 'measured'), expected_fact_revision: 0,
})})`);

// B8: expected_fact_revision as a numeric STRING ("0") must refuse, not coerce.
await refuse(`select custom_work_command('${nextId()}','unit','{"id":"${nextId()}","revision":0,"project_id":"${JOB_A}","label":"StrRev","facts":{},"dimension_observation":${JSON.stringify(obs(12, 24, 'in', 'measured'))},"expected_fact_revision":"0"}')`);
// B8: a wrong-type original facts.width_in (string) must refuse outright,
// never be silently overwritten by the server-derived numeric value.
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: nextId(), revision: 0, project_id: JOB_A, label: 'BadFlatType', facts: { width_in: '12', height_in: 24 },
})})`);

// ---------------------------------------------------------------------------
// 4. expected_fact_revision is required and must match; stale refuses.
// ---------------------------------------------------------------------------
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: nextId(), revision: 0, project_id: JOB_A, label: 'NoExpect', facts: {}, dimension_observation: obs(12, 24, 'in', 'measured'),
})})`);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_A, label: 'U-in', facts: {},
  dimension_observation: obs(13, 25, 'in', 'measured'), expected_fact_revision: 0,
})})`); // stale -- current fact revision is already 1
await command('unit', {
  id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_A, label: 'U-in', facts: {},
  dimension_observation: obs(13, 25, 'in', 'measured'), expected_fact_revision: 1,
}, nextId());
check((await currentFact(unitIn)).revision === 2, 'Correct expected_fact_revision advances to revision 2');

// ---------------------------------------------------------------------------
// 5. Legacy/new/legacy alternating edits; unchanged round trip is a no-op;
//    area_source-only change is itself protected (B3).
// ---------------------------------------------------------------------------
const alt = nextId();
await command('unit', { id: alt, revision: 0, project_id: JOB_A, label: 'Alt', facts: { width_in: 10, height_in: 20 } }, nextId());
check((await currentFact(alt)).event_kind === 'legacy_observation' && (await currentFact(alt)).revision === 1, 'Legacy flat edit from nothing creates legacy_observation revision 1');
await command('unit', { id: alt, revision: (await unitRow(alt)).revision, project_id: JOB_A, label: 'Alt', facts: { width_in: 10, height_in: 20 } }, nextId());
check((await currentFact(alt)).revision === 1, 'Resaving the identical legacy tuple creates no new revision');
await command('unit', { id: alt, revision: (await unitRow(alt)).revision, project_id: JOB_A, label: 'Alt', facts: { width_in: 10, height_in: 20, area_source: 'Hand measured' } }, nextId());
check((await currentFact(alt)).revision === 2, 'An area_source-only change is itself a protected tuple change (B3)');
await command('unit', { id: alt, revision: (await unitRow(alt)).revision, project_id: JOB_A, label: 'Alt', facts: { width_in: 15, area_source: 'Hand measured' } }, nextId());
check((await currentFact(alt)).event_kind === 'incomplete' && (await currentFact(alt)).revision === 3, 'Omitting height_in now creates an incomplete revision');
await command('unit', {
  id: alt, revision: (await unitRow(alt)).revision, project_id: JOB_A, label: 'Alt', facts: {},
  dimension_observation: obs(16, 26, 'in', 'plans'), expected_fact_revision: 3,
}, nextId());
check((await currentFact(alt)).event_kind === 'observation' && (await currentFact(alt)).revision === 4, 'An explicit observation after legacy edits advances again');
check((await factCount(alt)) === 4, 'All four revisions are retained, never overwritten');

// ---------------------------------------------------------------------------
// 6. Exact replay appends no second revision.
// ---------------------------------------------------------------------------
const replayKey = nextId();
const replayUnit = nextId();
const replayData = { id: replayUnit, revision: 0, project_id: JOB_A, label: 'Replay', facts: {}, dimension_observation: obs(5, 6, 'in', 'measured'), expected_fact_revision: 0 };
await command('unit', replayData, replayKey);
await command('unit', replayData, replayKey);
check((await factCount(replayUnit)) === 1, 'Exact replay of the same command id appends no second fact revision');

// ---------------------------------------------------------------------------
// 7. Author vs. non-author dimension-change authority (B4: visibility
//    required for every actor; standalone protected edits need
//    owner/supervisor, never a vacuous foreman grant loop).
// ---------------------------------------------------------------------------
await as(FOREMAN_UNGRANTED);
const beforeRelabelFacts = (await unitRow(unitIn)).facts;
const factRevisionBeforeRelabel = (await currentFact(unitIn)).revision;
await command('unit', { id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_A, label: 'Relabeled by foreman', facts: beforeRelabelFacts }, nextId());
check((await unitRow(unitIn)).label === 'Relabeled by foreman', 'A non-author foreman may still relabel the unit when the dimension tuple is unchanged (non-dimensional edit, existing rule)');
check((await currentFact(unitIn)).revision === factRevisionBeforeRelabel, 'An unchanged dimension tuple creates no new revision even when someone else edits the label');
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_A, label: 'Relabeled by foreman', facts: {},
  dimension_observation: obs(99, 99, 'in', 'measured'), expected_fact_revision: (await currentFact(unitIn)).revision,
})})`, '42501');

// Standalone (no job) unit: a nonauthor foreman can NEVER administer its
// protected dimensions -- there is no job to grant against (B4).
const standalone = nextId();
await as(AUTHOR);
await command('unit', { id: standalone, revision: 0, label: 'Standalone', facts: {}, dimension_observation: obs(1, 1, 'in', 'measured'), expected_fact_revision: 0 }, nextId());
await as(FOREMAN_UNGRANTED);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: standalone, revision: (await unitRow(standalone)).revision, label: 'Standalone', facts: {},
  dimension_observation: obs(2, 2, 'in', 'measured'), expected_fact_revision: (await currentFact(standalone)).revision,
})})`, '42501');
await as(SUPERVISOR);
await command('unit', {
  id: standalone, revision: (await unitRow(standalone)).revision, label: 'Standalone', facts: {},
  dimension_observation: obs(3, 3, 'in', 'measured'), expected_fact_revision: (await currentFact(standalone)).revision,
}, nextId());
check(Number((await unitRow(standalone)).facts.width_in) === 3, "A supervisor may administer a standalone unit's protected dimensions");

await as(SUPERVISOR);
await db.exec(`insert into work_job_management_grants(project_id,profile_id,capability,granted_by) values('${JOB_A}','${FOREMAN_GRANTED}','dimensions_edit','${SUPERVISOR}')`);

await as(FOREMAN_GRANTED);
await command('unit', {
  id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_A, label: 'Relabeled by foreman', facts: {},
  dimension_observation: obs(14, 26, 'in', 'measured'), expected_fact_revision: (await currentFact(unitIn)).revision,
}, nextId());
check(Number((await unitRow(unitIn)).facts.width_in) === 14, "A granted foreman may change another author's dimensions");

await as(OWNER);
await command('unit', {
  id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_A, label: 'Relabeled by foreman', facts: {},
  dimension_observation: obs(15, 27, 'in', 'measured'), expected_fact_revision: (await currentFact(unitIn)).revision,
}, nextId());
check(Number((await unitRow(unitIn)).facts.width_in) === 15, 'An owner may change dimensions without any explicit grant');

// ---------------------------------------------------------------------------
// 8. Relink requires dimensions authority on all affected jobs (B4: this now
//    includes a legacy/incomplete prior observation, not only a raw one);
//    a never-observed unit's move creates no revision. B1: origin is
//    carried forward unchanged across the move.
// ---------------------------------------------------------------------------
await as(FOREMAN_GRANTED); // granted on JOB_A only so far
const beforeMoveFacts = (await unitRow(unitIn)).facts; // carry the existing dimension tuple forward unchanged -- a move alone, not a fact edit
const originBeforeMove = (await currentFact(unitIn)).origin_project_id;
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_B, reason: 'move to B', label: 'Relabeled by foreman', facts: beforeMoveFacts,
})})`, '42501');
await as(SUPERVISOR);
await db.exec(`insert into work_job_management_grants(project_id,profile_id,capability,granted_by) values('${JOB_B}','${FOREMAN_GRANTED}','dimensions_edit','${SUPERVISOR}')`);
await as(FOREMAN_GRANTED);
await command('unit', { id: unitIn, revision: (await unitRow(unitIn)).revision, project_id: JOB_B, reason: 'move to B', label: 'Relabeled by foreman', facts: beforeMoveFacts }, nextId());
check((await currentFact(unitIn)).event_kind === 'relink' && (await currentFact(unitIn)).project_id === JOB_B, 'Relink with grants on both jobs creates a relink revision bound (current binding) to the new job');
check(Number((await currentFact(unitIn)).width_in) === 15, 'Relink carries the prior observation forward unchanged');
check((await currentFact(unitIn)).origin_project_id === originBeforeMove && originBeforeMove === JOB_A, 'Relink carries ORIGIN forward unchanged -- still JOB_A, not laundered into JOB_B (B1)');

// Legacy/incomplete (no raw object) prior observation is equally protected on relink (B4).
const legacyRelink = nextId();
await as(AUTHOR);
await command('unit', { id: legacyRelink, revision: 0, project_id: JOB_A, label: 'Legacy relink', facts: { width_in: 5, height_in: 5 } }, nextId());
await as(FOREMAN_UNGRANTED);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: legacyRelink, revision: (await unitRow(legacyRelink)).revision, project_id: JOB_B, reason: 'move', label: 'Legacy relink', facts: (await unitRow(legacyRelink)).facts,
})})`, '42501');

const neverObserved = nextId();
await as(AUTHOR);
await command('unit', { id: neverObserved, revision: 0, project_id: JOB_A, label: 'Never observed', facts: {} }, nextId());
await as(FOREMAN_GRANTED);
await command('unit', { id: neverObserved, revision: (await unitRow(neverObserved)).revision, project_id: JOB_B, reason: 'move', label: 'Never observed', facts: {} }, nextId());
check((await factCount(neverObserved)) === 0, 'Moving a never-observed unit does not manufacture a revision from nothing');

// ---------------------------------------------------------------------------
// 9. Explicit reset clears width/height/measurement_source/area_source (B3).
// ---------------------------------------------------------------------------
await as(AUTHOR);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({
  id: unitFt, revision: (await unitRow(unitFt)).revision, project_id: JOB_A, label: 'U-ft', facts: {},
  dimension_observation: null, expected_fact_revision: (await currentFact(unitFt)).revision,
})})`); // no reason
await refuse(`select custom_work_command('${nextId()}','unit','{"id":"${unitFt}","revision":${(await unitRow(unitFt)).revision},"project_id":"${JOB_A}","label":"U-ft","facts":{},"dimension_observation":null,"expected_fact_revision":${(await currentFact(unitFt)).revision},"dimension_observation_reason":12345}')`); // non-string reason refuses (B8)
await command('unit', {
  id: unitFt, revision: (await unitRow(unitFt)).revision, project_id: JOB_A, label: 'U-ft', facts: {},
  dimension_observation: null, expected_fact_revision: (await currentFact(unitFt)).revision, dimension_observation_reason: 'Remeasured wrong; clearing.',
}, nextId());
check((await currentFact(unitFt)).event_kind === 'cleared', 'Explicit null with a reason records a cleared revision');
check((await unitRow(unitFt)).facts.width_in === undefined, 'A cleared observation removes the mirrored width_in key');
check((await unitRow(unitFt)).facts.area_source === undefined, 'A cleared observation also removes the mirrored area_source key (B3)');

// ---------------------------------------------------------------------------
// 10. Permission-safe read: current AND origin visibility independently
//     gate (B1); hiding either side alone refuses the whole projection.
// ---------------------------------------------------------------------------
const readable = await one(`select work_unit_fact_current_read('${unitIn}') as r`);
const expectedCurrentRef = (await currentFact(unitIn)).source_reference;
check(readable.r.observation.sourceReference === expectedCurrentRef, "Read returns the ACTUAL current source reference, not an earlier observation's");
// unitIn's CURRENT binding is now JOB_B; hiding JOB_B refuses even though
// origin (JOB_A) is still visible.
await db.exec(`update projects set deleted_at=now() where id='${JOB_B}'`);
await refuse(`select work_unit_fact_current_read('${unitIn}')`);
await db.exec(`update projects set deleted_at=null where id='${JOB_B}'`);
await one(`select work_unit_fact_current_read('${unitIn}') as r`); // visibility returns; nothing was resurrected or lost
// Now hide the ORIGIN (JOB_A) instead, with the current binding (JOB_B)
// still fully visible -- B1's exact reproduction: this must ALSO refuse.
await db.exec(`update projects set deleted_at=now() where id='${JOB_A}'`);
await refuse(`select work_unit_fact_current_read('${unitIn}')`);
await db.exec(`update projects set deleted_at=null where id='${JOB_A}'`);
await one(`select work_unit_fact_current_read('${unitIn}') as r`);

// Any internal crew member on a visible job can read the frozen observation
// (job visibility, not author/owner/supervisor/grant, is this slice's read
// boundary for an assigned unit) -- OTHER_INSTALLER succeeds rather than
// refuses, documented here rather than asserted as a refusal.
await as(OTHER_INSTALLER);
await one(`select work_unit_fact_current_read('${unitIn}') as r`);
checks++;

// ---------------------------------------------------------------------------
// 11. Retired/revoked never pass as actor for any of this.
// ---------------------------------------------------------------------------
await as(RETIRED_FOREMAN);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({ id: nextId(), revision: 0, project_id: JOB_A, label: 'X', facts: {} })})`, '42501');
await refuse(`select work_unit_fact_current_read('${unitIn}')`, '42501');

// ---------------------------------------------------------------------------
// 12. The private transaction seam refuses a foreign/invented association.
// ---------------------------------------------------------------------------
await as(AUTHOR);
await refuse(`select _work_record_unit_fact('${nextId()}','{"event_kind":"observation"}','{}','${unitIn}')`); // no such command row
await refuse(`select _work_record_unit_fact('${replayKey}','{"event_kind":"observation"}','{}','${nextId()}')`); // real command, but wrong result unit
await refuse(`select _work_record_unit_fact('${replayKey}','{"event_kind":"not_a_real_kind"}','{}','${replayUnit}')`); // rejects an invalid applied intent outright

// ---------------------------------------------------------------------------
// 13. B6: epoch baseline is distinct from the first real bump, and a
//     physical DELETE/INSERT reincarnation bumps it even with no UPDATE.
// ---------------------------------------------------------------------------
const epochUnit = nextId();
const EPOCH_JOB = nextId(); // a never-touched job: JOB_A/JOB_B already carry bumps from earlier sections.
await db.exec(`insert into projects(id) values('${EPOCH_JOB}')`);
await as(AUTHOR);
await command('unit', { id: epochUnit, revision: 0, project_id: EPOCH_JOB, label: 'Epoch', facts: {}, dimension_observation: obs(1, 1, 'in', 'measured'), expected_fact_revision: 0 }, nextId());
const epochBeforeAnyBump = (await currentFact(epochUnit)).project_context_epoch;
check(epochBeforeAnyBump === 0, 'Absent-scope baseline is 0, before any real bump has ever happened (B6)');
await db.exec(`update projects set deleted_at=now() where id='${EPOCH_JOB}'`); // bumps the project epoch (an UPDATE of deleted_at)
await db.exec(`update projects set deleted_at=null where id='${EPOCH_JOB}'`); // and again, restoring
// A genuine dimension change forces a fresh revision (and a fresh epoch
// peek at write time) -- an unchanged resave would record no new revision
// at all and so never re-observe the bumped epoch.
await command('unit', {
  id: epochUnit, revision: (await unitRow(epochUnit)).revision, project_id: EPOCH_JOB, label: 'Epoch', facts: {},
  dimension_observation: obs(2, 2, 'in', 'measured'), expected_fact_revision: (await currentFact(epochUnit)).revision,
}, nextId());
const epochAfterTwoBumps = (await currentFact(epochUnit)).project_context_epoch;
check(epochAfterTwoBumps === 2, 'Two real project-identity changes advance the epoch from the 0 baseline to 2, never colliding with it (B6)');
// Physical DELETE + re-INSERT of the same opening id -- a reincarnation an
// UPDATE-only trigger would never see.
const reincarnatedOpening = nextId();
await db.exec(`insert into project_openings(id,project_id,opening_code) values('${reincarnatedOpening}','${JOB_A}','R1')`);
const epochBeforeReincarnation = (await one(`select coalesce((select epoch from work_unit_fact_context_epochs where scope_kind='opening' and scope_id='${reincarnatedOpening}'),0)::int as e`)).e;
await db.exec(`delete from project_openings where id='${reincarnatedOpening}'`);
await db.exec(`insert into project_openings(id,project_id,opening_code) values('${reincarnatedOpening}','${JOB_A}','R1')`);
const epochAfterReincarnation = (await one(`select coalesce((select epoch from work_unit_fact_context_epochs where scope_kind='opening' and scope_id='${reincarnatedOpening}'),0)::int as e`)).e;
check(epochAfterReincarnation > epochBeforeReincarnation, 'A physical DELETE+INSERT reincarnation of the same opening id bumps its epoch (B6)');

// ---------------------------------------------------------------------------
// 14. B7: deleting a job that has a recorded observation does not hit a new
//     FK -- the existing cascade purge route still works, and the retained
//     evidence survives it with its original UUID intact.
// ---------------------------------------------------------------------------
const purgeJob = nextId();
await db.exec(`insert into projects(id) values('${purgeJob}')`);
const purgeUnit = nextId();
await as(AUTHOR);
await command('unit', { id: purgeUnit, revision: 0, project_id: purgeJob, label: 'Purge me', facts: {}, dimension_observation: obs(1, 1, 'in', 'measured'), expected_fact_revision: 0 }, nextId());
check((await factCount(purgeUnit)) === 1, 'A real observation exists before the purge');
await db.exec(`delete from projects where id='${purgeJob}'`); // cascades to custom_work_units per 20261011000000
checks++; // the DELETE above did not raise -- the retained-evidence FK no longer blocks the existing purge route (B7)
check((await one(`select count(*)::int as n from custom_work_units where id='${purgeUnit}'`)).n === 0, 'The cascade did delete the operational unit row');
check((await factCount(purgeUnit)) === 1, 'The private fact revision survives the purge with its original unit_id intact (B7)');

// ---------------------------------------------------------------------------
// 15. Existing-row protection ONLY. A row inserted before the command is
//     already visible to SELECT FOR UPDATE; this does NOT exercise the
//     absent-row INSERT conflict or prove a concurrent lost-create race.
//     The parent owns that actual two-backend test.
// ---------------------------------------------------------------------------
const raceUnit = nextId();
await db.exec(`insert into custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts,revision) values('${raceUnit}',null,null,'${OTHER_INSTALLER}','Winner','Unknown','{}',1)`);
await as(AUTHOR);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({ id: raceUnit, revision: 0, label: 'Loser', facts: {} })})`);
check((await unitRow(raceUnit)).created_by === OTHER_INSTALLER, "An existing different author's row is not overwritten by a stale revision-0 create request");

// ---------------------------------------------------------------------------
// 16. The real sandbox guard (not a no-op): a test login is refused on a
//     live job and allowed on its sandbox job.
// ---------------------------------------------------------------------------
await as(TEST_LOGIN);
await refuse(`select custom_work_command('${nextId()}','unit',${quote({ id: nextId(), revision: 0, project_id: JOB_A, label: 'QA on real job', facts: {} })})`, '42501');
await command('unit', { id: nextId(), revision: 0, project_id: SANDBOX_JOB, label: 'QA on sandbox job', facts: {} }, nextId());
checks++; // the real guard_test_account_sandbox_only trigger allowed the sandbox write

// ---------------------------------------------------------------------------
// R1-R4 correction regressions. These are sequential transaction/refusal
// proofs. Real lock waits, crew composition and whole-schema rollout remain
// the parent's separate PostgreSQL gates.
// ---------------------------------------------------------------------------
const savedState = async () => (await one(`select jsonb_build_object(
  'units',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from custom_work_units x),
  'facts',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from work_unit_fact_revisions x),
  'pointers',(select coalesce(jsonb_agg(to_jsonb(x) order by unit_id),'[]') from work_unit_fact_current x),
  'epochs',(select coalesce(jsonb_agg(to_jsonb(x) order by scope_kind,scope_id),'[]') from work_unit_fact_context_epochs x),
  'history',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from custom_work_history x),
  'receipts',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from custom_work_commands x)) as state`)).state;
const atomicRefuse = async (data, code = '42501') => {
  const before = await savedState();
  await refuse(`select custom_work_command('${nextId()}','unit',${quote(data)})`, code);
  assert.deepEqual(await savedState(), before, 'Refusal must preserve unit, evidence, pointer, epochs, audit and receipt exactly'); checks++;
};
const edit = async (u, overrides = {}) => {
  const row = await unitRow(u);
  return { id: u, revision: row.revision, project_id: row.project_id, opening_id: row.opening_id,
    label: row.label, facts: row.facts, ...overrides };
};

// Real authors/new creators must pass the actual _ai_job_visible predicate.
await as(AUTHOR);
await atomicRefuse({ id: nextId(), revision: 0, project_id: SANDBOX_JOB, label: 'Hidden explicit', facts: {}, dimension_observation: obs(2,3,'in','measured'), expected_fact_revision: 0 });
await atomicRefuse({ id: nextId(), revision: 0, project_id: SANDBOX_JOB, label: 'Hidden flat', facts: {width_in: 2} });
const hiddenJob = nextId(), hiddenUnit = nextId();
await db.exec(`insert into projects(id) values('${hiddenJob}')`);
await command('unit', {id:hiddenUnit,revision:0,project_id:hiddenJob,label:'Initially visible',facts:{width_in:2,height_in:3}},nextId());
await db.exec(`update projects set is_test=true where id='${hiddenJob}'`);
await atomicRefuse(await edit(hiddenUnit,{facts:{width_in:3,height_in:4}}));
await atomicRefuse(await edit(hiddenUnit,{revision:999,facts:{width_in:3,height_in:4}}));
await atomicRefuse(await edit(hiddenUnit,{revision:999,label:'Hidden nondimensional edit'}));
await atomicRefuse({id:nextId(),revision:0,project_id:SANDBOX_JOB,label:'Hidden empty create',facts:{}});
await atomicRefuse(await edit(hiddenUnit,{facts:{},dimension_observation:obs(3,4,'in','measured'),expected_fact_revision:1}));
await atomicRefuse(await edit(hiddenUnit,{facts:{},dimension_observation:obs(3,4,'in','measured'),expected_fact_revision:999})); // source refusal precedes private revision mismatch

// Current mapped opening, original mapped opening and its current job are
// independent gates. Use correct revisions and complete foreman grants.
const originOpening = nextId(), mappedUnit = nextId(), thirdJob = nextId();
await db.exec(`insert into projects(id) values('${thirdJob}'); insert into project_openings(id,project_id,opening_code) values('${originOpening}','${JOB_A}','Origin')`);
await command('unit',{id:mappedUnit,revision:0,project_id:JOB_A,opening_id:originOpening,label:'Mapped origin',facts:{},dimension_observation:obs(7,8,'in','measured'),expected_fact_revision:0},nextId());
await as(SUPERVISOR);
await command('link',await edit(mappedUnit,{project_id:JOB_B,opening_id:null,reason:'Move unit retaining origin'}),nextId());
await as(FOREMAN_GRANTED);
await db.exec(`update project_openings set project_id='${SANDBOX_JOB}' where id='${originOpening}'`);
await atomicRefuse(await edit(mappedUnit,{facts:{width_in:8,height_in:9}}));
await refuse(`select work_unit_fact_current_read('${mappedUnit}')`,'23514');
await db.exec(`update project_openings set project_id='${JOB_A}',removed_at=now() where id='${originOpening}'`);
await atomicRefuse(await edit(mappedUnit,{dimension_observation:null,expected_fact_revision:2,dimension_observation_reason:'Clear stale dimensions'}));
await db.exec(`delete from project_openings where id='${originOpening}'`);
await atomicRefuse(await edit(mappedUnit,{facts:{width_in:8,height_in:9}}));
await refuse(`select work_unit_fact_current_read('${mappedUnit}')`,'23514');
await db.exec(`insert into project_openings(id,project_id,opening_code) values('${originOpening}','${thirdJob}','Restored origin')`);
await atomicRefuse(await edit(mappedUnit,{facts:{width_in:8,height_in:9}})); // live origin job visible but lacks grant
await db.exec(`insert into work_job_management_grants(project_id,profile_id,capability,granted_by) values('${thirdJob}','${FOREMAN_GRANTED}','dimensions_edit','${SUPERVISOR}')`);
await command('unit',await edit(mappedUnit,{facts:{width_in:8,height_in:9}}),nextId());
check((await currentFact(mappedUnit)).revision===3,"Grant on the original opening's live job enables the protected replacement");
const currentOpening=nextId(),currentMapped=nextId();
await db.exec(`insert into project_openings(id,project_id,opening_code) values('${currentOpening}','${JOB_A}','Current')`);
await as(AUTHOR);
await command('unit',{id:currentMapped,revision:0,project_id:JOB_A,opening_id:currentOpening,label:'Current mapping',facts:{width_in:4}},nextId());
await db.exec(`update project_openings set project_id='${JOB_B}' where id='${currentOpening}'`);
await atomicRefuse(await edit(currentMapped,{opening_id:null,reason:'Unmap moved opening',facts:{width_in:5}}));
await db.exec(`update project_openings set project_id='${JOB_A}',removed_at=now() where id='${currentOpening}'`);
await atomicRefuse(await edit(currentMapped,{opening_id:null,reason:'Unmap removed opening',facts:{width_in:5}}));

// Observer identity is not original author authority. The existing author
// can read a supervisor's standalone observation; raw origin survives moves.
await as(AUTHOR);
check((await one(`select work_unit_fact_current_read('${standalone}') as r`)).r.observationActorId===SUPERVISOR,'Standalone author can read supervisor observation');
check((await currentFact(standalone)).origin_author_id===AUTHOR && (await currentFact(standalone)).origin_is_test===false,'Original standalone author and partition are stored separately');
await as(FOREMAN_GRANTED);
await atomicRefuse(await edit(standalone,{project_id:JOB_A,reason:'Assign standalone to job'}));
await as(AUTHOR);
await command('link',await edit(standalone,{project_id:JOB_A,reason:'Author assigns unit'}),nextId());
check((await currentFact(standalone)).origin_kind==='unassigned','Assigning a standalone observation preserves its independent origin');
await as(FOREMAN_GRANTED);
await atomicRefuse(await edit(standalone,{facts:{width_in:6,height_in:7}}));
await as(SUPERVISOR);
await command('link',await edit(standalone,{project_id:JOB_B,reason:'Supervisor moves unit'}),nextId());
check((await currentFact(standalone)).origin_author_id===AUTHOR,'Supervisor relink preserves original standalone author');
// Author profile partition changes do not rewrite retained origin. A QA actor
// cannot read the real standalone evidence even if current/destination permits.
const partitionAuthor=nextId(), partitionUnit=nextId();
await db.exec(`insert into profiles(id,role) values('${partitionAuthor}','installer')`);
await as(partitionAuthor);
await command('unit',{id:partitionUnit,revision:0,label:'Partition',facts:{width_in:1}},nextId());
await db.exec(`update profiles set is_test=true where id='${partitionAuthor}'`);
await refuse(`select work_unit_fact_current_read('${partitionUnit}')`,'23514');
await atomicRefuse(await edit(partitionUnit,{facts:{width_in:2}}));
check((await currentFact(partitionUnit)).origin_is_test===false,'Profile reclassification does not rewrite stored origin partition');

// A reset is explicitly no-origin: authorized crew may read the empty result,
// including after a relink; it is never misclassified as standalone evidence.
await as(OTHER_INSTALLER);
check((await one(`select work_unit_fact_current_read('${unitFt}') as r`)).r.observation===null,'Assigned reset is readable by ordinary visible-job crew');
await as(FOREMAN_GRANTED);
await command('link',await edit(unitFt,{project_id:JOB_B,reason:'Move cleared unit'}),nextId());
await as(OTHER_INSTALLER);
check((await one(`select work_unit_fact_current_read('${unitFt}') as r`)).r.observation===null && (await currentFact(unitFt)).origin_kind==='none','Cleared relink remains empty and readable');

// Every legal old source string is evidence, not a new enum input. Preserve
// the raw text on its own revision and in the next before snapshot.
await as(AUTHOR);
for (const [measurement,area,normalized,estimated] of [
  ['measured on site',undefined,null,null],
  [undefined,'Estimated','estimated',true],
  ['measured','Estimated',null,true],
  ['plans','From plans','plans',false],
  ['x'.repeat(4000),'y'.repeat(4000),null,null],
  ['界'.repeat(4000),'x'.repeat(4000),null,null],
]) {
  const u=nextId();
  const facts={width_in:11,height_in:12,note:'Other evidence retained',...(measurement!==undefined?{measurement_source:measurement}:{}),...(area!==undefined?{area_source:area}:{})};
  await command('unit',{id:u,revision:0,project_id:JOB_A,label:'Legacy provenance',facts},nextId());
  let r=await currentFact(u);
  check(r.legacy_measurement_source===(measurement??null)&&r.legacy_area_source===(area??null),'Exact legal legacy source text survives in its own revision');
  check(r.measurement_source===normalized&&r.estimated===estimated,'Legacy provenance normalization is conservative');
  await command('unit',await edit(u,{facts:{note:facts.note},dimension_observation:obs(13,14,'cm','measured'),expected_fact_revision:1}),nextId());
  r=await currentFact(u);
  check(r.before_snapshot.measurement_source===(measurement??undefined)&&r.before_snapshot.area_source===(area??undefined),'Explicit replacement retains complete original source text in before snapshot');
  await command('unit',await edit(u,{facts,dimension_observation:null,expected_fact_revision:2,dimension_observation_reason:'Deliberate reset'}),nextId());
  check((await unitRow(u)).facts.note===facts.note&&(await currentFact(u)).origin_kind==='none','Reset preserves unrelated facts and clears provenance context');
  check((await factCount(u))===3,'Legacy, normalized replacement and reset remain immutable revisions');
}
// Also exercise a reset directly from the maximum legal legacy evidence.
const longReset=nextId(),longFacts={width_in:1,measurement_source:'界'.repeat(4000),area_source:'x'.repeat(4000)};
await command('unit',{id:longReset,revision:0,project_id:JOB_A,label:'Long reset',facts:longFacts},nextId());
await command('unit',await edit(longReset,{dimension_observation:null,expected_fact_revision:1,dimension_observation_reason:'Clear long legacy values'}),nextId());
check((await currentFact(longReset)).before_snapshot.measurement_source===longFacts.measurement_source,'Reset directly from legal multibyte legacy facts preserves the exact old source');

// QA owner authority is still partitioned: no live job or real standalone
// source access. A sandbox observation is a real permitted protected write.
await as(TEST_LOGIN);
await atomicRefuse({id:nextId(),revision:0,project_id:JOB_A,label:'QA protected live',facts:{width_in:1}});
const qaObserved=nextId(),qaStandalone=nextId();
await command('unit',{id:qaObserved,revision:0,project_id:SANDBOX_JOB,label:'QA observed',facts:{},dimension_observation:obs(2,2,'in','measured'),expected_fact_revision:0},nextId());
check((await one(`select work_unit_fact_current_read('${qaObserved}') as r`)).r.revision===1,'QA owner can record/read a protected sandbox observation');
await atomicRefuse({id:qaStandalone,revision:0,label:'QA standalone',facts:{width_in:3}}); // existing sandbox guard rejects unknown project
await as(SUPERVISOR);
// Synthetic historical standalone QA identity, seeded by the fixture owner;
// this is not evidence that a QA client can bypass the real sandbox guard.
await db.exec(`insert into custom_work_units(id,created_by,label,type_label,facts,revision) values('${qaStandalone}','${TEST_LOGIN}','Historical QA unit','Unknown','{}',1)`);
await refuse(`select work_unit_fact_current_read('${qaStandalone}')`,'23514');
await atomicRefuse(await edit(qaStandalone,{facts:{width_in:4}}));
await as(TEST_LOGIN);
await refuse(`select work_unit_fact_current_read('${standalone}')`,'23514');
await as(AUTHOR);

// Flat old-client corrections also retain arbitrary source strings, and a
// removed observer/profile never silently supplies an invented observer.
const flatCorrection=nextId();
await command('unit',{id:flatCorrection,revision:0,project_id:JOB_A,label:'Alternating legacy source',facts:{width_in:1}},nextId());
await command('unit',await edit(flatCorrection,{facts:{width_in:2,measurement_source:'Measured with borrowed laser',area_source:'Drawing margin note'}}),nextId());
check((await currentFact(flatCorrection)).legacy_measurement_source==='Measured with borrowed laser' && (await currentFact(flatCorrection)).measurement_source===null,'Existing old-client flat correction preserves arbitrary source labels without enum coercion');
check((await currentFact(flatCorrection)).observation_actor_id===null,'A legacy correction does not invent an observer');

// Private helper must match the applied saved tuple and canonical receipt
// action, not merely an existing UUID/profile pair. These owner-level fixture
// calls are distinct from the authenticated ACL denial below.
await refuse(`select _work_record_unit_fact('${replayKey}',${quote({event_kind:'legacy_observation',width_in:999})},'{}','${replayUnit}')`,'23514');
const nonUnitReceipt=nextId();
await db.exec(`insert into custom_work_commands(id,profile_id,payload,result_id) values('${nonUnitReceipt}','${AUTHOR}',${quote({action:'start',data:{id:replayUnit}})},'${replayUnit}')`);
await refuse(`select _work_record_unit_fact('${nonUnitReceipt}',${quote({event_kind:'legacy_observation',width_in:5,height_in:6})},'{}','${replayUnit}')`,'23514');

// Retained private history is never silently adopted by a reused unit UUID.
await db.exec(`insert into projects(id) values('${purgeJob}')`);
await atomicRefuse({id:purgeUnit,revision:0,project_id:purgeJob,label:'Reused empty UUID',facts:{}},'23514');
await atomicRefuse({id:purgeUnit,revision:0,project_id:purgeJob,label:'Reused observed UUID',facts:{},dimension_observation:obs(9,9,'in','measured'),expected_fact_revision:0},'23514');
// An operational restore outside the canonical writer cannot attach old
// private current state either. Its retained history is still present.
await db.exec(`insert into custom_work_units(id,project_id,created_by,label,type_label,facts,revision) values('${purgeUnit}','${purgeJob}','${AUTHOR}','External restore','Unknown','{}',1)`);
await refuse(`select work_unit_fact_current_read('${purgeUnit}')`,'23514');
await atomicRefuse(await edit(purgeUnit,{dimension_observation:obs(9,9,'in','measured'),expected_fact_revision:1}),'23514');
check((await factCount(purgeUnit))===1 && (await currentFact(purgeUnit)).unit_incarnation_epoch===0,'Old incarnation history and pointer remain retained but cannot become new current evidence');

// ---------------------------------------------------------------------------
// 17. No raw access to the new private tables.
// ---------------------------------------------------------------------------
for (const table of ['work_unit_fact_revisions', 'work_unit_fact_current', 'work_unit_fact_context_epochs']) {
  check((await one(`select relrowsecurity as enabled from pg_class where oid='public.${table}'::regclass`)).enabled, table + ' RLS enabled');
  for (const role of ['authenticated', 'anon'])
    check(!(await one(`select has_table_privilege('${role}','public.${table}','SELECT,INSERT,UPDATE,DELETE') as allowed`)).allowed, role + ' has no raw table privileges on ' + table);
}
check((await one("select count(*)::int as n from pg_policies where tablename in ('work_unit_fact_revisions','work_unit_fact_current','work_unit_fact_context_epochs')")).n === 0, 'No raw policy on the new tables');
await refuse(`update work_unit_fact_revisions set reason='x' where id='${fact1.id}'`); // immutable
await refuse(`delete from work_unit_fact_revisions where id='${fact1.id}'`);

// Actual authenticated role cannot execute the private helpers directly.
await db.exec('set role authenticated');
try {
  await refuse(`select _work_record_unit_fact('${nextId()}','{}','{}','${nextId()}')`, '42501');
  await refuse(`select _work_unit_fact_can_edit_dimensions(null,null,array[]::uuid[])`, '42501');
  await refuse(`select _work_unit_fact_context_visible(null,'none',null,null,null,null,false)`, '42501');
  await refuse(`select _work_unit_fact_legacy_source('measured')`, '42501');
} finally { await db.exec('reset role'); }

// Byte limits and PostgreSQL character limits are different. Execute the
// canonical writer, including lossless SQL numeric values that JavaScript
// would underflow; do not mistake a client serialization limit for storage.
await as(AUTHOR);
const unicodeRef = '😀'.repeat(500), unicodeUnit = nextId();
await command('unit',{id:unicodeUnit,revision:0,project_id:JOB_A,label:'Multibyte reference',facts:{},dimension_observation:obs(2,3,'in','plans',unicodeRef),expected_fact_revision:0},nextId());
check((await one(`select work_unit_fact_current_read('${unicodeUnit}') as r`)).r.observation.sourceReference===unicodeRef,'A 500-character four-byte reference round trips through the canonical writer and reader');
check((await currentFact(unicodeUnit)).raw_observation.sourceReference===unicodeRef,'Raw evidence preserves the exact multibyte reference');
await atomicRefuse({id:nextId(),revision:0,project_id:JOB_A,label:'Too many characters',facts:{},dimension_observation:obs(2,3,'in','plans','😀'.repeat(501)),expected_fact_revision:0},'23514');
const boundaryObservation = async target => {
  const make = count => "'{\"width\":0." + '0'.repeat(count) + "1,\"height\":1,\"unit\":\"in\",\"source\":\"measured\"}'::jsonb";
  const base = (await one(`select octet_length((${make(0)})::text) as n`)).n;
  return make(target-base);
};
const boundary = await boundaryObservation(4096), boundaryUnit = nextId();
check((await one(`select octet_length((${boundary})::text) as n`)).n===4096,'Positive boundary is exactly 4096 bytes of PostgreSQL JSONB text');
await one(`select custom_work_command('${nextId()}','unit',${quote({id:boundaryUnit,revision:0,project_id:JOB_A,label:'Lossless SQL numeric boundary',facts:{},expected_fact_revision:0})}::jsonb || jsonb_build_object('dimension_observation',${boundary}))`);
const boundaryState = async () => one(`select octet_length(r.raw_observation::text) as raw_bytes,
  r.raw_observation->>'width' = (${boundary})->>'width' as raw_exact,
  (work_unit_fact_current_read('${boundaryUnit}')->'observation'->>'width') = (${boundary})->>'width' as read_exact,
  r.raw_observation ? 'sourceReference' as reference_present,
  octet_length(r.applied_intent::text) <= 32768 as applied_bounded,
  r.before_snapshot is null or octet_length(r.before_snapshot::text) <= 32768 as before_bounded
  from work_unit_fact_revisions r join work_unit_fact_current c on c.current_revision_id=r.id where c.unit_id='${boundaryUnit}'`);
let boundaryResult = await boundaryState();
check(boundaryResult.raw_bytes===4096 && boundaryResult.raw_exact && boundaryResult.read_exact && !boundaryResult.reference_present,'Accepted boundary is lossless and optional null does not expand stored raw JSON');
check(boundaryResult.applied_bounded && boundaryResult.before_bounded,'Boundary private snapshots remain within their separate ceiling');
// Keep numeric facts in PostgreSQL instead of JSON.parse/JSON.stringify.
const sqlEdit = (unit, changes) => `jsonb_build_object('id','${unit}','revision',(select revision from custom_work_units where id='${unit}'),'project_id',(select project_id from custom_work_units where id='${unit}'),'label',(select label from custom_work_units where id='${unit}'),'facts',(select facts from custom_work_units where id='${unit}')) || ${quote(changes)}::jsonb`;
await as(SUPERVISOR);
await one(`select custom_work_command('${nextId()}','link',${sqlEdit(boundaryUnit,{project_id:JOB_B,reason:'Move exact numeric evidence'})})`);
boundaryResult = await boundaryState();
check(boundaryResult.raw_exact && boundaryResult.read_exact && boundaryResult.applied_bounded && boundaryResult.before_bounded,'Relink retains exact boundary observation and bounded snapshots');
await one(`select custom_work_command('${nextId()}','unit',${sqlEdit(boundaryUnit,{dimension_observation:null,expected_fact_revision:2,dimension_observation_reason:'Clear exact numeric evidence'})})`);
check((await one(`select (r.before_snapshot->'raw_observation'->>'width') = (${boundary})->>'width' as exact from work_unit_fact_revisions r join work_unit_fact_current c on c.current_revision_id=r.id where c.unit_id='${boundaryUnit}'`)).exact,'Reset retains exact boundary numeric evidence in the before snapshot');
check((await one(`select work_unit_fact_current_read('${boundaryUnit}') as r`)).r.observation===null && (await factCount(boundaryUnit))===3,'Boundary create, relink and reset produce three immutable revisions');
const oversized = await boundaryObservation(4097), oversizedUnit=nextId();
const beforeOversized = await savedState();
await refuse(`select custom_work_command('${nextId()}','unit',${quote({id:oversizedUnit,revision:0,project_id:JOB_A,label:'Oversized observation',facts:{},expected_fact_revision:0})}::jsonb || jsonb_build_object('dimension_observation',${oversized}))`,'23514');
assert.deepEqual(await savedState(),beforeOversized,'4097-byte refusal preserves all operational/private/audit/receipt state'); checks++;
// Both 4000-character sources are legal only if their entire facts object
// also fits the existing 20000-byte validator. Two four-byte-only sources
// do not; this is an atomic validator refusal, not a private storage defect.
await atomicRefuse({id:nextId(),revision:0,project_id:JOB_A,label:'Invalid legacy total bytes',facts:{width_in:1,height_in:2,measurement_source:'😀'.repeat(4000),area_source:'😀'.repeat(4000)}},'P0001');
const nearLimitSource='😀'.repeat(1900)+'a'.repeat(2100), nearLimitUnit=nextId();
const nearLimitFacts={width_in:11,height_in:12,measurement_source:nearLimitSource,area_source:nearLimitSource};
const nearLimitSize=await one(`select length(${quote(nearLimitFacts)}::jsonb->>'measurement_source') as chars,octet_length((${quote(nearLimitFacts)}::jsonb)::text) as bytes`);
check(nearLimitSize.chars===4000 && nearLimitSize.bytes>19000 && nearLimitSize.bytes<=20000,'Positive legacy fixture has two maximum-character sources within the actual whole-facts byte limit');
await command('unit',{id:nearLimitUnit,revision:0,project_id:JOB_A,label:'Near-limit legacy evidence',facts:nearLimitFacts},nextId());
check((await currentFact(nearLimitUnit)).legacy_measurement_source===nearLimitSource && (await currentFact(nearLimitUnit)).legacy_area_source===nearLimitSource,'Both valid near-limit legacy sources remain exact');
await command('unit',await edit(nearLimitUnit,{facts:{},dimension_observation:obs(3,4,'in','plans',unicodeRef),expected_fact_revision:1}),nextId());
check((await currentFact(nearLimitUnit)).before_snapshot.measurement_source===nearLimitSource && (await currentFact(nearLimitUnit)).before_snapshot.area_source===nearLimitSource,'Explicit multibyte observation preserves both valid near-limit legacy sources in its before snapshot');
await command('link',await edit(nearLimitUnit,{project_id:JOB_B,reason:'Move multibyte observation'}),nextId());
check((await currentFact(nearLimitUnit)).raw_observation.sourceReference===unicodeRef,'Relink preserves maximum multibyte reference');
await command('unit',await edit(nearLimitUnit,{dimension_observation:null,expected_fact_revision:3,dimension_observation_reason:'Reset multibyte observation'}),nextId());
check((await currentFact(nearLimitUnit)).before_snapshot.raw_observation.sourceReference===unicodeRef && (await factCount(nearLimitUnit))===4,'Reset retains maximum multibyte raw reference and all prior revisions');
check((await one(`select bool_and(octet_length(applied_intent::text)<=32768 and (before_snapshot is null or octet_length(before_snapshot::text)<=32768)) as bounded from work_unit_fact_revisions where unit_id in ('${boundaryUnit}','${nearLimitUnit}')`)).bounded,'Every boundary and near-limit legacy revision fits the private JSON ceiling');

await db.close();
console.log(`Work unit observations: ${checks} checks passed.`);
