// Forge AI daily-log contributions against real migrations in a disposable
// PGlite database. Synthetic people and jobs only; no network, no crew data.
//   PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node scripts/verify-ai-daily-logs.mjs
// Real concurrent sessions are scripts/test-ai-daily-logs-postgres.sh.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const migration = (name) => read('supabase/migrations/' + name);

await db.exec(await read('scripts/tests/ai-daily-logs/setup.sql'));
await db.exec(await migration('20260949000000_daily_logs.sql'));
await db.exec(await migration('20260951000000_share_with_builder.sql'));
await db.exec(await migration('20261014000000_installer_daily_reporting.sql'));
// The job boundary the AI field tools already use, taken from its migration.
const field = await migration('20261024000000_ai_field_operations.sql');
const visible = /create function public\._ai_job_visible[\s\S]*?\n\$\$;/.exec(field);
assert.ok(visible, '_ai_job_visible is in 20261024000000');
await db.exec(visible[0]);
// person_record_counts names tables these stubs do not create.
await db.exec('set check_function_bodies = off');
const contributions = await migration('20261030000000_ai_daily_log_contributions.sql');
await db.exec(contributions);
await db.exec(contributions); // the deploy can be retried
await db.exec('set check_function_bodies = on');
await db.exec('grant select,insert,update,delete on daily_logs, daily_log_contributions, daily_log_contribution_photos to authenticated');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANA = 1, FRANK = 2, SAM = 3, OWEN = 4, PARTNER = 5, REVOKED = 6, RETIRED = 7, TESTER = 8, NOBODY_ROLE = 9, OFF = 10, BEN = 11;
const people = [[ANA, 'installer', 'Ana'], [FRANK, 'foreman', 'Frank'], [SAM, 'supervisor', 'Sam'], [OWEN, 'owner', 'Owen'],
  [PARTNER, 'installer', 'Builder'], [REVOKED, 'installer', 'Rex'], [RETIRED, 'installer', 'Rae'], [TESTER, 'installer', 'Test bot'],
  [NOBODY_ROLE, 'unknown', 'Una'], [OFF, 'installer', 'Olga'], [BEN, 'installer', 'Ben']];
for (const [n, role, name] of people) {
  await db.query('insert into profiles(id, role, display_name) values($1,$2,$3)', [id(n), role, name]);
  await db.query('insert into auth.users(id, email) values($1,$2)', [id(n), `${name.toLowerCase().replace(/ /g, '')}@example.test`]);
}
await db.query('update profiles set partner=true where id=$1', [id(PARTNER)]);
await db.query('update profiles set access_revoked_at=now() where id=$1', [id(REVOKED)]);
await db.query('update profiles set retired_at=now() where id=$1', [id(RETIRED)]);
await db.query('update profiles set is_test=true where id=$1', [id(TESTER)]);
await db.query('update profiles set active=false where id=$1', [id(OFF)]);
const JOB = id(90), OTHER = id(91), GONE = id(92), SANDBOX = id(93), TESTJOB = id(94);
await db.query(`insert into projects(id,name,deleted_at,is_test) values ($1,'Synthetic A',null,false),($2,'Synthetic B',null,false),
  ($3,'Removed',now(),false),($4,'Sandbox',null,true),($5,'Practice',null,true)`, [JOB, OTHER, GONE, SANDBOX, TESTJOB]);
await db.query('insert into sandbox_projects values($1)', [SANDBOX]);

let checks = 0;
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (v, message) => { assert.ok(v, message); checks++; };
let who = null;
async function as(n) {
  who = n ? id(n) : null;
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [n ? id(n) : '']);
  await db.exec('set role authenticated');
}
async function denied(fn, code) {
  try { await fn(); } catch (e) { if (code) assert.equal(e.code, code, e.message); checks++; return e; }
  assert.fail('expected a refusal');
}
const answers = (work, extra = {}) => ({ work_completed: { status: 'captured', value: work, source: 'said' }, ...extra });
// p_actor defaults to whoever as() signed in: the phone names its own account.
async function append({ cid, project = JOB, day = 'current_date - 1', expected, ans, body, photos = [], sources = [], actor = who }) {
  const { rows } = await db.query(
    `select append_daily_log_contribution($1,$2,$3,${day},$4,$5::jsonb,$6,$7::uuid[],$8::uuid[]) r`,
    [cid, actor, project, expected, JSON.stringify(ans), body ?? ans.work_completed?.value ?? 'Work', photos, sources]);
  return rows[0].r;
}
const count = async (table) => { await db.exec('reset role'); return (await db.query(`select count(*)::int n from ${table}`)).rows[0].n; };
const log = async () => { await db.exec('reset role'); return (await db.query("select * from daily_logs where project_id=$1 and log_date=current_date-1", [JOB])).rows[0]; };

// ---- Installer starts the job-day log -------------------------------------
await as(ANA);
const C1 = id(1001);
const first = await append({ cid: C1, expected: 0, ans: answers('Set 6 frames on the east wall', {
  day_flow: { status: 'captured', value: 'fine' }, weather: { status: 'unknown' }, people: { status: 'captured', value: 'Ana and Ben' },
  went_well: { status: 'captured', value: 'Deliveries on time' } }), body: 'Work completed: Set 6 frames on the east wall\nPeople: Ana and Ben' });
equal(first.status, 'saved');
equal(first.created_log, true);
equal(first.base_revision, 0);
equal(first.saved_revision, 1);
equal(first.actor_name, 'Ana');
equal(first.log.filed_by, id(ANA));
equal(first.log.notes, 'Added by Ana with Forge AI:\nWork completed: Set 6 frames on the east wall\nPeople: Ana and Ben');
equal(first.log.day_flow, 'fine');
equal(first.log.weather, null, 'weather said unknown is not invented');
equal(first.log.reflection, { went_well: 'Deliveries on time' });

// ---- Double tap: the same words under the same id save once ----------------
const again = await append({ cid: C1, expected: 0, ans: answers('Set 6 frames on the east wall', {
  day_flow: { status: 'captured', value: 'fine' }, weather: { status: 'unknown' }, people: { status: 'captured', value: 'Ana and Ben' },
  went_well: { status: 'captured', value: 'Deliveries on time' } }), body: 'Work completed: Set 6 frames on the east wall\nPeople: Ana and Ben' });
equal(again.status, 'already_saved');
equal(again.contribution_id, C1);
equal(await count('daily_log_contributions'), 1);
equal(Number((await log()).revision), 1);

// ---- Ben adds his part: appended, never replacing Ana's --------------------
await as(BEN);
const C2 = id(1002);
const ben = await append({ cid: C2, expected: 1, ans: answers('Flashed units 3 and 4', {
  day_flow: { status: 'captured', value: 'stuck' }, weather: { status: 'captured', value: 'Windy' },
  went_well: { status: 'captured', value: 'Should not replace Ana' }, went_poorly: { status: 'captured', value: 'Lift arrived late' } }),
  body: 'Work completed: Flashed units 3 and 4' });
equal(ben.status, 'saved');
equal(ben.created_log, false);
equal(ben.saved_revision, 2);
const afterBen = await log();
equal(afterBen.filed_by, id(ANA), 'first author kept');
equal(afterBen.updated_by, id(BEN));
ok(afterBen.notes.startsWith('Added by Ana with Forge AI:\nWork completed: Set 6 frames'), 'Ana first');
ok(afterBen.notes.endsWith('\n\nAdded by Ben with Forge AI:\nWork completed: Flashed units 3 and 4'), 'Ben appended');
equal(afterBen.day_flow, 'fine', 'existing day flow kept');
equal(afterBen.weather, 'Windy', 'empty weather filled');
equal(afterBen.reflection, { went_well: 'Deliveries on time', went_poorly: 'Lift arrived late' }, 'only empty reflections filled');

// ---- Lost response: Ana's phone retries after the log has moved on ---------
await as(ANA);
const retried = await append({ cid: C1, expected: 0, ans: answers('Set 6 frames on the east wall', {
  day_flow: { status: 'captured', value: 'fine' }, weather: { status: 'unknown' }, people: { status: 'captured', value: 'Ana and Ben' },
  went_well: { status: 'captured', value: 'Deliveries on time' } }), body: 'Work completed: Set 6 frames on the east wall\nPeople: Ana and Ben' });
equal(retried.status, 'already_saved', 'a retry is not stale and is not a second copy');
equal(retried.saved_revision, 1);
equal(retried.log.revision, 2);
equal((await log()).notes.split('Added by Ana').length - 1, 1);
// A used id with different words, or someone else's id, is refused.
await as(ANA);
await denied(() => append({ cid: C1, expected: 2, ans: answers('Different words') }), '22023');
await as(FRANK);
await denied(() => append({ cid: C2, expected: 2, ans: answers('Flashed units 3 and 4', {
  day_flow: { status: 'captured', value: 'stuck' }, weather: { status: 'captured', value: 'Windy' },
  went_well: { status: 'captured', value: 'Should not replace Ana' }, went_poorly: { status: 'captured', value: 'Lift arrived late' } }),
  body: 'Work completed: Flashed units 3 and 4' }), '22023');

// ---- Stale preview: nothing written, the current log comes back -------------
await as(FRANK);
const beforeStale = await log();
await as(FRANK);
const stale = await append({ cid: id(1003), expected: 1, ans: answers('Cleaned up the site') });
equal(stale.status, 'stale');
equal(stale.current_revision, 2);
equal(stale.log.notes, beforeStale.notes);
equal(await count('daily_log_contributions'), 2);
equal(Number((await log()).revision), 2);
// The same draft saved against the revision it was just shown succeeds.
await as(FRANK);
equal((await append({ cid: id(1003), expected: 2, ans: answers('Cleaned up the site') })).status, 'saved');

// ---- The manual editor still works, and makes open previews stale ----------
await as(SAM);
await db.query("select file_daily_log($1, current_date - 1, p_notes => $2)", [JOB, 'Supervisor rewrote the log by hand']);
const manual = await log();
equal(Number(manual.revision), 4);
await as(SAM);
await db.query('select set_log_customer_visible($1,true)', [manual.id]);
equal(Number((await log()).revision), 4, 'sharing with the builder does not change what the log says');
await as(OWEN);
equal((await append({ cid: id(1004), expected: 3, ans: answers('Owner note') })).status, 'stale');
await as(OWEN);
equal((await append({ cid: id(1004), expected: 4, ans: answers('Owner note') })).status, 'saved');

// ---- Unknown stays unknown; missing stays absent ---------------------------
await as(FRANK);
const other = await append({ cid: id(1005), project: OTHER, expected: 0, ans: answers('Measured openings', {
  problems: { status: 'unknown' }, weather: { status: 'unknown' } }) });
equal(other.log.weather, null);
await db.exec('reset role');
const stored = (await db.query('select answers from daily_log_contributions where id=$1', [id(1005)])).rows[0].answers;
equal(stored.problems, { status: 'unknown' });
equal('units_stages' in stored, false);

// ---- Validation ------------------------------------------------------------
await as(ANA);
for (const bad of [
  {}, { work_completed: { status: 'unknown' } }, { work_completed: { status: 'captured', value: '  ' } },
  answers('x', { invented_field: { status: 'captured', value: 'y' } }), answers('x', { weather: 'sunny' }),
  answers('x', { weather: { status: 'guessed', value: 'sunny' } }), answers('x', { day_flow: { status: 'captured', value: 'great' } }),
]) await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 1, ans: bad, body: 'x' }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 1, ans: answers('x'), body: '   ' }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 1, ans: answers('x'), body: 'x'.repeat(8001) }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: -1, ans: answers('x') }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, day: 'current_date + 1', expected: 0, ans: answers('x') }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, day: 'null', expected: 0, ans: answers('x') }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: GONE, expected: 0, ans: answers('x') }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: id(95), expected: 0, ans: answers('x') }), '22023');
await denied(() => append({ cid: null, project: OTHER, expected: 1, ans: answers('x') }), '22023');
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 1, ans: answers('x'),
  photos: Array.from({ length: 13 }, () => crypto.randomUUID()) }), '22023');
const twice = crypto.randomUUID();
await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 1, ans: answers('x'), photos: [twice, twice] }), '22023');
equal(await count('daily_log_contributions'), 5, 'no refused save left a row');

// ---- Who may contribute ----------------------------------------------------
for (const n of [OFF]) { await as(n); equal((await append({ cid: id(2000 + n), day: 'current_date - 3', expected: 0, ans: answers('Off today, still reporting') })).status, 'saved'); }
for (const n of [PARTNER, REVOKED, RETIRED, NOBODY_ROLE, 0]) {
  await as(n);
  await denied(() => append({ cid: id(3000 + n), day: 'current_date - 3', expected: 1, ans: answers('Must not save') }), n === NOBODY_ROLE || n === 0 || n === PARTNER || n === REVOKED || n === RETIRED ? '42501' : undefined);
  await as(n);
  equal((await db.query('select count(*)::int n from daily_log_contributions')).rows[0].n, 0, 'nothing readable');
}
await db.exec('reset role; set role anon');
await denied(() => db.query('select append_daily_log_contribution($1,$2,$3,current_date,0,$4::jsonb,$5,$6::uuid[],$7::uuid[])', [id(3999), id(ANA), JOB, JSON.stringify(answers('x')), 'x', [], []]));
// A test login is fenced to the sandbox; real crew never reach a practice job.
await as(TESTER);
await denied(() => append({ cid: id(4001), day: 'current_date - 5', expected: 0, ans: answers('Test on a real job') }), '22023');
await as(TESTER);
equal((await append({ cid: id(4002), project: SANDBOX, expected: 0, ans: answers('Sandbox entry') })).status, 'saved');
await as(ANA);
await denied(() => append({ cid: id(4003), project: TESTJOB, expected: 0, ans: answers('Practice job') }), '22023');
// Readers: installers and up see contributions; direct writes go nowhere.
await as(ANA);
ok((await db.query('select count(*)::int n from daily_log_contributions')).rows[0].n >= 6, 'installer reads');
await as(ANA);
await denied(() => db.query("insert into daily_log_contributions(id,log_id,project_id,log_date,actor_id,answers,body,content_hash,base_revision,saved_revision,created_log) select gen_random_uuid(),id,project_id,log_date,$1,'{}','x','x',0,1,false from daily_logs limit 1", [id(ANA)]));
await as(ANA);
equal((await db.query("update daily_log_contributions set body='changed' returning id")).rows.length, 0);
await as(ANA);
equal((await db.query('delete from daily_log_contributions returning id')).rows.length, 0);
await as(ANA);
await denied(() => db.query('insert into daily_log_contribution_photos(photo_id,contribution_id,project_id) values($1,$2,$3)', [crypto.randomUUID(), C1, JOB]));
await as(ANA);
equal((await db.query("update daily_logs set notes='bypass' returning id")).rows.length, 0);

// ---- Photos: linked once, only on the same job by the same person ----------
const P1 = id(5001), P2 = id(5002), P3 = id(5003), P4 = id(5004), P5 = id(5005);
await as(BEN);
const withPhotos = await append({ cid: id(1006), project: OTHER, expected: 1, ans: answers('Photos of the flashing'), photos: [P2, P1] });
equal(withPhotos.status, 'saved');
equal(withPhotos.photo_ids, [P1, P2]);
await as(BEN);
let status = (await db.query('select daily_log_contribution_photo_status($1) s', [id(1006)])).rows[0].s;
equal(status.map((p) => p.arrived), [false, false], 'saved log does not mean photos arrived');
await db.exec('reset role');
await db.query("insert into attachments(client_id,project_id,created_by,storage_path) values($1,$2,'ben@example.test','install-media/x/feed/1.jpg')", [P1, OTHER]);
await db.query("insert into attachments(client_id,project_id,created_by,storage_path) values($1,$2,'ben@example.test','install-media/x/feed/2.jpg')", [P2, JOB]);
await as(BEN);
status = (await db.query('select daily_log_contribution_photo_status($1) s', [id(1006)])).rows[0].s;
equal(status.map((p) => p.arrived), [true, false], 'a photo filed on another job is not this log\'s');
await as(PARTNER);
await denied(() => db.query('select daily_log_contribution_photo_status($1) s', [id(1006)]), '42501');
await as(FRANK);
await denied(() => append({ cid: id(1007), project: OTHER, expected: 2, ans: answers('Reusing a photo'), photos: [P1] }), '22023');
await db.exec('reset role');
await db.query("insert into attachments(client_id,project_id,created_by,storage_path) values($1,$2,'frank@example.test','install-media/y/1.jpg'),($3,$4,'ben@example.test','install-media/y/2.jpg')", [P3, JOB, P4, OTHER]);
await as(FRANK);
await denied(() => append({ cid: id(1008), project: OTHER, expected: 2, ans: answers('Photo from another job'), photos: [P3] }), '22023');
await as(FRANK);
await denied(() => append({ cid: id(1009), project: OTHER, expected: 2, ans: answers('Someone else\'s photo'), photos: [P4] }), '22023');
await as(FRANK);
equal((await append({ cid: id(1010), project: OTHER, expected: 2, ans: answers('Own new photo'), photos: [P5] })).status, 'saved');

// ---- Null-safe answers: an ABSENT status or value is refused ---------------
const beforeNulls = await count('daily_log_contributions');
await as(ANA);
for (const bad of [
  { work_completed: { status: 'captured' } },
  { work_completed: { status: 'captured', value: null } },
  { work_completed: { status: 'captured', value: 7 } },
  answers('x', { notes: { value: 'status is missing' } }),
  answers('x', { notes: { status: null, value: 'status is JSON null' } }),
  answers('x', { notes: {} }),
  answers('x', { notes: null }),
  answers('x', { notes: 'plain string' }),
  answers('x', { weather: { status: 'captured' } }),
  answers('x', { day_flow: { status: 'captured' } }),
  answers('x', { went_well: { status: 'captured', value: '   ' } }),
]) await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 2, ans: bad, body: 'x' }), '22023');
equal(await count('daily_log_contributions'), beforeNulls, 'no half-filled answer saved');

// ---- The account that pressed Save must be the caller ----------------------
const beforeActor = await count('daily_log_contributions');
await as(BEN);
// Ana's draft, sent after the phone signed in as Ben: refused, nothing read.
await denied(() => append({ cid: id(6001), project: OTHER, expected: 2, ans: answers('Words Ana dictated'), actor: id(ANA) }), '42501');
await as(BEN);
await denied(() => append({ cid: id(6001), project: OTHER, expected: 2, ans: answers('x'), actor: null }), '42501');
await as(0);
await denied(() => append({ cid: id(6001), project: OTHER, expected: 2, ans: answers('x'), actor: id(ANA) }), '42501');
equal(await count('daily_log_contributions'), beforeActor, 'a wrong actor wrote nothing');
// Replaying a saved id as someone else is refused too, not handed their receipt.
await as(FRANK);
await denied(() => append({ cid: C1, expected: 0, ans: answers('Set 6 frames on the east wall') }), '22023');

// ---- Evidence: every contributing Ask message, own and one conversation ----
await db.exec('reset role');
const CONV = id(7000), CONV2 = id(7001);
const R1 = id(7101), R2 = id(7102), R3 = id(7103), BENS = id(7104), OTHERCONV = id(7105), NOCONV = id(7106);
await db.query('insert into ai_field_requests(id, profile_id, conversation_id) values ($1,$2,$3),($4,$2,$3),($5,$2,$3),($6,$7,$3),($8,$2,$9),($10,$2,null)',
  [R1, id(ANA), CONV, R2, R3, BENS, id(BEN), OTHERCONV, CONV2, NOCONV]);
await as(ANA);
const withSources = await append({ cid: id(8001), project: OTHER, expected: 3, ans: answers('Voice memo work'), sources: [R2, R1, R3] });
equal(withSources.status, 'saved');
equal(withSources.source_request_ids, [R2, R1, R3], 'every message kept, in order');
await as(ANA);
equal((await append({ cid: id(8001), project: OTHER, expected: 3, ans: answers('Voice memo work'), sources: [R2, R1, R3] })).status, 'already_saved');
// The same words with a different message list is a different entry.
await as(ANA);
await denied(() => append({ cid: id(8001), project: OTHER, expected: 3, ans: answers('Voice memo work'), sources: [R1] }), '22023');
const beforeSources = await count('daily_log_contributions');
for (const bad of [[BENS], [R1, BENS], [R1, OTHERCONV], [NOCONV], [id(7999)], [R1, R1], [R1, null]]) {
  await as(ANA);
  await denied(() => append({ cid: crypto.randomUUID(), project: OTHER, expected: 3, ans: answers('x'), sources: bad }), '22023');
}
equal(await count('daily_log_contributions'), beforeSources, 'foreign messages saved nothing');
await db.exec('reset role');
equal((await db.query('select source_request_ids from daily_log_contributions where id=$1', [id(8001)])).rows[0].source_request_ids, [R2, R1, R3]);

await db.close();
console.log(`${checks} AI daily log database checks passed (PGlite).`);
