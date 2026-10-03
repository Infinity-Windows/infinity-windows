// Synthetic-only integration coverage of actual SQL dealing functions.
// Reuse the canonical fixture schema, never a second hand-written dealer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const {PGlite} = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const base = await readFile(new URL('./verify-values-reviews.mjs', import.meta.url), 'utf8');
const fixture = base.match(/await db\.exec\(`([\s\S]*?)`\);/);
assert(fixture);
await db.exec(fixture[1]);
let migration = await readFile(new URL('../supabase/migrations/20261106000000_monthly_values_reviews.sql', import.meta.url), 'utf8');
migration = migration.replace(/do \$\$\nbegin\n {2}if not exists \(select 1 from cron\.job[\s\S]*?\nend \$\$;\n/, '');
assert(!migration.includes('cron.schedule'));
await db.exec('set check_function_bodies=off;\n'+migration);
const id = n => `11111111-1111-4111-8111-${n.toString(16).padStart(12,'0')}`;
const job = n => `22222222-2222-4222-8222-${n.toString(16).padStart(12,'0')}`;
const one = async (sql,params=[]) => (await db.query(sql,params)).rows[0];
const period = '2026-12-01';
for(let n=1;n<=13;n++) {
  const role = n===5 ? 'foreman' : n===6 ? 'supervisor' : n===8 ? 'owner' : 'installer';
  await db.query('insert into profiles(id,role,display_name,is_test,is_partner,retired_at,access_revoked_at) values($1,$2,$3,$4,$5,$6,$7)',
    [id(n),role,`Fixture ${n}`,n===9,n===13,n===11?'2026-10-01T00:00:00Z':null,n===12?'2026-10-01T00:00:00Z':null]);
}
for(let n=1;n<=4;n++) await db.query('insert into projects(id,is_test) values($1,$2)',[job(n),n===4]);
async function shift(person,project,at,status='open',closed=false) {
  await db.query('insert into time_shifts(profile_id,project_id,clock_in_at,clock_out_at,status) values($1,$2,$3,$4,$5)',
    [id(person),job(project),at,closed?at:null,status]);
}
// Open and completed shifts, same site/local day. Duplicate punches must
// not count as extra coworkers; voided, retired, revoked and partner excluded.
for(const person of [1,2,3,4,5,6,9,11,12,13]) await shift(person,1,'2026-12-05T15:00:00Z',person===3?'approved':'open',person===3);
await shift(10,1,'2026-12-05T15:00:00Z','voided');
await shift(10,4,'2026-12-05T16:00:00Z');
await shift(1,1,'2026-12-05T16:00:00Z');
await shift(7,2,'2026-12-05T15:00:00Z'); // solo now
for(const person of [1,2,7]) await shift(person,3,'2026-11-12T15:00:00Z');
await db.query('select _values_deal_period($1::date)',[period]);
const rows = (await db.query('select id,rater_id,subject_id,reason,solo from values_assignments where period_start=$1',[period])).rows;
const from = n => rows.filter(r=>r.rater_id===id(n));
for(const n of [1,2,3,4]) {
  assert.equal(from(n).filter(r=>r.reason==='self').length,1,`worker ${n} self`);
  assert(from(n).filter(r=>r.rater_id!==r.subject_id && !r.solo).length>=2,`worker ${n} two coworkers`);
  assert(rows.filter(r=>r.subject_id===id(n)&&r.rater_id!==r.subject_id).length>=2,`worker ${n} incoming floor`);
}
for(const lead of [5,6]) {
  for(const person of [1,2,3,4,5,6].filter(n=>n!==lead)) assert(from(lead).some(r=>r.subject_id===id(person)),`lead ${lead} coworker ${person}`);
  assert.equal(from(lead).filter(r=>r.reason==='self').length,1);
  assert(from(8).some(r=>r.subject_id===id(lead)&&r.reason==='owner_lead'),'owner every active lead');
}
for(const n of [9,10,11,12,13]) assert(!rows.some(r=>r.rater_id===id(n)||r.subject_id===id(n)),`excluded ${n}`);
assert.equal(from(7).filter(r=>r.reason==='self').length,1);
assert.equal(from(7).filter(r=>r.solo).length,2);
assert.deepEqual(from(7).filter(r=>r.solo).map(r=>r.subject_id).sort(),[id(1),id(2)].sort());
assert.equal(new Set(rows.map(r=>`${r.rater_id}/${r.subject_id}`)).size,rows.length);
const snapshot = rows.map(r=>JSON.stringify(r)).sort();
await shift(1,1,'2026-12-05T17:00:00Z');
await db.query('select _values_deal_period($1::date)',[period]);
assert.deepEqual((await db.query('select id,rater_id,subject_id,reason,solo from values_assignments where period_start=$1',[period])).rows.map(r=>JSON.stringify(r)).sort(),snapshot,'duplicate same-day shift/redeal preserves assignments and IDs');
console.log('PASS actual SQL worker/lead/owner quotas, two-incoming floor, open/closed attendance, exclusions, prior-coworker solo, dedup and stable IDs');
// Exercise the actual SQL mirror, not only the copied weight formula.
const slugs=['fullsend','growth','integrity','ownership','safety','sincerity','strategic','tribe'];
const rubric=(await one('select rubric_version from values_periods where period_start=$1',[period])).rubric_version;
async function submit(person,assignment,score) {
  await db.exec(`set request.jwt.claim.sub='${id(person)}'; set role authenticated;`);
  await db.query('select values_submit($1,$2,$3,$4::jsonb,null)',[assignment,crypto.randomUUID(),rubric,JSON.stringify(slugs.map(slug=>({slug,score})))]);
  await db.exec('reset role;');
}
await submit(7,from(7).find(r=>r.subject_id===id(1)).id,8);
let normal = rows.find(r=>r.rater_id===id(3)&&r.subject_id===id(1));
if(!normal) normal=await one("insert into values_assignments(period_start,rater_id,subject_id,reason) values($1,$2,$3,'dealt') returning id",[period,id(3),id(1)]);
await submit(3,normal.id,2);
const mirror=(await one("select _values_mirror($1,'2026-12-01','2027-01-01',1,null) as m",[id(1)])).m;
assert(Math.abs(Number(mirror.fullsend.average)-4)<1e-8,'solo worker8 gets half weight relative to normal worker2');
console.log('PASS actual SQL accepted solo half-weight in mirror');
// Fixed fixture calendar for scheduler catch-up only. Real Denver/DST
// policy helpers are independently exercised by the canonical verifier.
await db.exec("create or replace function _values_launch() returns date language sql immutable as $$select '2026-07-01'::date$$; create or replace function _values_day(p_at timestamptz) returns date language sql stable as $$select '2026-10-03'::date$$; update company_settings set values_scheduler_enabled=true;");
const due=(await one('select values_run_due() as r')).r;
const dealt=(due.deals??[]).map(r=>r.periodStart).sort();
assert.deepEqual(dealt,['2026-07-01','2026-08-01','2026-09-01'],'missed open periods caught up, current month before window excluded');
const again=(await one('select values_run_due() as r')).r;
assert((again.deals??[]).every(r=>r.dealt===0),'catch-up rerun creates no duplicate assignments');
console.log('PASS actual parameterless scheduler catch-up and idempotence in synthetic clock fixture');
await db.close();
