// Disposable PostgreSQL proof for the QC migration. No production connection.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { installer: id(1), foreman: id(2), supervisor: id(3), partner: id(4), revoked: id(5), testForeman: id(6) };
const opening = { fresh: id(101), old: id(102), realForTest: id(103), atomic: id(104) };
const job = { sandbox: id(201), real: id(202) };
let checks = 0;

await db.exec(`
  create role authenticated; create role anon; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema public, auth to authenticated, anon, service_role;
  create table public.profiles(
    id uuid primary key, role text not null, retired_at timestamptz,
    access_revoked_at timestamptz, is_partner boolean not null default false,
    is_test boolean not null default false
  );
  create table public.project_openings(
    id uuid primary key, project_id uuid not null, status text not null,
    removed_at timestamptz
  );
  create table public.qc_checks(
    id uuid primary key default gen_random_uuid(),
    project_opening_id uuid not null unique references public.project_openings(id) on delete cascade,
    status text not null check (status in ('pending', 'passed', 'callback')),
    note text, checked_by uuid references public.profiles(id) on delete set null,
    checked_at timestamptz, created_at timestamptz not null default now()
  );
  create table public.points_ledger(
    id uuid primary key default gen_random_uuid(), ref text not null,
    status text not null, void_reason text
  );
  create table public.sandbox_projects(project_id uuid primary key);
  create function public.is_partner_user() returns boolean language sql stable security definer
    set search_path = public as $$
    select coalesce((select is_partner from profiles where id = auth.uid()), false)
  $$;
  create function public.my_role_rank() returns int language sql stable security definer
    set search_path = public as $$
    select case role when 'installer' then 0 when 'foreman' then 1
      when 'supervisor' then 2 when 'owner' then 3 else -1 end
    from profiles where id = auth.uid()
  $$;
  create function public.guard_test_account_sandbox_only() returns trigger
  language plpgsql security definer set search_path = public as $$
  declare v_job uuid;
  begin
    if coalesce((select is_test from profiles where id=auth.uid()), false) then
      select project_id into v_job from project_openings
        where id = coalesce(new.project_opening_id, old.project_opening_id);
      if not exists(select 1 from sandbox_projects where project_id=v_job) then
        raise exception 'Test account cannot write a real job.' using errcode='42501';
      end if;
    end if;
    return coalesce(new, old);
  end; $$;
  create function public.attach_sandbox_guards()
    returns table(table_name text, link_column text, link_kind text, action text)
    language sql as $$ select null::text, null::text, null::text, null::text where false $$;
  alter table public.qc_checks enable row level security;
  create policy "authenticated full access" on public.qc_checks
    for all to authenticated using (not public.is_partner_user())
    with check (not public.is_partner_user());
  grant select, insert, update, delete on public.qc_checks to authenticated;
  grant select on public.project_openings to authenticated;
  create trigger guard_test_account_sandbox_only before insert or update or delete
    on public.qc_checks for each row
    execute function public.guard_test_account_sandbox_only('project_opening_id', 'opening');
`);

// Exercise the real points function that the new QC command calls.
const pointsSql = await readFile(new URL('../supabase/migrations/20260991000000_points_cap.sql', import.meta.url), 'utf8');
const pointsStart = pointsSql.indexOf('create or replace function public.resolve_install_points(');
assert.ok(pointsStart >= 0);
const pointsEnd = pointsSql.indexOf('$$;', pointsSql.indexOf('as $$', pointsStart));
await db.exec(pointsSql.slice(pointsStart, pointsEnd + 3));

for (const [name, role, extra] of [
  ['installer', 'installer', ''], ['foreman', 'foreman', ''],
  ['supervisor', 'supervisor', ''], ['partner', 'foreman', 'partner'],
  ['revoked', 'foreman', 'revoked'], ['testForeman', 'foreman', 'test'],
]) {
  await db.query(`insert into profiles(id, role, is_partner, is_test, access_revoked_at)
    values($1,$2,$3,$4,$5)`, [actor[name], role, extra === 'partner', extra === 'test', extra === 'revoked' ? '2026-09-01T00:00:00Z' : null]);
}
await db.query('insert into sandbox_projects values($1)', [job.sandbox]);
for (const [name, projectId] of [
  ['fresh', job.sandbox], ['old', job.sandbox],
  ['realForTest', job.real], ['atomic', job.sandbox],
]) await db.query('insert into project_openings(id,project_id,status) values($1,$2,$3)', [opening[name], projectId, 'installed']);
await db.query("insert into qc_checks(project_opening_id,status,note) values($1,'callback','Old issue')", [opening.old]);
for (const name of ['fresh', 'atomic']) await db.query("insert into points_ledger(ref,status) values($1,'pending')", [opening[name]]);

const migration = await readFile(new URL('../supabase/migrations/20261041000000_qc_decision_authority.sql', import.meta.url), 'utf8');
await db.exec(migration);

async function admin() {
  await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false)");
}
async function as(name) {
  await admin();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor[name]]);
  await db.exec('set role authenticated');
}
async function read(sql, params = []) { await admin(); return (await db.query(sql, params)).rows; }
async function denied(fn) { await assert.rejects(fn); checks++; }
async function decide(who, request, unit, status, note = null) {
  await as(who);
  return db.query('select record_qc_decision($1,$2,$3,$4)', [id(request), opening[unit], status, note]);
}
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }

equal((await read("select status,note,reviewer_id,source from qc_decision_events where project_opening_id=$1", [opening.old]))[0],
  { status: 'callback', note: 'Old issue', reviewer_id: null, source: 'legacy_snapshot' });
await as('installer');
await denied(() => db.query("insert into qc_checks(project_opening_id,status) values($1,'passed')", [opening.fresh]));
await denied(() => db.query("update qc_checks set status='passed' where project_opening_id=$1", [opening.old]));
await denied(() => db.query("delete from qc_checks where project_opening_id=$1", [opening.old]));
await denied(() => db.query("select record_qc_decision($1,$2,'passed',null)", [id(301), opening.fresh]));
equal((await db.query('select status from qc_checks where project_opening_id=$1', [opening.old])).rows[0].status, 'callback');
equal((await db.query('select * from qc_decision_events')).rows.length, 0);
await denied(() => db.query("insert into qc_decision_events(id,project_opening_id,status,decided_at,source) values($1,$2,'passed',now(),'review')", [id(302), opening.fresh]));

await decide('foreman', 303, 'fresh', 'passed', 'Looks good');
equal((await read('select status,note,checked_by,checked_at is not null as stamped from qc_checks where project_opening_id=$1', [opening.fresh]))[0],
  { status: 'passed', note: 'Looks good', checked_by: actor.foreman, stamped: true });
equal((await read('select status from points_ledger where ref=$1', [opening.fresh]))[0].status, 'confirmed');
await decide('supervisor', 304, 'fresh', 'callback', 'Seal needs correction');
equal((await read('select status, reviewer_id from qc_decision_events where project_opening_id=$1 order by decided_at,id', [opening.fresh])).map(r => r.status), ['passed', 'callback']);
equal((await read('select status from qc_checks where project_opening_id=$1', [opening.fresh]))[0].status, 'callback');
await decide('foreman', 303, 'fresh', 'passed', 'Looks good');
equal((await read('select count(*)::int as n from qc_decision_events where project_opening_id=$1', [opening.fresh]))[0].n, 2);
equal((await read('select status from qc_checks where project_opening_id=$1', [opening.fresh]))[0].status, 'callback');
await denied(() => decide('foreman', 303, 'fresh', 'callback', 'Different payload'));
await denied(() => decide('partner', 305, 'fresh', 'passed'));
await denied(() => decide('revoked', 306, 'fresh', 'passed'));
await denied(() => decide('testForeman', 307, 'realForTest', 'passed'));
equal((await read('select count(*)::int as n from qc_decision_events where project_opening_id=$1', [opening.realForTest]))[0].n, 0);

await admin();
await db.exec(`create function reject_atomic_points() returns trigger language plpgsql as $$
  begin if new.ref='${opening.atomic}' then raise exception 'forced points failure'; end if; return new; end $$;
  create trigger reject_atomic_points before update on points_ledger
    for each row execute function reject_atomic_points();`);
await denied(() => decide('foreman', 308, 'atomic', 'passed'));
equal((await read('select count(*)::int as n from qc_checks where project_opening_id=$1', [opening.atomic]))[0].n, 0);
equal((await read('select count(*)::int as n from qc_decision_events where project_opening_id=$1', [opening.atomic]))[0].n, 0);

console.log(`QC authority and history: ${checks} checks passed (disposable PGlite)`);
await db.close();
