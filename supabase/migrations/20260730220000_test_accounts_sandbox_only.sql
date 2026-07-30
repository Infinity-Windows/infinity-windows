-- A test login may only change the sandbox job. Enforced by the database.
--
-- RENAMED FROM 20260730190000. Two pull requests merged six minutes apart and
-- this one lost the race: 20260730210000 (the opening soft delete) reached the
-- database first, so `supabase db push` refused this file as "a local migration
-- to be inserted before the last migration on remote" and it never applied.
-- Nothing had run it anywhere, so moving it to a later timestamp is safe and is
-- the whole fix. Unchanged otherwise.
--
-- WHY THIS EXISTS NOW. There is one test login today and it is an installer, so
-- the foreman half of the app has never been checked on a screen: dragging a
-- mark on the plan, the Undo bar, the reset-to-original buttons. Three fixes in
-- a row shipped with that side unverified. The answer is a second test login at
-- foreman rank — and foreman here is a powerful role. A foreman can move marks,
-- undo and reset them, and since 20260730180000 re-read a plan set and delete
-- openings. A bug in the re-extract path earlier this week could have
-- destroyed real field work through cascading deletes. An unattended automation
-- account holding that power on the production database is not acceptable, and
-- the point of this migration is to get the verification ability without it.
--
-- Taylor's instruction was that the account be "kept pointed at the test
-- sandbox job". A rule in a document is not a control — it has already failed
-- here once this week — so this is a control:
--
--   A profile flagged `is_test` may INSERT, UPDATE or DELETE a row only when
--   that row belongs to a project listed in `public.sandbox_projects`.
--
-- WHAT THIS DOES NOT DO, AND CANNOT DO
--
-- Nothing here loosens a single grant or policy, and nothing here changes what
-- a real foreman, installer, supervisor or owner may do. Every guard below
-- returns immediately unless `is_test_profile(auth.uid())` is true, so on the
-- rows belonging to real people it is one primary-key lookup and a pass. There
-- are exactly two test profiles on this database and there is no path by which
-- a crew member's account can acquire the flag: `is_test` is revoked from anon
-- and authenticated at the column level (20260730120000), so only the
-- service-role key can set it.
--
-- WHY TRIGGERS AND A TABLE, NOT RLS
--
-- The rule is "this account, on that project". RLS could express it — a
-- restrictive policy per table — but there are dozens of project-scoped tables
-- and a restrictive policy is invisible in the place people look (the
-- permissive policy) while silently narrowing what everyone else sees. A
-- BEFORE trigger says the thing out loud, refuses with a sentence a person can
-- read, and covers the SECURITY DEFINER RPC path as well: undo_opening_pin_move
-- and the two reset functions run as the table owner and so are past RLS
-- entirely, but they still have to write project_openings, and that write goes
-- through this trigger. No RPC needed changing.
--
-- Storage is the one place a policy is the only tool, because storage.objects
-- has no project column to hang a trigger's meaning on and it is not our table
-- to add triggers to. Those three policies are RESTRICTIVE and scoped to
-- INSERT, UPDATE and DELETE, so a real user's condition is `not false` and
-- reads are untouched — the installer test account still needs to open Black
-- Desert's plan set, which is the whole reason it exists.
--
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. Which projects a test login is allowed to write
-- ---------------------------------------------------------------------------
-- A table rather than a `projects.is_sandbox` column, for a privilege reason.
-- `projects` carries table-level INSERT/UPDATE grants for `authenticated`, and
-- Postgres will not let you subtract a column from a table-level grant, so a
-- new column on `projects` would be writable by every signed-in crew member and
-- would need its own trigger to protect it. A new table starts with no grants
-- once Supabase's default privileges are taken back, and absent grants beat any
-- policy anyone adds later.

create table if not exists public.sandbox_projects (
  project_id uuid primary key references public.projects(id) on delete cascade,
  added_at timestamptz not null default now(),
  note text
);

comment on table public.sandbox_projects is
  'Projects a test/automation login (profiles.is_test) is allowed to write. Everything else on this database is read-only to those accounts. Maintained by scripts/provision-test-foreman.py on the service-role key; unreadable and unwritable by any client role.';

-- Supabase's ALTER DEFAULT PRIVILEGES grants ALL on every new public table to
-- anon and authenticated, so start from nothing. TRUNCATE is included for the
-- reason 20260729210000 spells out: it is not subject to row-level security, so
-- leaving it granted leaves a way past every policy.
revoke all on table public.sandbox_projects from anon, authenticated;
grant select, insert, delete on table public.sandbox_projects to service_role;

alter table public.sandbox_projects enable row level security;
-- No policies, deliberately. With RLS on and no policy, no client role can see
-- or touch this table even if a grant is restored by accident.

-- The sandbox job the installer test account already uses. Seeded here so the
-- constraint is live from the moment this migration lands, whether or not the
-- provisioning script has run. A no-op on a database that has no such job.
insert into public.sandbox_projects (project_id, note)
select id, 'TEST — automation sandbox. The only job a test login may write.'
from public.projects
where job_code = 'ZZTEST'
on conflict (project_id) do nothing;


-- ---------------------------------------------------------------------------
-- 2. Is this project the sandbox?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because `authenticated` cannot read sandbox_projects at all
-- and must not be able to. NULL answers false: a row a test account writes
-- whose project cannot be determined is refused rather than waved through.

create or replace function public.is_sandbox_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_project_id is not null and exists (
    select 1 from public.sandbox_projects s where s.project_id = p_project_id
  );
$$;

comment on function public.is_sandbox_project(uuid) is
  'True when this project is an automation sandbox that a test login may write. NULL is false.';

revoke all on function public.is_sandbox_project(uuid) from public, anon;
grant execute on function public.is_sandbox_project(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. Which project does this row belong to?
-- ---------------------------------------------------------------------------
-- Three shapes cover every project-scoped table in this schema: the row IS a
-- project (`projects.id`), the row names one (`project_id`), or the row hangs
-- off an opening (`project_opening_id` / `opening_id`) which names one. The
-- caller passes which shape it is, decided once when the trigger is attached,
-- so nothing is guessed per row.

create or replace function public.row_project_id(p_kind text, p_value text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_value is null then
    return null;
  end if;
  begin
    v_id := p_value::uuid;
  exception when others then
    return null;
  end;

  if p_kind = 'project' then
    return v_id;
  end if;
  -- 'opening'
  return (select o.project_id from public.project_openings o where o.id = v_id);
end;
$$;

comment on function public.row_project_id(text, text) is
  'Resolve the project a row belongs to, given the kind of link it carries (project | opening) and the value of that column.';

revoke all on function public.row_project_id(text, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The guard
-- ---------------------------------------------------------------------------
-- Attached below to every project-scoped table. Trigger arguments are the
-- column to read and the kind of link it is.
--
-- An UPDATE is checked on BOTH sides. Otherwise a test account could move a row
-- out of a real job into the sandbox (which is a change to the real job) or the
-- reverse (which puts a row it created into one).
--
-- This deliberately does NOT honour the `app.pin_undo` escape hatch that
-- guard_opening_pin_move and record_opening_pin_move check. That flag means
-- "this write came from undo, whose caller has already been rank-checked"; it
-- says nothing about which job is being written, which is the question here.

create or replace function public.guard_test_account_sandbox_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind    text := tg_argv[1];
  v_column  text := tg_argv[0];
  v_uid     uuid := auth.uid();
  v_project uuid;
begin
  -- No JWT: a migration, a seed, or an edge function on the service-role key.
  -- All of those are already trusted above RLS, and this guard is about one
  -- specific kind of signed-in account.
  if v_uid is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- The fast path, and the reason this is safe to put on forty tables: for
  -- every real crew member it is one primary-key lookup on profiles and a
  -- return. `is_test_profile` is STABLE, so a statement touching many rows
  -- resolves it once.
  if not public.is_test_profile(v_uid) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op <> 'INSERT' then
    v_project := public.row_project_id(v_kind, to_jsonb(old) ->> v_column);
    if not public.is_sandbox_project(v_project) then
      raise exception
        'This is a test login. It can only change the automation sandbox job, not a real one.'
        using errcode = '42501',
              detail = format('refused %s on %s (project %s)',
                              tg_op, tg_table_name,
                              coalesce(v_project::text, 'unknown'));
    end if;
  end if;

  if tg_op <> 'DELETE' then
    v_project := public.row_project_id(v_kind, to_jsonb(new) ->> v_column);
    if not public.is_sandbox_project(v_project) then
      raise exception
        'This is a test login. It can only change the automation sandbox job, not a real one.'
        using errcode = '42501',
              detail = format('refused %s on %s (project %s)',
                              tg_op, tg_table_name,
                              coalesce(v_project::text, 'unknown'));
    end if;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

comment on function public.guard_test_account_sandbox_only() is
  'Refuses any write by a profiles.is_test account to a row outside a sandbox project. A no-op for every real account and for the service-role key.';

revoke all on function public.guard_test_account_sandbox_only() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Attach it to every project-scoped table there is
-- ---------------------------------------------------------------------------
-- Discovered from the catalogue rather than typed out, because a hand-written
-- list is exactly the kind of thing that goes stale the next time somebody adds
-- a table. Ordinary tables only: a BEFORE ... FOR EACH ROW trigger cannot sit
-- on a partitioned parent, and a view has nothing to guard.
--
-- Precedence matters. Every table has an `id`, so `id` is only the answer for
-- `projects` itself; otherwise the direct `project_id` wins, then a link to an
-- opening.

do $$
declare
  r        record;
  v_column text;
  v_kind   text;
  v_count  int := 0;
begin
  for r in
    select c.relname::text as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname <> 'sandbox_projects'
    order by c.relname
  loop
    v_column := null;
    v_kind := null;

    if r.name = 'projects' then
      v_column := 'id';
      v_kind := 'project';
    elsif exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.name
        and column_name = 'project_id'
    ) then
      v_column := 'project_id';
      v_kind := 'project';
    elsif exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.name
        and column_name = 'project_opening_id'
    ) then
      v_column := 'project_opening_id';
      v_kind := 'opening';
    elsif exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.name
        and column_name = 'opening_id'
    ) then
      v_column := 'opening_id';
      v_kind := 'opening';
    end if;

    if v_column is null then
      continue;
    end if;

    execute format(
      'drop trigger if exists guard_test_account_sandbox_only on public.%I', r.name);
    execute format(
      'create trigger guard_test_account_sandbox_only '
      'before insert or update or delete on public.%I '
      'for each row execute function public.guard_test_account_sandbox_only(%L, %L)',
      r.name, v_column, v_kind);
    v_count := v_count + 1;
  end loop;

  raise notice 'sandbox guard attached to % project-scoped table(s)', v_count;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. A test login cannot touch anybody else's profile, or any role
-- ---------------------------------------------------------------------------
-- The profiles UPDATE policy (20260729200000) lets a foreman or above edit any
-- crew member's display name, skill tier and on-site flag — that is the Roster
-- screen and real foremen need it. A test login at foreman rank inherits it,
-- and renaming a real installer or marking them off-site is exactly the kind of
-- quiet damage an unattended script should not be able to do. So a test account
-- is narrowed to its own row.
--
-- Roles are already beyond it twice over: `profiles.role` is revoked from
-- authenticated at the column level, and set_profile_role() requires supervisor
-- rank, which a foreman does not have. This adds the third layer so the answer
-- stays no if that ladder is ever changed.

create or replace function public.guard_test_account_profile_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_test_profile(v_uid) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'This is a test login. It cannot remove a crew member.'
      using errcode = '42501';
  end if;

  if new.id <> v_uid then
    raise exception 'This is a test login. It can only change its own profile.'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    raise exception 'This is a test login. It cannot change anyone''s role, including its own.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.guard_test_account_profile_writes() is
  'Narrows a profiles.is_test account to its own profile row and refuses any role change by it. A no-op for every real account.';

revoke all on function public.guard_test_account_profile_writes() from public, anon, authenticated;

drop trigger if exists guard_test_account_profile_writes on public.profiles;
create trigger guard_test_account_profile_writes
  before insert or update or delete on public.profiles
  for each row execute function public.guard_test_account_profile_writes();


-- ---------------------------------------------------------------------------
-- 7. A test login cannot hand out a login
-- ---------------------------------------------------------------------------
-- Today it already cannot: minting an invite goes through manage-crew-access,
-- which requires supervisor rank, and a foreman cannot even read crew_invites.
-- This is here because that could change — "let a foreman add his own crew" is
-- an obvious future request — and an automation account must never become a way
-- to create accounts. The check is on `invited_by`, which the client cannot set:
-- the edge function fills it from the verified JWT.

create or replace function public.guard_test_account_cannot_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_test_profile(new.invited_by)
     or (auth.uid() is not null and public.is_test_profile(auth.uid())) then
    raise exception 'This is a test login. It cannot give anybody access to the app.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_test_account_cannot_invite() is
  'Refuses an invite authored by a profiles.is_test account, whatever the role ladder says at the time.';

revoke all on function public.guard_test_account_cannot_invite() from public, anon, authenticated;

drop trigger if exists guard_test_account_cannot_invite on public.crew_invites;
create trigger guard_test_account_cannot_invite
  before insert or update on public.crew_invites
  for each row execute function public.guard_test_account_cannot_invite();


-- ---------------------------------------------------------------------------
-- 8. Storage: a test login writes only the sandbox job's folder
-- ---------------------------------------------------------------------------
-- The plan-set PDFs and every site photo live in two buckets whose only policy
-- is `for all to authenticated using (bucket_id in (...))`, so any signed-in
-- account can overwrite or delete any of them. Deleting Black Desert's plan set
-- is real damage that no trigger on a public table would catch.
--
-- Both buckets are keyed by project id in the first path segment
-- (`<project_id>/…`), which is what makes this expressible at all.

create or replace function public.is_sandbox_storage_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_name is null then
    return false;
  end if;
  begin
    v_id := split_part(p_name, '/', 1)::uuid;
  exception when others then
    -- A path that does not start with a project id cannot be shown to belong to
    -- the sandbox, so for a test account it is refused.
    return false;
  end;
  return public.is_sandbox_project(v_id);
end;
$$;

comment on function public.is_sandbox_storage_path(text) is
  'True when a storage object name is inside a sandbox project''s folder. Used only to scope writes by test logins.';

revoke all on function public.is_sandbox_storage_path(text) from public, anon;
grant execute on function public.is_sandbox_storage_path(text) to authenticated, service_role;

-- RESTRICTIVE, and split per command so SELECT is untouched. A restrictive
-- policy is ANDed with the permissive ones, and for every account that is not a
-- test login the condition is `not false` — true — so nothing a real person
-- does changes. Writes only: reading a real plan set is what the installer test
-- account exists to do.
drop policy if exists "test logins write only their sandbox (insert)" on storage.objects;
create policy "test logins write only their sandbox (insert)" on storage.objects
  as restrictive for insert to authenticated
  with check (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
  );

drop policy if exists "test logins write only their sandbox (update)" on storage.objects;
create policy "test logins write only their sandbox (update)" on storage.objects
  as restrictive for update to authenticated
  using (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
  )
  with check (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
  );

drop policy if exists "test logins write only their sandbox (delete)" on storage.objects;
create policy "test logins write only their sandbox (delete)" on storage.objects
  as restrictive for delete to authenticated
  using (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
  );


-- ---------------------------------------------------------------------------
-- 9. Tell the truth about what is left over
-- ---------------------------------------------------------------------------
-- The guard above covers every table that can be tied to a project. Some tables
-- cannot be — the window-type catalogue, the warehouse shelves, the cost codes.
-- A test login at foreman rank can still write those, and pretending otherwise
-- would be worse than saying so. This function is what the provisioning run
-- prints, so the residual list is measured on the live database rather than
-- guessed at in a document that ages.
--
-- `client_writable` is an upper bound: it asks whether the grant exists, not
-- whether a policy would allow the row. An honest over-report is the right
-- error direction for a list of things nobody is watching.

create or replace function public.test_account_write_scope()
returns table (
  table_name      text,
  link_column     text,
  guarded         boolean,
  client_writable boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with tables as (
    select c.oid, c.relname::text as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname <> 'sandbox_projects'
  ),
  linked as (
    select
      t.oid,
      t.name,
      case
        when t.name = 'projects' then 'id'
        when exists (select 1 from information_schema.columns col
                     where col.table_schema = 'public' and col.table_name = t.name
                       and col.column_name = 'project_id') then 'project_id'
        when exists (select 1 from information_schema.columns col
                     where col.table_schema = 'public' and col.table_name = t.name
                       and col.column_name = 'project_opening_id') then 'project_opening_id'
        when exists (select 1 from information_schema.columns col
                     where col.table_schema = 'public' and col.table_name = t.name
                       and col.column_name = 'opening_id') then 'opening_id'
      end as link_column
    from tables t
  )
  select
    l.name,
    l.link_column,
    exists (
      select 1 from pg_trigger tg
      where tg.tgrelid = l.oid
        and tg.tgname = 'guard_test_account_sandbox_only'
        and not tg.tgisinternal
    ),
    has_table_privilege('authenticated', l.oid, 'INSERT')
      or has_table_privilege('authenticated', l.oid, 'UPDATE')
      or has_table_privilege('authenticated', l.oid, 'DELETE')
  from linked l
  order by l.link_column nulls first, l.name;
$$;

comment on function public.test_account_write_scope() is
  'Every public table, the column that ties it to a project, whether the sandbox guard is attached, and whether a client role holds any write grant. A row with no link_column and client_writable = true is residual risk a test login could reach; see docs/test-account.md.';

revoke all on function public.test_account_write_scope() from public, anon, authenticated;
grant execute on function public.test_account_write_scope() to service_role;
