// Execute the actual new migration (20261108000000_work_configuration.sql) and
// the actual latest dormant foundation (20261107020000) plus their real
// dependency helper bodies on a disposable embedded PostgreSQL. Synthetic
// profiles/projects only -- no production credentials, no clocks/payroll
// changes. This is a source-driven sequential regression harness: a single
// embedded connection cannot prove advisory-lock/race correctness across
// independent backends, and none is claimed here. Real-schema CAS testing
// and rollback are parent release gates (ASTRA-CAPTURE-SQL-CONTRACT.md §7).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const one = async sql => (await db.query(sql)).rows[0];
const all = async sql => (await db.query(sql)).rows;
const refuse = async (sql, code = '23514') => {
  try { await db.exec(sql); assert.fail('Expected refusal: ' + sql); }
  catch (error) { assert.equal(error.code, code, sql + ' -> ' + error.code); checks++; }
};
const as = uid => db.exec(`select set_config('request.jwt.claim.sub','${uid}',false)`);
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

await db.exec(`create role authenticated; create role anon;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table profiles(id uuid primary key,role text,retired_at timestamptz,access_revoked_at timestamptz,
  is_partner boolean not null default false,is_test boolean not null default false);
create table projects(id uuid primary key,deleted_at timestamptz,is_test boolean not null default false);
create table project_openings(id uuid primary key,project_id uuid);
create table sandbox_projects(project_id uuid primary key);`);

for (const [file, names] of [
  ['20260730120000_test_accounts_excluded_from_learning.sql', ['is_test_profile']],
  ['20260730220000_test_accounts_sandbox_only.sql', ['is_sandbox_project', 'row_project_id', 'guard_test_account_sandbox_only']],
  ['20260810000000_team_timecards.sql', ['_is_supervisor']],
  ['20260967000000_sandbox_guard_rearm.sql', ['sandbox_scoped_tables', 'attach_sandbox_guards']],
  ['20261024000000_ai_field_operations.sql', ['_ai_job_visible']],
]) for (const name of names) await db.exec(migrationFunction(file, name));

// The actual dormant foundation this slice builds on, run verbatim.
await db.exec(readFileSync(new URL('../supabase/migrations/20261107020000_work_capture_foundation.sql', import.meta.url), 'utf8'));
// The actual new slice under review.
await db.exec(readFileSync(new URL('../supabase/migrations/20261108000000_work_configuration.sql', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Fixture people and jobs
// ---------------------------------------------------------------------------
const OWNER = id(1), SUPERVISOR = id(2), FOREMAN_GRANTED = id(3), FOREMAN_UNGRANTED = id(4),
  INSTALLER = id(5), RETIRED_OWNER = id(6), PARTNER_SUPERVISOR = id(7), TEST_LOGIN = id(8), TEST_FOREMAN = id(9), SECOND_OWNER = id(10);
const LIVE_JOB = id(50), DELETED_JOB = id(51), TEST_JOB = id(52);
await db.exec(`
insert into profiles(id,role) values('${OWNER}','owner'),('${SUPERVISOR}','supervisor'),
  ('${FOREMAN_GRANTED}','foreman'),('${FOREMAN_UNGRANTED}','foreman'),('${INSTALLER}','installer'),('${SECOND_OWNER}','owner');
insert into profiles(id,role,retired_at) values('${RETIRED_OWNER}','owner',now());
insert into profiles(id,role,is_partner) values('${PARTNER_SUPERVISOR}','supervisor',true);
insert into profiles(id,role,is_test) values('${TEST_LOGIN}','owner',true),('${TEST_FOREMAN}','foreman',true);
insert into projects(id) values('${LIVE_JOB}');
insert into projects(id,deleted_at) values('${DELETED_JOB}',now());
insert into projects(id,is_test) values('${TEST_JOB}',true);
insert into sandbox_projects(project_id) values('${TEST_JOB}');`);

const tf = (fieldId, type, extra = {}) => ({ id: fieldId, label_en: 'Field', label_es: 'Campo', type, required: false, ...extra });
const okFields = [tf('note', 'text'), tf('qty', 'number', { unit: 'count', min: 0, max: 9 }),
  tf('kind', 'single_select', { options: [{ id: 'a', label_en: 'A', label_es: 'A' }, { id: 'b', label_en: 'B', label_es: 'B' }] })];

// ---------------------------------------------------------------------------
// 1. Owner publish; supervisor and foreman refused on the same action
// ---------------------------------------------------------------------------
await as(OWNER);
await db.exec(`select work_publish_activity_version('${id(100)}','gathering',0,'general','Gathering','Reunir',false,'${JSON.stringify(okFields)}')`);
check((await one(`select version from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='gathering'`)).version === 1, 'Owner publish creates version 1');
const defaultEffectiveVersion = await one(`select published_at,effective_from from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='gathering' and v.version=1`);
check(Date.parse(defaultEffectiveVersion.effective_from) === Date.parse(defaultEffectiveVersion.published_at), 'Omitted effectiveFrom defaults to the server publication time');

await as(SUPERVISOR);
await refuse(`select work_publish_activity_version('${id(101)}','gathering',1,'general','Gathering','Reunir',false,'[]')`, '42501');
await as(FOREMAN_GRANTED);
await refuse(`select work_publish_activity_version('${id(102)}','gathering',1,'general','Gathering','Reunir',false,'[]')`, '42501');
await refuse(`select work_propose_activity_draft('${id(103)}','flashing',0,'specific','Flashing','Tapajuntas',false,'[]')`, '42501');

// Supervisor MAY draft/propose, just never publish/retire.
await as(SUPERVISOR);
await db.exec(`select work_propose_activity_draft('${id(104)}','flashing',0,'specific','Flashing','Tapajuntas',false,'[]')`);
check((await one(`select revision from work_configuration_draft_pointers where kind='activity' and code='flashing'`)).revision === 1, 'Supervisor draft advances pointer to 1');
await refuse(`select work_publish_activity_version('${id(105)}','flashing',0,'specific','Flashing','Tapajuntas',false,'[]')`, '42501');
await refuse(`select work_retire_activity('${id(106)}','gathering',1)`, '42501');

// ---------------------------------------------------------------------------
// 2. CAS, immutable history, reorder/rename creates a new version only
// ---------------------------------------------------------------------------
await as(OWNER);
await refuse(`select work_publish_activity_version('${id(107)}','gathering',0,'general','Gathering','Reunir',false,'[]')`); // stale expected version
await db.exec(`select work_publish_activity_version('${id(108)}','gathering',1,'general','Gathering (renamed)','Reunir',false,'[]')`);
check((await one(`select count(*)::int as n from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='gathering'`)).n === 2, 'Rename publishes a second version, not an update');
check((await one(`select label_en from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='gathering' and v.version=1`)).label_en === 'Gathering', 'Original version label is unchanged -- old versions never updated');
await refuse(`update work_configuration_commands set result='{}' where command_id='${id(100)}'`);
await refuse(`delete from work_configuration_draft_revisions where kind='activity' and code='flashing'`);

// ---------------------------------------------------------------------------
// 3. Typed field validation
// ---------------------------------------------------------------------------
const publishWith = (n, fields) => `select work_publish_activity_version('${id(n)}','validate_me',0,'general','V','V',false,'${JSON.stringify(fields)}')`;
const rawPublish = (command, code, expected, scope, en, es, machine, fields) =>
  `select work_publish_activity_version(${command},${code},${expected},${scope},${en},${es},${machine},${fields})`;
await refuse(publishWith(110, [{ id: 'x', label_en: 'X', label_es: 'X', type: 'text', required: false, unexpected: true }]));
await refuse(publishWith(111, [tf('dup', 'text'), tf('dup', 'number')]));
await refuse(publishWith(112, [tf('bad', 'not_a_type')]));
await refuse(publishWith(113, [tf('opt', 'text', { options: [{ id: 'a', label_en: 'A', label_es: 'A' }] })]));
await refuse(publishWith(114, [tf('needs', 'single_select')]));
await refuse(publishWith(115, [tf('range', 'number', { min: 5, max: 1 })]));
await refuse(publishWith(116, [tf('cnt', 'number', { unit: 'count', min: 1.5 })]));
await refuse(publishWith(117, [tf('dupopt', 'single_select', { options: [{ id: 'a', label_en: 'A', label_es: 'A' }, { id: 'a', label_en: 'A2', label_es: 'A2' }] })]));
await refuse(publishWith(1171, [{ id: 'null_en', label_en: null, label_es: 'X', type: 'text', required: false }]));
await refuse(publishWith(1172, [{ id: 'null_es', label_en: 'X', label_es: null, type: 'text', required: false }]));
await refuse(publishWith(1173, [{ id: 'null_type', label_en: 'X', label_es: 'X', type: null, required: false }]));
await refuse(publishWith(1174, [{ id: 'null_required', label_en: 'X', label_es: 'X', type: 'text', required: null }]));
await refuse(publishWith(1175, [{ id: null, label_en: 'X', label_es: 'X', type: 'text', required: false }]));
await db.exec(publishWith(118, okFields));

const allowedUnits = ['count','in','ft','mm','cm','sq_ft','sq_m','min','h','lb','kg'];
const publishNamed = (n, code, fields) => rawPublish(`'${id(n)}'`, `'${code}'`, '0', `'general'`, `'Units'`, `'Unidades'`, 'false', `'${JSON.stringify(fields)}'`);
await db.exec(publishNamed(1181, 'known_units', allowedUnits.map((unit, i) => tf(`measure_${i}`, 'number', { unit }))));
await refuse(publishNamed(1182, 'unknown_unit', [tf('money', 'number', { unit: 'dollars' })]));
await refuse(publishNamed(1183, 'text_with_unit', [tf('label', 'text', { unit: 'in' })]));
await refuse(publishNamed(1184, 'boolean_with_bounds', [tf('flag', 'boolean', { min: 0 })]));
await refuse(publishNamed(1185, 'select_with_max', [tf('choice', 'single_select', { options: [{ id: 'a', label_en: 'A', label_es: 'A' }], max: 3 })]));
await refuse(publishNamed(1186, 'negative_count', [tf('count', 'number', { unit: 'count', min: -1 })]));
await refuse(publishNamed(1187, 'unsafe_count', [tf('count', 'number', { unit: 'count', max: 9007199254740992 })]));
for (const [n, bound, literal] of [[1188, 'max', '1e309'], [1189, 'min', '-1e309']]) {
  const fieldJson = JSON.stringify([tf('value', 'number')]).replace('"required":false', `"required":false,"${bound}":${literal}`);
  await refuse(rawPublish(`'${id(n)}'`, `'overflow_${bound}'`, '0', `'general'`, `'V'`, `'V'`, 'false', `'${fieldJson}'`));
}
await db.exec(publishNamed(11810, 'safe_count', [tf('count', 'number', { unit: 'count', min: 0, max: 9007199254740991 })]));
check((await one("select v.typed_fields->0->>'max' as bound from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='safe_count'")).bound === '9007199254740991', 'Count maximum retains the exact safe integer');
await db.exec(publishNamed(11811, 'finite_limits', [tf('value', 'number', { min: -Number.MAX_VALUE, max: Number.MAX_VALUE })]));
check((await one("select count(*)::int as n from work_activity_definitions where code='finite_limits'")).n === 1, 'Finite JavaScript numeric limits are accepted');



await db.exec(`select work_publish_activity_version('${id(1210)}','future_activity',0,'specific','Future','Futuro',false,'[]',now()+interval '1 day')`);
const futureActivityVersion = await one(`select d.id as definition_id,v.id as version_id,v.published_at,v.effective_from from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code='future_activity'`);
check(Date.parse(futureActivityVersion.effective_from) > Date.parse(futureActivityVersion.published_at), 'Future activity publication retains distinct publishedAt/effectiveFrom');

await refuse(rawPublish('NULL', `'null_code'`, '0', `'general'`, `'X'`, `'X'`, 'false', `'[]'`));
await refuse(rawPublish(`'${id(119)}'`, `'validate_me'`, 'NULL', `'general'`, `'X'`, `'X'`, 'false', `'[]'`));
await refuse(rawPublish(`'${id(1191)}'`, `'validate_me'`, '0', 'NULL', `'X'`, `'X'`, 'false', `'[]'`));
await refuse(rawPublish(`'${id(1192)}'`, `'validate_me'`, '0', `'general'`, 'NULL', `'X'`, 'false', `'[]'`));
await refuse(rawPublish(`'${id(1193)}'`, `'validate_me'`, '0', `'general'`, `'X'`, 'NULL', 'false', `'[]'`));
await refuse(rawPublish(`'${id(1194)}'`, `'validate_me'`, '0', `'general'`, `'X'`, `'X'`, 'NULL', `'[]'`));
await refuse(rawPublish(`'${id(1195)}'`, `'validate_me'`, '0', `'general'`, `'X'`, `'X'`, 'false', 'NULL'));
await refuse(rawPublish('NULL', `'null_command'`, '0', `'general'`, `'X'`, `'X'`, 'false', `'[]'`));
await refuse(`select work_propose_activity_draft('${id(1197)}',NULL,0,'general','X','X',false,'[]')`);
await refuse(`select work_propose_activity_draft('${id(1198)}','draft_null_rev',NULL,'general','X','X',false,'[]')`);
await refuse(`select work_propose_activity_draft('${id(1199)}','draft_null_scope',0,NULL,'X','X',false,'[]')`);
await refuse(`select work_propose_activity_draft('${id(1200)}','draft_null_label_en',0,'general',NULL,'X',false,'[]')`);
await refuse(`select work_propose_activity_draft('${id(1201)}','draft_null_label_es',0,'general','X',NULL,false,'[]')`);
await refuse(`select work_propose_activity_draft('${id(1202)}','draft_null_machine',0,'general','X','X',NULL,'[]')`);
await refuse(`select work_propose_activity_draft('${id(1203)}','draft_null_fields',0,'general','X','X',false,NULL)`);
await refuse(`select work_propose_activity_draft(NULL,'draft_null_command',0,'general','X','X',false,'[]')`);

// ---------------------------------------------------------------------------
// 4. Publish a menu (existing work_capture_validate_menu enforces real
//    definition version ids), then retire the underlying activity and
//    confirm the historical version remains readable but selection refuses.
// ---------------------------------------------------------------------------
const validateMeVersion = await one(`select v.id as id, v.definition_id as definition_id from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='validate_me'`);
const menuItems = [{ definitionId: validateMeVersion.definition_id, versionId: validateMeVersion.id, position: 0, enabled: true }];
await db.exec(`select work_publish_menu_version('${id(120)}','fixture_menu',0,'Menu','Menu','${JSON.stringify(menuItems)}')`);

await refuse(`select work_publish_menu_version(NULL,'bad_menu_command',0,'Menu','Menu','[]')`);
await refuse(`select work_publish_menu_version('${id(1201)}',NULL,0,'Menu','Menu','[]')`);
await refuse(`select work_publish_menu_version('${id(1202)}','null_menu_rev',NULL,'Menu','Menu','[]')`);
await refuse(`select work_publish_menu_version('${id(1203)}','null_menu_label_en',0,NULL,'Menu','[]')`);
await refuse(`select work_publish_menu_version('${id(1204)}','null_menu_label_es',0,'Menu',NULL,'[]')`);
await refuse(`select work_publish_menu_version('${id(1205)}','null_menu_items',0,'Menu','Menu',NULL)`);
await refuse(`select work_publish_menu_version('${id(1206)}','past_menu',0,'Menu','Menu','[]',now()-interval '1 day')`);
await refuse(`select work_publish_menu_version('${id(1207)}','infinite_menu',0,'Menu','Menu','[]','infinity'::timestamptz)`);

const menuVersionId = (await one(`select mv.id as id from work_capture_menu_versions mv join work_capture_menus m on m.id=mv.menu_id where m.code='fixture_menu'`)).id;

const futureMenuItems = [{ definitionId: futureActivityVersion.definition_id, versionId: futureActivityVersion.version_id, position: 0, enabled: true }];
await db.exec(`select work_publish_menu_version('${id(1211)}','future_menu',0,'Future','Futuro','${JSON.stringify(futureMenuItems)}')`);
await db.exec(`select work_publish_menu_version('${id(1213)}','future_effective_menu',0,'Future effective','Futuro','${JSON.stringify(menuItems)}',now()+interval '1 day')`);
const futureEffectiveMenuId = (await one(`select mv.id as id from work_capture_menu_versions mv join work_capture_menus m on m.id=mv.menu_id where m.code='future_effective_menu'`)).id;
const futureMenuVersionId = (await one(`select mv.id as id from work_capture_menu_versions mv join work_capture_menus m on m.id=mv.menu_id where m.code='future_menu'`)).id;
await as(OWNER);
await refuse(`select work_select_job_menu('${id(1212)}','${LIVE_JOB}','${futureMenuVersionId}',0)`); // reaches future activity eligibility at the current selection revision
await refuse(`select work_select_job_menu('${id(1214)}','${LIVE_JOB}','${futureEffectiveMenuId}',0)`); // reaches future menu eligibility at the current selection revision
check((await one(`select count(*)::int as n from work_job_menu_selections where project_id='${LIVE_JOB}'`)).n === 0, 'Future-effective selection refusals leave the job pointer untouched');
check((await one(`select count(*)::int as n from work_configuration_commands where command_id in ('${id(1212)}','${id(1214)}')`)).n === 0, 'Future-effective selection refusals leave no command receipts');


// ---------------------------------------------------------------------------
// 5. Job menu selection: owner/supervisor on a visible job; granted vs
//    ungranted foreman; deleted job; hidden test job for a non-test foreman.
// ---------------------------------------------------------------------------
const emptyCompanyJob = (await one(`select work_configuration_snapshot('${LIVE_JOB}') as s`)).s;
check(emptyCompanyJob.projectId === LIVE_JOB && emptyCompanyJob.currentSelection === null && Number.isFinite(Date.parse(emptyCompanyJob.asOf)), 'Company snapshot binds an unselected job and explicit null selection with asOf');
await as(INSTALLER);
const emptyCrewJob = (await one(`select work_configuration_snapshot('${LIVE_JOB}') as s`)).s;
check(emptyCrewJob.projectId === LIVE_JOB && emptyCrewJob.menu === null && Number.isFinite(Date.parse(emptyCrewJob.asOf)), 'Crew empty-menu snapshot retains job context and asOf');
await as(OWNER);
await db.exec(`select work_select_job_menu('${id(130)}','${LIVE_JOB}','${menuVersionId}',0)`);
check((await one(`select revision from work_job_menu_selections where project_id='${LIVE_JOB}'`)).revision === 1, 'Owner selects job menu, revision 1');
await refuse(`select work_select_job_menu('${id(131)}','${DELETED_JOB}','${menuVersionId}',0)`, '42501');

// _ai_job_visible's "is_test" branch treats owner/supervisor as able to see a
// test job too (_is_supervisor includes 'owner'); the hidden-test-job case is
// a non-supervisor foreman, who has no exception for a test job.
await as(FOREMAN_UNGRANTED);
await refuse(`select work_select_job_menu('${id(132)}','${TEST_JOB}','${menuVersionId}',0)`, '42501');
await refuse(`select work_select_job_menu('${id(133)}','${LIVE_JOB}','${menuVersionId}',1)`, '42501');

// A test login (profiles.is_test, sandbox_projects boundary) still only
// manages a job the sandbox guard actually lists: TEST_JOB is in
// sandbox_projects, so it is visible to the test login's own owner role.
await as(TEST_LOGIN);
await db.exec(`select work_select_job_menu('${id(1320)}','${TEST_JOB}','${menuVersionId}',0)`);
check((await one(`select revision from work_job_menu_selections where project_id='${TEST_JOB}'`)).revision === 1, 'Test login manages the sandboxed test job it is actually scoped to');

await as(SUPERVISOR);
const menuGrant = (await one(`select work_grant_job_capability('${id(134)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select')`)).work_grant_job_capability;
const menuGrantId = menuGrant.grantId;
check(typeof menuGrantId === 'string', 'Grant result exposes its exact grantId for compare-and-revoke');
await refuse(`select work_grant_job_capability('${id(135)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select')`, '23505'); // duplicate active grant
await refuse(`select work_grant_job_capability('${id(136)}','${LIVE_JOB}','${SUPERVISOR}','menu_select')`, '42501'); // no self authority
await refuse(`select work_grant_job_capability('${id(137)}','${LIVE_JOB}','${INSTALLER}','menu_select')`); // only an active foreman may receive this grant
await refuse(`select work_grant_job_capability('${id(1371)}','${LIVE_JOB}','${TEST_FOREMAN}','menu_select')`); // test foremen never receive real-job authority

await as(FOREMAN_GRANTED);
await db.exec(`select work_select_job_menu('${id(138)}','${LIVE_JOB}','${menuVersionId}',1)`);
check((await one(`select revision from work_job_menu_selections where project_id='${LIVE_JOB}' order by revision desc limit 1`)).revision === 2, 'Granted foreman advances revision to 2');
await refuse(`select work_job_capability_grants('${LIVE_JOB}')`, '42501'); // grant-list read is owner/supervisor only

await as(SUPERVISOR);
await db.exec(`select work_revoke_job_capability('${id(139)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select','${menuGrantId}')`); // revoke generation A
const replacementGrant = (await one(`select work_grant_job_capability('${id(1391)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select')`)).work_grant_job_capability;
check(replacementGrant.grantId !== menuGrantId, 'Regrant creates a distinct grant generation B');
await refuse(`select work_revoke_job_capability('${id(140)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select','${menuGrantId}')`); // stale generation A cannot revoke B
check((await one(`select count(*)::int as n from work_job_management_grants where id='${replacementGrant.grantId}' and revoked_at is null`)).n === 1, 'Replacement grant B remains active after stale-A revoke is refused');
await refuse(`select work_revoke_job_capability('${id(1401)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select',NULL)`); // expected grant id is mandatory
await db.exec(`select work_revoke_job_capability('${id(1402)}','${LIVE_JOB}','${FOREMAN_GRANTED}','menu_select','${replacementGrant.grantId}')`);
await as(FOREMAN_GRANTED);
await refuse(`select work_select_job_menu('${id(141)}','${LIVE_JOB}','${menuVersionId}',2)`, '42501'); // revoked grant no longer authorizes

await as(SUPERVISOR);
const grantRows = await all(`select work_job_capability_grants('${LIVE_JOB}')`);
check(grantRows[0].work_job_capability_grants.grants.length === 2 && grantRows[0].work_job_capability_grants.grants.every(g => g.revokedAt), 'Supervisor sees both revoked grant generations in the bounded audit list');

// ---------------------------------------------------------------------------
// 6. Retire: owner only; historical version stays readable; selection on a
//    retired activity's menu is refused.
// ---------------------------------------------------------------------------
await as(OWNER);
await refuse(`select work_retire_activity('${id(1410)}','validate_me',0)`); // stale expected latest version
await db.exec(`select work_retire_activity('${id(142)}','validate_me',1)`);
await db.exec(`select work_retire_activity('${id(142)}','validate_me',1)`); // exact replay is safe
await refuse(`select work_retire_activity('${id(143)}','validate_me',1)`); // already retired, different command id
await refuse(`select work_publish_activity_version('${id(1431)}','validate_me',1,'general','V','V',false,'[]')`); // retirement is terminal; never republish this code
check((await one(`select version from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='validate_me' and v.version=1`)).version === 1, 'Retired activity keeps its historical published version readable');
await refuse(`select work_select_job_menu('${id(144)}','${LIVE_JOB}','${menuVersionId}',2)`); // menu now includes a retired activity
await refuse(`select work_select_job_menu('${id(1441)}','${LIVE_JOB}','${menuVersionId}',NULL)`); // expected selection revision is mandatory
await refuse(`select work_select_job_menu(NULL,'${LIVE_JOB}','${menuVersionId}',2)`); // command UUID is mandatory
await refuse(`select work_retire_menu('${id(1442)}','fixture_menu',0)`); // stale expected version
await db.exec(`select work_retire_menu('${id(1443)}','fixture_menu',1)`);
await refuse(`select work_publish_menu_version('${id(1444)}','fixture_menu',1,'Menu','Menu','${JSON.stringify(menuItems)}')`); // retired menu cannot be republished

// ---------------------------------------------------------------------------
// 7. Exact replay, changed-payload conflict, foreign-actor refusal
// ---------------------------------------------------------------------------
await as(OWNER);
const replayCall = `select work_publish_activity_version('${id(150)}','replayed',0,'general','Replay','Replay',false,'[]')`;
const replay1 = (await one(replayCall)).work_publish_activity_version;
const replay2 = (await one(replayCall)).work_publish_activity_version;

const replayReceipt = await one(`select normalized_payload,payload_hash from work_configuration_commands where command_id='${id(150)}'`);
assert.deepEqual(replayReceipt.normalized_payload, { code: 'replayed', expectedLatestVersion: 0, scope: 'general', labelEn: 'Replay', labelEs: 'Replay', machineSelection: false, typedFields: [], effectiveFrom: null });
check(replayReceipt.payload_hash.length === 64, 'Receipt stores the canonical SHA-256 digest beside its normalized payload');

check(JSON.stringify(replay1) === JSON.stringify(replay2), 'Exact replay (same actor, same payload) returns the original result');
check((await one(`select count(*)::int as n from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='replayed'`)).n === 1, 'Exact replay mutates nothing a second time');
await refuse(`select work_publish_activity_version('${id(150)}','replayed',0,'general','Replay (changed)','Replay',false,'[]')`); // same command id, changed payload
await as(SECOND_OWNER);
await refuse(`select work_publish_activity_version('${id(150)}','replayed',0,'general','Replay','Replay',false,'[]')`, '42501'); // another owner reaches receipt actor isolation and never receives the original result

// ---------------------------------------------------------------------------
// 8. Inactive and partner accounts never pass as actor
// ---------------------------------------------------------------------------
await as(RETIRED_OWNER);
await refuse(`select work_publish_activity_version('${id(160)}','blocked',0,'general','B','B',false,'[]')`, '42501');
await as(PARTNER_SUPERVISOR);
await refuse(`select work_propose_activity_draft('${id(161)}','blocked',0,'general','B','B',false,'[]')`, '42501');
await db.exec("select set_config('request.jwt.claim.sub','',false)");
await refuse(`select work_publish_activity_version('${id(162)}','blocked',0,'general','B','B',false,'[]')`, '42501');

// ---------------------------------------------------------------------------
// 9. Snapshot: owner/supervisor see the catalog and drafts; ordinary crew
//    see only their visible job's frozen choice; no cross-job leakage.
// ---------------------------------------------------------------------------
await as(SUPERVISOR);
const companySnapshot = (await one(`select work_configuration_snapshot(null) as s`)).s;
check(companySnapshot.role === 'company' && Array.isArray(companySnapshot.drafts) && companySnapshot.drafts.length > 0, 'Owner/supervisor snapshot includes company drafts');
check(companySnapshot.projectId === null && companySnapshot.currentSelection === null && Number.isFinite(Date.parse(companySnapshot.asOf)), 'Global company snapshot has explicit null job/selection and valid asOf');
const activityDraft = companySnapshot.drafts.find(d => d.kind === 'activity' && d.code === 'flashing');
check(activityDraft?.body?.scope === 'specific' && activityDraft?.body?.typedFields?.length === 0, 'Company snapshot exposes the exact latest draft body');
check(activityDraft?.proposedBy === SUPERVISOR && Number.isFinite(Date.parse(activityDraft?.createdAt)), 'Draft snapshot identifies its proposer and creation time');
const futureSnapshotActivity = companySnapshot.activities.find(a => a.code === 'future_activity')?.versions?.[0];
check(futureSnapshotActivity?.effectiveFrom && futureSnapshotActivity?.publishedAt && futureSnapshotActivity?.eligibleNow === false, 'Company snapshot exposes publication/effective times and marks future versions ineligible now');
await as(INSTALLER);
await refuse(`select work_configuration_snapshot(null)`, '23514'); // crew must name a visible job
const crewSnapshot = (await one(`select work_configuration_snapshot('${LIVE_JOB}') as s`)).s;
check(crewSnapshot.role === 'crew' && crewSnapshot.menu && !('drafts' in crewSnapshot), 'Crew snapshot is the frozen job menu only, no drafts or raw commands');
check(crewSnapshot.projectId === LIVE_JOB && Number.isFinite(Date.parse(crewSnapshot.asOf)), 'Selected crew snapshot retains exact job and asOf');
const retiredFrozenActivity = crewSnapshot.menu.activities.find(a => a.versionId === validateMeVersion.id);
check(retiredFrozenActivity?.enabled === true && retiredFrozenActivity?.eligibleNow === false, 'Frozen enabled choice remains visible while a retired activity is marked ineligible now');
await refuse(`select work_configuration_snapshot('${DELETED_JOB}')`, '23514');
await as(TEST_LOGIN);
await refuse(`select work_configuration_snapshot(null)`, '23514'); // sandbox owner may not read global company configuration
await refuse(`select work_publish_activity_version('${id(163)}','qa_global',0,'general','QA','QA',false,'[]')`, '42501');
await refuse(`select work_retire_activity('${id(164)}','gathering',1)`, '42501');
await refuse(`select work_propose_activity_draft('${id(165)}','qa_draft',0,'general','QA','QA',false,'[]')`, '42501');

// ---------------------------------------------------------------------------
// 10. No raw grants on the new private tables
// ---------------------------------------------------------------------------
for (const table of ['work_configuration_commands', 'work_configuration_draft_revisions', 'work_configuration_draft_pointers']) {
  check((await one(`select relrowsecurity as enabled from pg_class where oid='public.${table}'::regclass`)).enabled, table + ' RLS enabled');
  for (const role of ['authenticated', 'anon'])
    check(!(await one(`select has_table_privilege('${role}','public.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed`)).allowed, role + ' has no raw table privileges including TRUNCATE on ' + table);
}
check((await one("select count(*)::int as n from pg_policies where tablename in ('work_configuration_commands','work_configuration_draft_revisions','work_configuration_draft_pointers')")).n === 0, 'No raw policy on the new tables');
await as(OWNER);
await db.exec('set role authenticated');
try {
  await db.query('select * from public.work_configuration_commands limit 1');
  assert.fail('SET ROLE authenticated must not read the private command ledger');
} catch (error) { assert.equal(error.code, '42501'); checks++; }
try {
  const rpc = await db.query('select public.work_configuration_snapshot(null) as snapshot');
  check(rpc.rows[0].snapshot.role === 'company', 'Authenticated caller can use the authorized snapshot RPC despite no raw table access');
} finally { await db.exec('reset role'); }

await db.close();
console.log(`Work configuration: ${checks} checks passed; no activity capture, timing lock, or production CAS claimed.`);
