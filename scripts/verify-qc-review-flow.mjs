// Disposable source-level PostgreSQL proof. No live connection. PGlite is
// single-session: this does NOT claim to prove real concurrent lock behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { installer: id(1), foreman: id(2), supervisor: id(3), partner: id(4),
  revoked: id(5), testForeman: id(6), retired: id(7), offToday: id(8), lead: id(9),
  admin: id(10), owner: id(11), bigBoss: id(12), unknown: id(13) };
const job = { sandbox: id(201), real: id(202), test: id(203), tracking: id(204), trashed: id(205), empty: id(206), other: id(207) };
const unit = { fresh: id(101), old: id(102), sandbox: id(103), atomic: id(104), legacy: id(105),
  removed: id(106), incomplete: id(107), other: id(108), nullDate: id(109), test: id(110), tracking: id(111), trashed: id(112) };
let checks = 0;
function equal(a, b, label = '') { assert.deepEqual(a, b, label); checks++; }
function ok(a, label = '') { assert.ok(a, label); checks++; }
async function rejects(fn, code) {
  await assert.rejects(fn, e => { assert.equal(e.code, code, e.message); return true; }); checks++;
}
async function migration(name) { return readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'); }
function extract(sql, start) {
  const a = sql.indexOf(start); assert.ok(a >= 0, start);
  const b = sql.indexOf('$$;', sql.indexOf('$$', a) + 2); assert.ok(b > a, start);
  return sql.slice(a, b + 3);
}
await db.exec(await readFile(new URL('./tests/qc-review-flow/setup.sql', import.meta.url), 'utf8'));
await db.exec(await readFile(new URL('./tests/qc-review-flow/seed.sql', import.meta.url), 'utf8'));
await db.exec(extract(await migration('20260991000000_points_cap.sql'), 'create or replace function public.resolve_install_points('));
await db.exec(extract(await migration('20261024000000_ai_field_operations.sql'), 'create function public._ai_job_visible('));
await db.exec('revoke all on function _ai_job_visible(uuid,uuid) from public,anon,authenticated');
await db.exec(await migration('20261041000000_qc_decision_authority.sql'));
const baselineEvents = (await db.query('select count(*)::int as n from qc_decision_events')).rows[0].n;
await db.exec(await migration('20261056000000_qc_review_flow.sql'));

async function admin() { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)"); }
async function as(who) { await admin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor[who] ?? '']); await db.exec('set role authenticated'); }
async function read(sql, args=[]) { await admin(); return (await db.query(sql,args)).rows; }
async function version(opening) { return (await read('select review_version from qc_checks where project_opening_id=$1',[opening]))[0]?.review_version ?? 'none'; }
async function jobs(who='foreman', search='', limit=50, after=null, selected=null) {
  await as(who); return (await db.query('select qc_review_jobs($1,$2,$3,$4) as r',[search,limit,after,selected])).rows[0].r;
}
async function page({who='foreman',project=job.real,filter='all',search='',limit=50,after=null,before=null,selected=null}={}) {
  await as(who); return (await db.query('select qc_review_page($1,$2,$3,$4,$5,$6,$7) as r',
    [project,filter,search,limit,after,before,selected])).rows[0].r;
}
async function decide({who='foreman',request,opening=unit.fresh,project=job.real,status='passed',expected='none',note=null}) {
  await as(who); return (await db.query('select record_qc_review_decision($1,$2,$3,$4,$5,$6) as r',
    [id(request),project,opening,status,expected,note])).rows[0].r;
}

equal((await read('select count(*)::int as n from qc_decision_events'))[0].n, baselineEvents, 'backfill creates no reviews');
ok((await version(unit.old)) !== 'none');
equal((await read('select review_expected_version from qc_decision_events'))[0].review_expected_version, null);
const visible = await jobs();
equal(visible.rows.map(r=>r.id), [job.real,job.other], 'real foreman sees only eligible real data jobs');
equal(visible.totalCount,2);
equal(visible.selected,null);
const selectedOther=await jobs('foreman','%_',1,null,job.other);
equal(selectedOther.totalCount,1);
equal(selectedOther.rows.map(r=>r.id),[job.real]);
equal(selectedOther.selected,visible.rows.find(r=>r.id===job.other),'selected job ignores search but retains canonical identity/counts');
equal((await jobs('foreman','',1,null,job.other)).selected.id,job.other,'selected job may be beyond first page');
for (const hidden of [job.test,job.sandbox,job.tracking,job.trashed,job.empty,id(9999)]) {
  equal((await jobs('foreman','',50,null,hidden)).selected,null);
}
equal((await jobs('testForeman','',50,null,job.real)).selected,null);
equal((await jobs('supervisor','no matching jobs',50,null,job.test)).selected.id,job.test);
equal((await jobs('testForeman')).rows.map(r=>r.id), [job.sandbox]);
equal((await jobs('supervisor')).rows.length,4, 'supervisor sees sandbox and test, never trash/tracking');
for (const who of ['installer','partner','revoked','retired','unknown']) {
  await rejects(()=>jobs(who),'42501');
  await rejects(()=>page({who}),'42501');
  await rejects(()=>decide({who,request:301}),'42501');
}
for (const who of ['offToday','lead','admin','owner','bigBoss']) ok((await jobs(who)).rows.some(r=>r.id===job.real));
await as('foreman');
await rejects(()=>db.query('select _record_qc_review_decision($1,$2,$3,$4,$5,$6)',[id(301),unit.fresh,'passed',null,'none',job.real]),'42501');
await rejects(()=>db.query('select _ai_job_visible($1,$2)',[job.real,actor.foreman]),'42501');
await admin(); await db.exec('set role anon');
await rejects(()=>db.query('select qc_review_jobs()'),'42501');
await rejects(()=>db.query('select qc_review_page($1)',[job.real]),'42501');
await rejects(()=>db.query('select record_qc_review_decision($1,$2,$3,$4,$5)',[id(301),job.real,unit.fresh,'passed','none']),'42501');
for (const project of [job.test,job.sandbox,job.tracking,job.trashed]) await rejects(()=>page({project}),'42501');
await rejects(()=>page({who:'testForeman',project:job.real}),'42501');
await rejects(()=>decide({who:'testForeman',request:302}),'42501');
await rejects(()=>decide({request:303,project:job.other}),'22023');
await rejects(()=>decide({request:303,opening:id(9000)}),'22023');
await rejects(()=>decide({request:303,opening:unit.removed}),'22023');
await rejects(()=>decide({request:303,opening:unit.incomplete}),'22023');
equal((await page({selected:unit.other})).selected,null);
equal((await page({selected:unit.removed})).selected,null);
equal((await page({search:'%_'})).rows.map(r=>r.id),[unit.fresh], 'wildcards remain literal');
equal((await page({search:'WEST GLASS'})).rows.map(r=>r.id),[unit.fresh]);
equal((await jobs('foreman','%_')).rows.map(r=>r.id),[job.real]);
equal((await page({filter:'callbacks'})).rows.map(r=>r.id),[unit.old]);
const initial = await page();
equal(initial.totalCount,5);
equal(initial.rows.at(-1).id,unit.nullDate);
equal(initial.hasPrevious,false); equal(initial.hasNext,false);
const p1=await page({limit:2}); const p2=await page({limit:2,after:p1.nextCursor});
const p3=await page({limit:2,after:p2.nextCursor});
equal([...p1.rows,...p2.rows,...p3.rows].map(r=>r.id),initial.rows.map(r=>r.id));
equal(p2.totalCount,5); equal(p2.hasPrevious,true); equal(p2.hasNext,true);
equal((await page({limit:2,before:p2.previousCursor})).rows.map(r=>r.id),p1.rows.map(r=>r.id));
equal((await page({limit:2,before:p3.previousCursor})).rows.map(r=>r.id),p2.rows.map(r=>r.id));
ok(p1.nextCursor.endedAt.includes('123456'), 'cursor preserves microseconds');
const j1=await jobs('foreman','',1); const j2=await jobs('foreman','',1,j1.nextCursor);
equal([...j1.rows,...j2.rows].map(r=>r.id),visible.rows.map(r=>r.id));
equal(j1.hasMore,true); equal(j2.hasMore,false);
for (const opts of [{limit:0},{limit:101},{filter:'passed'},{search:'x'.repeat(201)},
  {after:{id:unit.fresh}}, {after:{id:'not-uuid',endedAt:null}},
  {after:{id:unit.fresh,endedAt:'not-a-date'}}, {after:p1.nextCursor,before:p2.previousCursor}]) {
  await rejects(()=>page(opts),'22023');
}
await rejects(()=>jobs('foreman','',1,{id:job.real,name:3}),'22023');
await rejects(()=>decide({request:304,expected:null}),'22023');
await rejects(()=>decide({request:304,expected:'bad-version'}),'22023');
await rejects(()=>decide({request:304,status:'pending'}),'22023');
await rejects(()=>decide({request:304,note:'x'.repeat(4001)}),'22023');

// First guarded save, replay after someone else's later review, and immutable
// request payload (including expected version and normalized note).
equal(await decide({request:310,note:'  Looks good  '}),id(310));
const firstVersion=await version(unit.fresh); ok(firstVersion!=='none');
equal((await read('select status from points_ledger where ref=$1',[unit.fresh]))[0].status,'confirmed');
equal((await page({selected:unit.fresh})).selected.matchesFilter,false);
equal((await page({selected:unit.fresh})).selected.qcStatus,'passed');
equal((await page()).totalCount,4);
await decide({who:'supervisor',request:311,status:'callback',expected:firstVersion,note:'Check seal'});
const secondVersion=await version(unit.fresh); ok(secondVersion!==firstVersion);
equal(await decide({request:310,note:'Looks good'}),id(310));
equal(await version(unit.fresh),secondVersion,'exact replay never reapplies an old review');
for (const changed of [{note:'Different'}, {expected:firstVersion}, {status:'callback'},
  {opening:unit.atomic}, {who:'supervisor'}]) await rejects(()=>decide({request:310,note:'Looks good',...changed}),'23505');
await rejects(()=>decide({request:312,expected:firstVersion}),'40001');
equal((await read('select count(*)::int n from qc_decision_events where id=$1',[id(312)]))[0].n,0);
equal(await version(unit.fresh),secondVersion);
await decide({request:313,expected:secondVersion,note:'Looks good'});
ok((await version(unit.fresh))!==firstVersion,'A -> B -> A is a new version');
equal((await read('select status from points_ledger where ref=$1',[unit.fresh]))[0].status,'confirmed','settled points not reopened');

// Both old RPC and direct clients invalidate stale new-client state. A direct
// repeated write and a forged version-only edit must not create false conflicts.
await as('foreman');
await db.query('select record_qc_decision($1,$2,$3,$4)',[id(320),unit.legacy,'callback','Old phone']);
const legacyVersion=await version(unit.legacy);
await as('foreman');
await db.query('select record_qc_decision($1,$2,$3,$4)',[id(320),unit.legacy,'callback','Old phone']);
equal(await version(unit.legacy),legacyVersion);
await as('foreman');
await db.query('update qc_checks set review_version=$2 where project_opening_id=$1',[unit.legacy,id(999)]);
equal(await version(unit.legacy),legacyVersion,'version forgery ignored');
await as('foreman');
await db.query("update qc_checks set status='passed',note='Direct change',review_version=$2 where project_opening_id=$1",[unit.legacy,legacyVersion]);
const directVersion=await version(unit.legacy); ok(directVersion!==legacyVersion);
await rejects(()=>decide({request:321,opening:unit.legacy,expected:legacyVersion}),'40001');
await rejects(()=>decide({request:322,opening:unit.legacy,expected:'none'}),'40001');
const eventCount=(await read('select count(*)::int n from qc_decision_events where project_opening_id=$1',[unit.legacy]))[0].n;
await as('foreman');
await db.query("insert into qc_checks(project_opening_id,status,note,review_version) values($1,'passed','Direct change',$2) on conflict(project_opening_id) do update set status=excluded.status,note=excluded.note,review_version=excluded.review_version",[unit.legacy,id(998)]);
equal(await version(unit.legacy),directVersion);
equal((await read('select count(*)::int n from qc_decision_events where project_opening_id=$1',[unit.legacy]))[0].n,eventCount);
await rejects(()=>decide({request:323,opening:unit.atomic,expected:directVersion}),'40001','expected existing cannot create absent row');

// A new request really is a new review even when its decision text is the same;
// only replaying the same request UUID is a no-op.
await decide({request:324,opening:unit.legacy,expected:directVersion,note:'Direct change'});
const repeatedDecisionVersion=await version(unit.legacy);
ok(repeatedDecisionVersion!==directVersion);
await decide({request:325,opening:unit.legacy,expected:repeatedDecisionVersion,note:'Direct change'});
ok((await version(unit.legacy))!==repeatedDecisionVersion);

// A direct client's INSERT cannot pick the state token either.
await as('testForeman');
await db.query("insert into qc_checks(project_opening_id,status,review_version) values($1,'callback',$2)",[unit.sandbox,id(997)]);
ok((await version(unit.sandbox))!==id(997));

// A failure in the unchanged points resolver rolls back projection, event and
// version together. No empty/success response or partially saved decision.
await admin();
await db.exec(`create function reject_atomic_points() returns trigger language plpgsql as $$
  begin if new.ref='${unit.atomic}' then raise exception 'forced points failure'; end if; return new; end $$;
  create trigger reject_atomic_points before update on points_ledger for each row execute function reject_atomic_points();`);
await rejects(()=>decide({request:330,opening:unit.atomic}),'P0001');
equal(await version(unit.atomic),'none');
equal((await read('select count(*)::int n from qc_decision_events where id=$1',[id(330)]))[0].n,0);
equal((await read('select status from points_ledger where ref=$1',[unit.atomic]))[0].status,'pending');
// The same rollback law applies when a current QC row already exists.
await admin();
await db.query("insert into qc_checks(project_opening_id,status,note) values($1,'callback','Before failure')",[unit.atomic]);
const beforeFailedUpdate=await version(unit.atomic);
await rejects(()=>decide({request:331,opening:unit.atomic,expected:beforeFailedUpdate}),'P0001');
equal(await version(unit.atomic),beforeFailedUpdate);
equal((await read('select status,note from qc_checks where project_opening_id=$1',[unit.atomic]))[0],
  {status:'callback',note:'Before failure'});
equal((await read('select count(*)::int n from qc_decision_events where id=$1',[id(331)]))[0].n,0);

// More than the PostgREST cap of passed IDs must never hide an unreviewed unit.
await admin();
await db.exec(`insert into project_openings(id,project_id,opening_code,status,work_ended_at)
  select ('10000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'${job.real}','DONE-'||g,'installed','2026-08-01'
  from generate_series(1,1100) g;
  insert into qc_checks(project_opening_id,status)
  select id,'passed' from project_openings where opening_code like 'DONE-%';
  insert into project_openings(id,project_id,opening_code,label,status,work_ended_at)
  select ('20000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'${job.real}','NEW-'||g,'Far page '||g,'installed','2026-09-02'
  from generate_series(1,105) g;`);
const all=await page(); equal(all.totalCount,108); equal(all.rows.length,50); equal(all.hasNext,true);
const far=await page({search:'Far page 105'}); equal(far.totalCount,1); equal(far.rows[0].openingCode,'NEW-105');
equal((await page({search:'DONE-'})).totalCount,0);
const selectedFar=await page({selected:far.rows[0].id}); equal(selectedFar.selected.id,far.rows[0].id);
ok(!selectedFar.rows.some(r=>r.id===far.rows[0].id),'selected restore is independent of first page');
// The request binds the job too, even if an administrator later moves a unit.
await admin();
await db.query('update project_openings set project_id=$2 where id=$1',[unit.fresh,job.other]);
await rejects(()=>decide({request:310,project:job.other,note:'Looks good'}),'23505');
await admin();
await db.query('update project_openings set project_id=$2 where id=$1',[unit.fresh,job.real]);
await db.query("insert into project_openings(id,project_id,opening_code,status) values($1,$2,'PENDING-ROW','installed')",[id(150),job.real]);
await db.query("insert into qc_checks(project_opening_id,status) values($1,'pending')",[id(150)]);
const pending=await page({filter:'new',search:'PENDING-ROW'});
equal(pending.totalCount,1); equal(pending.rows[0].qcStatus,'pending');
ok(pending.rows[0].reviewVersion!=='none','existing pending row has a real version');
await rejects(()=>decide({request:340,opening:id(150),expected:'none'}),'40001');
await decide({request:341,opening:id(150),expected:pending.rows[0].reviewVersion});

// Exercise this probe with the REAL rollback harness, still on synthetic local
// data. This catches invalid probe assumptions, not drift in the live schema.
await admin();
const beforeProbe=(await db.query('select (select count(*) from project_openings) as openings, (select count(*) from qc_decision_events) as events')).rows[0];
const dryRunSource=await readFile(new URL('./db_dry_run.py',import.meta.url),'utf8');
const harness=dryRunSource.split('HARNESS = r"""')[1]?.split('"""')[0];
const final=dryRunSource.split('FINAL = r"""')[1]?.split('"""')[0];
assert.ok(harness && final);
await db.exec('begin; create table auth.users(id uuid primary key,email text); update profiles set is_test=true where role=\'installer\';');
await db.exec(harness);
await db.exec(await readFile(new URL('./dry-run-probes/qc-review-flow.sql',import.meta.url),'utf8'));
const probeChecks=(await db.query('select "check",ok,detail from pg_temp.dry_run_results')).rows;
for (const check of probeChecks) ok(check.ok,`${check.check}: ${check.detail}`);
await assert.rejects(()=>db.exec(final),e=>e.code==='P0001' && e.message.includes('DRY_RUN_RESULT:'));
checks++;
await db.exec('rollback');
equal((await db.query('select (select count(*) from project_openings) as openings, (select count(*) from qc_decision_events) as events')).rows[0],beforeProbe,'forced rollback retains no probe data');

// Parse the native-only fixture substrate here as well; actual session overlap
// and lock assertions remain the separate Docker test's responsibility.
await db.exec(await readFile(new URL('./tests/qc-review-flow/race-setup.sql',import.meta.url),'utf8'));
equal((await db.query('select count(*)::int n from qc_race_cases')).rows[0].n,4);
const nativeAssertions=await readFile(new URL('./tests/qc-review-flow/race-assertions.sql',import.meta.url),'utf8');
await assert.rejects(()=>db.exec(nativeAssertions),e=>e.code==='P0001' && e.message.includes('9 session receipts'));
checks++;
const nativeSession=await readFile(new URL('./tests/qc-review-flow/race-session.sql',import.meta.url),'utf8');
const nativeCommand=extract(nativeSession,'  do $$');
await as('foreman');
await db.query("select set_config('fixture.qc_case','same-request',false),set_config('fixture.qc_request',$1,false),set_config('fixture.qc_stale','false',false),set_config('application_name','fixture-saved',false)",[id(903)]);
await db.exec(nativeCommand);
await db.exec("select set_config('application_name','fixture-replayed',false)");
await db.exec(nativeCommand);
await db.query("select set_config('fixture.qc_request',$1,false),set_config('fixture.qc_stale','true',false),set_config('application_name','fixture-stale',false)",[id(913)]);
await db.exec(nativeCommand);
equal((await db.query('select outcome from qc_race_results order by session')).rows.map(r=>r.outcome),['saved','saved','stale']);

console.log(`QC review flow: ${checks} checks passed (real migration SQL, disposable single-session PGlite).`);
await db.close();
