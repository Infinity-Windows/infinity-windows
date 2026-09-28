// Disposable PostgreSQL-compatible proof of who may read and change a job's
// bill-to (20261034000000_bill_to_customers.sql); never uses Supabase.
// npm install --prefix /tmp/forge-bill-to-db-check @electric-sql/pglite
// PGLITE_MODULE=/tmp/forge-bill-to-db-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-bill-to.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();

// People, by the last digits of their id. Only the columns the migration reads.
const P = {
  owner: 1, supervisor: 2, foreman: 3, installer: 4,
  costsInstaller: 5, costsForeman: 6, partner: 7, retired: 8, revoked: 9, admin: 10,
};
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OLD_JOB = "11111111-1111-4111-8111-111111111111";
const TRASHED_JOB = "22222222-2222-4222-8222-222222222222";

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to authenticated, anon, service_role;
  create table public.profiles(
    id uuid primary key, role text, can_see_costs boolean not null default false,
    is_partner boolean not null default false, retired_at timestamptz, access_revoked_at timestamptz);
  create table public.projects(id uuid primary key default gen_random_uuid(), job_code text, deleted_at timestamptz);
  grant select on public.profiles, public.projects to authenticated;
  grant insert (job_code) on public.projects to authenticated;
  create function public.role_rank(p_role text) returns int language sql immutable as $$
    select case p_role when 'owner' then 3 when 'big_boss' then 3 when 'supervisor' then 2 when 'admin' then 2
      when 'foreman' then 1 when 'lead' then 1 else 0 end $$;
  create function public.is_partner_user() returns boolean language sql security definer set search_path = public as $$ select coalesce((select is_partner from profiles where id = auth.uid()), false) $$;
  -- The real fence is checked by scripts/test_sandbox_guard.py.
  create function public.attach_sandbox_guards() returns void language sql as $$ select $$;
  insert into profiles(id, role, can_see_costs, is_partner, retired_at, access_revoked_at) values
    ('${uid(P.owner)}','owner',false,false,null,null),
    ('${uid(P.supervisor)}','supervisor',false,false,null,null),
    ('${uid(P.foreman)}','foreman',false,false,null,null),
    ('${uid(P.installer)}','installer',false,false,null,null),
    ('${uid(P.costsInstaller)}','installer',true,false,null,null),
    ('${uid(P.costsForeman)}','foreman',true,false,null,null),
    ('${uid(P.partner)}','owner',true,true,null,null),
    ('${uid(P.retired)}','supervisor',false,false,now(),null),
    ('${uid(P.revoked)}','supervisor',true,false,null,now()),
    ('${uid(P.admin)}','admin',false,false,null,null);
  insert into projects(id, job_code, deleted_at) values
    ('${OLD_JOB}','OLD1',null), ('${TRASHED_JOB}','GONE1',now());
`);
const migration = await readFile(new URL("../supabase/migrations/20261034000000_bill_to_customers.sql", import.meta.url), "utf8");
await db.exec(migration);
// Idempotent: a second run changes nothing.
await db.exec(migration);

let checks = 0;
async function asUser(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid(n)]);
  await db.exec("set role authenticated");
}
async function asSystem() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
}
async function denied(sql, why) {
  await assert.rejects(db.exec(sql), why);
  checks++;
}
const one = async (sql) => (await db.query(sql)).rows[0];
const count = async (sql) => (await one(`select count(*)::int n from (${sql}) q`)).n;

// --- The seed: two names, exactly, and nothing else ---------------------------
await asSystem();
const seeded = (await db.query("select name, billing_email, quickbooks_customer_id, is_default, retired_at from bill_to_customers order by name")).rows;
assert.deepEqual(seeded.map((r) => r.name), ["STG Windows and Doors", "Strata"]); checks++;
assert.ok(seeded.every((r) => r.billing_email === null && r.quickbooks_customer_id === null && r.retired_at === null)); checks++;
assert.deepEqual(seeded.filter((r) => r.is_default).map((r) => r.name), ["STG Windows and Doors"]); checks++;
const STG = (await one("select id from bill_to_customers where name = 'STG Windows and Doors'")).id;
const STRATA = (await one("select id from bill_to_customers where name = 'Strata'")).id;

// --- Every existing job, trashed ones too, bills to STG ----------------------
assert.equal(await count(`select 1 from project_bill_to where bill_to_customer_id = '${STG}'`), 2); checks++;
assert.equal(await count("select 1 from projects p where not exists (select 1 from project_bill_to b where b.project_id = p.id)"), 0); checks++;

// --- Every new job is born with STG, whoever makes it ------------------------
await db.exec("insert into projects(job_code) values ('SYS1')");
await asUser(P.foreman);
await db.exec("insert into projects(job_code) values ('CREW1')");
await asSystem();
assert.equal(await count(`select 1 from project_bill_to b join projects p on p.id = b.project_id where p.job_code in ('SYS1','CREW1') and b.bill_to_customer_id = '${STG}' and b.updated_by is null`), 2); checks++;
assert.equal(await count("select 1 from project_bill_to_history"), 0, "the default a job is born with is not a change"); checks++;
await denied("insert into project_bill_to(project_id, bill_to_customer_id) values (gen_random_uuid(), null)", /null|foreign key/i);

// --- Who reads: supervisors, the owner, "Sees costs"; nobody else ------------
for (const n of [P.owner, P.supervisor, P.admin, P.costsInstaller, P.costsForeman]) {
  await asUser(n);
  assert.equal(await count("select 1 from bill_to_customers"), 2, `person ${n} reads the list`); checks++;
  assert.equal(await count("select 1 from project_bill_to"), 4, `person ${n} reads every job's bill-to`); checks++;
  assert.equal((await one(`select public.can_see_bill_to('${uid(n)}') ok`)).ok, true); checks++;
}
for (const n of [P.foreman, P.installer, P.partner, P.retired, P.revoked]) {
  await asUser(n);
  for (const table of ["bill_to_customers", "project_bill_to", "project_bill_to_history"]) {
    assert.equal(await count(`select 1 from ${table}`), 0, `person ${n} reads nothing from ${table}`); checks++;
  }
  assert.equal((await one(`select public.can_see_bill_to('${uid(n)}') ok`)).ok, false); checks++;
}

// --- Who writes: supervisors and the owner, through the RPCs only ------------
for (const n of [P.foreman, P.installer, P.costsInstaller, P.costsForeman, P.partner, P.retired, P.revoked]) {
  await asUser(n);
  await denied(`select public.set_project_bill_to('${OLD_JOB}','${STRATA}')`, /supervisor or the owner/);
  await denied(`select public.save_bill_to_customer(null,'Someone Else',null,null)`, /supervisor or the owner/);
  await denied(`select public.set_bill_to_customer_retired('${STRATA}',true)`, /supervisor or the owner/);
}
await asUser(P.supervisor);
for (const sql of [
  `insert into bill_to_customers(name) values ('Direct')`,
  `update bill_to_customers set quickbooks_customer_id = '9'`,
  `delete from bill_to_customers where id = '${STRATA}'`,
  `update project_bill_to set bill_to_customer_id = '${STRATA}'`,
  `delete from project_bill_to`,
  `insert into project_bill_to_history(project_id, to_customer_id) values ('${OLD_JOB}','${STRATA}')`,
  `truncate bill_to_customers cascade`,
]) await denied(sql, /permission denied/);

// A supervisor changes a job to Strata: one row, one log line with who.
await db.exec(`select public.set_project_bill_to('${OLD_JOB}','${STRATA}')`); checks++;
await asSystem();
let row = await one(`select bill_to_customer_id, updated_by from project_bill_to where project_id = '${OLD_JOB}'`);
assert.equal(row.bill_to_customer_id, STRATA); checks++;
assert.equal(row.updated_by, uid(P.supervisor)); checks++;
row = await one("select project_id, from_customer_id, to_customer_id, changed_by, changed_at from project_bill_to_history");
assert.deepEqual([row.project_id, row.from_customer_id, row.to_customer_id, row.changed_by], [OLD_JOB, STG, STRATA, uid(P.supervisor)]); checks++;
assert.ok(row.changed_at instanceof Date); checks++;

// Choosing what it already is logs nothing.
await asUser(P.owner);
await db.exec(`select public.set_project_bill_to('${OLD_JOB}','${STRATA}')`);
assert.equal(await count("select 1 from project_bill_to_history"), 1); checks++;
// And back to STG, by the owner: a second line.
await db.exec(`select public.set_project_bill_to('${OLD_JOB}','${STG}')`);
assert.equal(await count(`select 1 from project_bill_to_history where changed_by = '${uid(P.owner)}' and from_customer_id = '${STRATA}' and to_customer_id = '${STG}'`), 1); checks++;
// "Sees costs" reads the log.
await asUser(P.costsInstaller);
assert.equal(await count("select 1 from project_bill_to_history"), 2); checks++;

// Refusals a supervisor still gets.
await asUser(P.supervisor);
await denied(`select public.set_project_bill_to('${TRASHED_JOB}','${STRATA}')`, /trash/);
await denied(`select public.set_project_bill_to(gen_random_uuid(),'${STRATA}')`, /does not exist/);
await denied(`select public.set_project_bill_to('${OLD_JOB}',gen_random_uuid())`, /not on the bill-to list/);

// --- The list: add, validate, retire, never delete ---------------------------
const made = await one(`select * from public.save_bill_to_customer(null,'  Hyer Homes ','office@example.com','17')`);
assert.deepEqual([made.name, made.billing_email, made.quickbooks_customer_id, made.created_by], ["Hyer Homes", "office@example.com", "17", uid(P.supervisor)]); checks++;
await denied(`select public.save_bill_to_customer(null,'strata',null,null)`, /already on the list/);
await denied(`select public.save_bill_to_customer(null,'Other Co',null,'17')`, /already has that QuickBooks ID/);
await denied(`select public.save_bill_to_customer(null,'Other Co',null,'4a')`, /digits only/);
await denied(`select public.save_bill_to_customer(null,'Other Co','not an email',null)`, /does not look right/);
await denied(`select public.save_bill_to_customer(null,'   ',null,null)`, /name/);
await denied(`select public.save_bill_to_customer(gen_random_uuid(),'Nobody',null,null)`, /not on the bill-to list/);
// Typing STG's QuickBooks id and email in the app; blanks clear them again.
await db.exec(`select public.save_bill_to_customer('${STG}','STG Windows and Doors','billing@example.com','1234')`);
assert.equal((await one(`select quickbooks_customer_id q from bill_to_customers where id = '${STG}'`)).q, "1234"); checks++;
await db.exec(`select public.save_bill_to_customer('${made.id}','Hyer Homes','','')`);
row = await one(`select billing_email, quickbooks_customer_id from bill_to_customers where id = '${made.id}'`);
assert.deepEqual([row.billing_email, row.quickbooks_customer_id], [null, null]); checks++;

// Retire: STG (the default) refuses; Strata goes, stays readable, cannot be picked.
await denied(`select public.set_bill_to_customer_retired('${STG}',true)`, /cannot be retired/);
await db.exec(`select public.set_project_bill_to('${OLD_JOB}','${STRATA}')`);
await db.exec(`select public.set_bill_to_customer_retired('${STRATA}',true)`);
row = await one(`select retired_at, retired_by from bill_to_customers where id = '${STRATA}'`);
assert.ok(row.retired_at instanceof Date); checks++;
assert.equal(row.retired_by, uid(P.supervisor)); checks++;
await asUser(P.costsForeman);
assert.equal(await count("select 1 from bill_to_customers"), 3, "a retired customer is still on the list"); checks++;
assert.equal((await one(`select c.name from project_bill_to b join bill_to_customers c on c.id = b.bill_to_customer_id where b.project_id = '${OLD_JOB}'`)).name, "Strata", "a job keeps a customer that was retired after"); checks++;
await asUser(P.supervisor);
await denied(`select public.set_project_bill_to((select id from projects where job_code = 'SYS1'),'${STRATA}')`, /retired/);
// Bring it back.
await db.exec(`select public.set_bill_to_customer_retired('${STRATA}',false)`);
row = await one(`select retired_at, retired_by from bill_to_customers where id = '${STRATA}'`);
assert.deepEqual([row.retired_at, row.retired_by], [null, null]); checks++;

// Not even the system can delete a customer a job still bills to.
await asSystem();
await denied(`delete from bill_to_customers where id = '${STRATA}'`, /foreign key/);

// Anonymous callers get nothing at all.
await db.exec("reset role; set role anon");
await denied("select * from bill_to_customers", /permission denied/);
await denied("select * from project_bill_to", /permission denied/);
await denied(`select public.set_project_bill_to('${OLD_JOB}','${STG}')`, /permission denied/);
await denied(`select public.save_bill_to_customer(null,'Anon Co',null,null)`, /permission denied/);
await denied(`select public.can_see_bill_to('${uid(P.owner)}')`, /permission denied/);

// A purged job takes its bill-to and its log with it.
await asSystem();
await db.exec(`delete from projects where id = '${OLD_JOB}'`);
assert.equal(await count(`select 1 from project_bill_to where project_id = '${OLD_JOB}'`), 0); checks++;
assert.equal(await count(`select 1 from project_bill_to_history where project_id = '${OLD_JOB}'`), 0); checks++;

await db.close();
console.log(`${checks} isolated database checks passed. Base-role helpers were stubbed; production deployment was not tested.`);
