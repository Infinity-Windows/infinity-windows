// The wall around Forge AI's schedule reasons (K2.8, 20261032000000) against
// the real migration in a disposable PGlite database. Synthetic people and
// jobs only; no network, no crew data.
//   PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node scripts/verify-schedule-ai-reasons.mjs
//
// What has to be true (Codex's review of #646, 2026-09-24): the reason the
// model gives for putting a person on a job is reasoning about PEOPLE, so an
// installer, a foreman or a partner login must not be able to read it — not
// through the card's own gate (UI only) but through the database. And the
// review card's Drop must delete only a row that is still the draft it showed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const migration = (name) => read('supabase/migrations/' + name);

await db.exec(await read('scripts/tests/schedule-ai-reasons/setup.sql'));
const reasons = await migration('20261032000000_ai_schedule_review.sql');
await db.exec(reasons);
await db.exec(reasons); // the deploy can be retried

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ANA = 1, FRANK = 2, SAM = 3, OWEN = 4, PARTNER = 5, ADMIN = 6, RETIRED = 7;
const people = [[ANA, 'installer', 'Ana'], [FRANK, 'foreman', 'Frank'], [SAM, 'supervisor', 'Sam'], [OWEN, 'owner', 'Owen'],
  // A partner login given the supervisor role by mistake is still a partner: the wall wins.
  [PARTNER, 'supervisor', 'Builder'], [ADMIN, 'admin', 'Adele'], [RETIRED, 'supervisor', 'Rae']];
for (const [n, role, name] of people) {
  await db.query('insert into profiles(id, role, display_name) values($1,$2,$3)', [id(n), role, name]);
  await db.query('insert into auth.users(id, email) values($1,$2)', [id(n), `${name.toLowerCase()}@example.test`]);
}
await db.query('update profiles set is_partner=true where id=$1', [id(PARTNER)]);
await db.query('update profiles set retired_at=now() where id=$1', [id(RETIRED)]);
const JOB = id(90);
await db.query("insert into projects(id,name,job_code) values ($1,'Synthetic A','SYN-A')", [JOB]);
const AI_DRAFT = id(601), HUMAN_DRAFT = id(602), AI_PUBLISHED = id(603), RACE = id(604);
await db.query(`insert into schedule_assignments(id,project_id,start_date,end_date,status,created_via,created_by,updated_at) values
  ($1,$5,'2026-09-28','2026-09-28','draft','ai',$6,'2026-09-24T12:00:00Z'),
  ($2,$5,'2026-09-28','2026-09-28','draft',null,$6,'2026-09-24T12:00:00Z'),
  ($3,$5,'2026-09-28','2026-09-28','published','ai',$6,'2026-09-24T12:00:00Z'),
  ($4,$5,'2026-09-29','2026-09-29','draft','ai',$6,'2026-09-24T12:00:00Z')`, [AI_DRAFT, HUMAN_DRAFT, AI_PUBLISHED, RACE, JOB, id(SAM)]);

let checks = 0;
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (v, message) => { assert.ok(v, message); checks++; };
async function as(n) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [n ? id(n) : '']);
  await db.exec(n === 'anon' ? 'set role anon' : 'set role authenticated');
}
async function system() { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
async function denied(fn, code) {
  try { await fn(); } catch (e) { if (code) assert.equal(e.code, code, e.message); checks++; return e; }
  assert.fail('expected a refusal');
}
const insertReason = (assignment, reason, by) =>
  db.query('insert into schedule_ai_reasons(assignment_id, reason, created_by) values($1,$2,$3)', [assignment, reason, by]);
const readReasons = async () => (await db.query('select assignment_id, reason from schedule_ai_reasons order by assignment_id')).rows;

// ---- The table arrives with its door shut -----------------------------------
await system();
const priv = async (role, p) => (await db.query('select has_table_privilege($1, $2, $3) v', [role, 'public.schedule_ai_reasons', p])).rows[0].v;
equal(await priv('authenticated', 'select'), true, 'supervisors read through a policy, so SELECT is granted');
equal(await priv('authenticated', 'insert'), true, 'the Ask executor writes through a policy, so INSERT is granted');
equal(await priv('authenticated', 'update'), false, 'a reason is never edited');
equal(await priv('authenticated', 'delete'), false, 'a reason leaves only with its draft (cascade)');
for (const p of ['select', 'insert', 'update', 'delete']) equal(await priv('anon', p), false, `anon has no ${p}`);
const rls = (await db.query("select relrowsecurity v from pg_class where relname='schedule_ai_reasons'")).rows[0].v;
equal(rls, true, 'row security is on');
const policies = (await db.query("select policyname, cmd from pg_policies where tablename='schedule_ai_reasons' order by policyname")).rows;
equal(policies, [{ policyname: 'schedule_ai_reasons_supervisor_read', cmd: 'SELECT' }, { policyname: 'schedule_ai_reasons_supervisor_write', cmd: 'INSERT' }], 'exactly a read and an insert policy');
const note = (await db.query("select audience, href from app_release_notes where id='2026-09-24-ai-schedule-review'")).rows[0];
equal(note, { audience: [2, 3], href: '/scheduling' }, 'the announcement is for supervisors and owners only');

// ---- A supervisor records the reason for an AI draft, as the Ask executor does
await as(SAM);
await insertReason(AI_DRAFT, 'Lead with wet glazing; keeps Team 1 together', id(SAM));
await insertReason(RACE, 'Second pair of hands for the corner units', id(SAM));
equal((await readReasons()).map((r) => r.reason), ['Lead with wet glazing; keeps Team 1 together', 'Second pair of hands for the corner units'], 'the drafting supervisor reads the reasons back');
// ...but only on an AI draft, only in their own name, only once, and only short.
await denied(() => insertReason(HUMAN_DRAFT, 'A human made this draft', id(SAM)), '42501');
await denied(() => insertReason(AI_PUBLISHED, 'Already published', id(OWEN)), '42501');
await denied(() => insertReason(AI_DRAFT, 'Twice', id(SAM)), '23505');
await denied(() => insertReason(AI_PUBLISHED, 'x'.repeat(161), id(SAM)), '23514');
await denied(() => insertReason(AI_PUBLISHED, '   ', id(SAM)), '23514');
// No editing and no deleting, even by the person who wrote it.
await denied(() => db.query("update schedule_ai_reasons set reason='changed' where assignment_id=$1", [AI_DRAFT]), '42501');
await denied(() => db.query('delete from schedule_ai_reasons where assignment_id=$1', [AI_DRAFT]), '42501');

// ---- Who reads it ------------------------------------------------------------
await as(OWEN);
equal((await readReasons()).length, 2, 'an owner reads every reason');
await as(ADMIN);
equal((await readReasons()).length, 2, 'admin counts as supervisor rank, as everywhere in the schedule policies');
await as(ANA);
equal(await readReasons(), [], 'an installer gets no rows — not an error, no rows');
await denied(() => insertReason(AI_DRAFT, 'Ana tries', id(ANA)), '42501');
await as(FRANK);
equal(await readReasons(), [], 'a foreman gets no rows');
await denied(() => insertReason(RACE, 'Frank tries', id(FRANK)), '42501');
await as(PARTNER);
equal(await readReasons(), [], 'a partner login gets no rows even with the supervisor role');
await denied(() => insertReason(RACE, 'Builder tries', id(PARTNER)), '42501');
await as('anon');
await denied(() => readReasons(), '42501');
// The crew-readable audit table stays readable — and is exactly why the reason is not on it.
await as(ANA);
await system();
await db.query("insert into schedule_events(assignment_id, actor, kind, payload) values($1,$2,'created','{\"ai\": true}')", [AI_DRAFT, id(SAM)]);
await as(ANA);
equal((await db.query('select payload from schedule_events where assignment_id=$1', [AI_DRAFT])).rows, [{ payload: { ai: true } }], 'an installer reads the audit mark, which carries no reason');

// ---- Drop: the row goes, and the reason with it ------------------------------
await as(SAM);
const dropped = await db.query("delete from schedule_assignments where id=$1 and status='draft' and updated_at=$2 returning id", [AI_DRAFT, '2026-09-24T12:00:00Z']);
equal(dropped.rows.length, 1, 'a Drop on the draft the card showed deletes it');
await system();
equal((await db.query('select count(*)::int n from schedule_ai_reasons where assignment_id=$1', [AI_DRAFT])).rows[0].n, 0, 'the reason cascades away with its draft');

// ---- Two supervisors: Owen publishes while Sam's card is still open ----------
await as(OWEN);
await db.query("update schedule_assignments set status='published', published_at=now(), updated_at=clock_timestamp() where id=$1 and status='draft'", [RACE]);
await as(SAM);
// The card's Drop (lib/schedule/api dropDraftAssignment): status AND the revision it rendered from.
const stale = await db.query("delete from schedule_assignments where id=$1 and status='draft' and updated_at=$2 returning id", [RACE, '2026-09-24T12:00:00Z']);
equal(stale.rows.length, 0, "Sam's stale Drop matches nothing: the answer is 'this draft changed'");
await system();
const live = (await db.query('select status from schedule_assignments where id=$1', [RACE])).rows[0];
equal(live.status, 'published', 'the published row the crew can see is untouched');
equal((await db.query('select count(*)::int n from schedule_ai_reasons where assignment_id=$1', [RACE])).rows[0].n, 1, 'and its reason is still there for the owner');
// What the board's unconditional delete would have done instead — the bug the conditional Drop exists for.
await as(SAM);
const blunt = await db.query('delete from schedule_assignments where id=$1 returning id', [RACE]);
equal(blunt.rows.length, 1, 'the unconditional delete would have taken the live row (so the card must never use it)');

await system();
console.log(`${checks} schedule AI reason checks passed (PGlite).`);
