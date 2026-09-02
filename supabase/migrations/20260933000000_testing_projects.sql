-- Testing projects: a job can be flagged as fake data for practice.
-- Owner-confirmed 2026-08-25, Q1 of the four-part grill.
--
-- WHY THIS EXISTS
--
-- Training and QA both need a job that behaves exactly like a real one —
-- openings, packages, a plan set — without its material ever being counted
-- as real inventory or its openings ever showing up in front of an installer
-- or foreman who has no reason to see practice data. Today there is no such
-- line: any job any authenticated user creates looks exactly as real as
-- Black Desert.
--
-- THE SHAPE OF THE FIX
--
-- One boolean on `projects`. Below supervisor, a flagged row does not exist
-- (RLS on SELECT — hidden means hidden, same principle as
-- 20260730210000_soft_delete_openings.sql). The warehouse's inventory
-- figures exclude its packages client-side (app/src/lib/warehouse/
-- testPartition.ts) rather than through RLS on `packages` — see the note in
-- section 3 below for why that line is drawn where it is.
--
-- WHAT THIS DOES NOT DO
--
-- It does not hide a test project's openings or packages by RLS. Those
-- tables are reached through project joins all over the UI (warehouse
-- screens, the schedule, Ask Forge), and repeating "and the project isn't
-- a test project" in every one of those policies is exactly the "twenty-one
-- read paths, the twenty-first written wrong" failure the soft-delete
-- migration was written against — except worse here, because a package's
-- project is optional and mutable (Boneyard, reassignment), so the check
-- can't even be a static join target the way `removed_at` was. The
-- warehouse is the one place this material could be mistaken for real
-- stock, and it computes its figures client-side already, so that is where
-- the exclusion lives: every package the client fetches also carries enough
-- to know its project, and the project list a supervisor already has in
-- hand says which ones are test. An installer or foreman never receives a
-- test project in the first place (the SELECT policy below), so for them
-- the partition is naturally empty — there is nothing to filter because
-- there is nothing to see.

-- ---------------------------------------------------------------------------
-- 1. The flag
-- ---------------------------------------------------------------------------

alter table projects
  add column if not exists is_test boolean not null default false;

comment on column projects.is_test is
  'Fake data for practice or QA — never a real job. Rows are invisible below supervisor (RLS, this migration) and their packages are excluded from every warehouse inventory figure client-side (app/src/lib/warehouse/testPartition.ts) since the child tables are not RLS-gated on this flag. Written only by set_project_test(); insert/update on this column are revoked from anon and authenticated, exactly like profiles.is_test (20260730120000).';

-- `projects` carries table-level INSERT/UPDATE grants for `authenticated`
-- (the original "authenticated full access" policy below), so without this
-- revoke a plain PATCH naming is_test would flip it for anybody signed in —
-- the exact hole the sandbox system (20260730220000) exists to close.
-- Column privileges are enforced independently of RLS, so this holds even
-- though the row-level policies further down otherwise leave writes open.
revoke insert (is_test), update (is_test) on table projects from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. Row level security: a test project does not exist below supervisor
-- ---------------------------------------------------------------------------
-- Replaces the single `for all … using (true)` policy with one per command,
-- the same reason 20260730210000 gives: permissive policies OR together, so
-- a `for all using (true)` left standing beside a narrower SELECT policy
-- would just hand every hidden row straight back. INSERT/UPDATE/DELETE keep
-- exactly the access the old policy gave — nothing about who may create or
-- edit a job changes here, only who may SEE a job flagged is_test.

drop policy if exists "authenticated full access" on projects;

drop policy if exists "projects_select_visible" on projects;
create policy "projects_select_visible" on projects
  for select to authenticated using (
    is_test = false or _is_supervisor(auth.uid())
  );

drop policy if exists "projects_insert" on projects;
create policy "projects_insert" on projects
  for insert to authenticated with check (true);

drop policy if exists "projects_update" on projects;
create policy "projects_update" on projects
  for update to authenticated using (true) with check (true);

drop policy if exists "projects_delete" on projects;
create policy "projects_delete" on projects
  for delete to authenticated using (true);


-- ---------------------------------------------------------------------------
-- 3. Flip the flag (supervisor+)
-- ---------------------------------------------------------------------------
-- Also keeps `sandbox_projects` (20260730220000 — the projects a test/QA
-- LOGIN may write) in step: a testing project is fake data by definition, so
-- it is exactly the kind of project a QA automation account should be able
-- to write against, and unifying the two means one flag instead of a
-- supervisor having to separately ask an engineer to add the job to
-- sandbox_projects by hand. The automation account still cannot read that
-- table (zero client grants); this RPC can write it because it is SECURITY
-- DEFINER, same as is_sandbox_project's read.

create or replace function public.set_project_test(p_project uuid, p_is_test boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_zztest_id uuid;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can flag a job as a testing project';
  end if;

  update projects set is_test = p_is_test where id = p_project;
  if not found then
    raise exception 'that job does not exist';
  end if;

  if p_is_test then
    insert into sandbox_projects (project_id, note)
    values (p_project, 'Testing project — flagged in-app')
    on conflict (project_id) do nothing;
  else
    -- Never remove the dedicated automation-sandbox job (ZZTEST, seeded by
    -- 20260730220000) from this list even if somebody toggles the testing
    -- flag off on it by mistake — that would silently cut off the QA test
    -- login's only writable project. Every OTHER project this RPC ever
    -- added to sandbox_projects, it may also remove.
    select id into v_zztest_id from projects where job_code = 'ZZTEST';
    if v_zztest_id is null or p_project <> v_zztest_id then
      delete from sandbox_projects where project_id = p_project;
    end if;
  end if;
end;
$$;

comment on function public.set_project_test(uuid, boolean) is
  'Flags or unflags a job as fake practice/QA data. Supervisor+. Hides the row below supervisor (RLS) and keeps sandbox_projects — the projects a QA test login may write — in step.';

revoke all on function public.set_project_test(uuid, boolean) from public;
grant execute on function public.set_project_test(uuid, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Black Desert is the first testing project
-- ---------------------------------------------------------------------------

update projects set is_test = true where job_code = 'BLACK22';

insert into sandbox_projects (project_id, note)
select id, 'Black Desert — testing project'
from projects
where job_code = 'BLACK22'
on conflict (project_id) do nothing;


-- ---------------------------------------------------------------------------
-- 5. Hard delete, testing-only (owner)
-- ---------------------------------------------------------------------------
-- Refuses anything not already flagged is_test, so this can never be pointed
-- at a real job even by an owner.
--
-- What cascades and what doesn't, read off the foreign keys:
--   project_openings.project_id  … on delete cascade   (20260715120000)
--   install_events.project_opening_id … on delete cascade (20260715120000)
--   sandbox_projects.project_id  … on delete cascade   (20260730220000)
--   packages.project_id          … on delete SET NULL  (20260814000000)
-- Every project-scoped table cascades except packages, which is SET NULL on
-- purpose in the ordinary world — a job finishing or being merged must not
-- take its physical material down with it (Boneyard exists for exactly
-- this). A testing project has no "ordinary world" to protect: its packages
-- are fake stock, and leaving them behind with project_id cleared would turn
-- them into real-looking unassigned inventory, which is the one outcome
-- this whole feature exists to prevent. So packages are deleted here
-- explicitly, before the project row goes; package_marks and package_events
-- both reference packages(id) on delete cascade, so deleting packages is
-- enough to take those with it.

create or replace function public.delete_test_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_project projects;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role not in ('owner', 'big_boss') then
    raise exception 'only an owner can permanently delete a testing project';
  end if;

  select * into v_project from projects where id = p_project;
  if v_project is null then
    raise exception 'that job does not exist';
  end if;
  if not v_project.is_test then
    raise exception 'only a job flagged as a testing project can be permanently deleted this way';
  end if;

  delete from packages where project_id = p_project;
  delete from projects where id = p_project;
end;
$$;

comment on function public.delete_test_project(uuid) is
  'Permanently deletes a job flagged is_test — packages explicitly, everything else by cascade. Owner-only. Refuses any job not already flagged as testing.';

revoke all on function public.delete_test_project(uuid) from public;
grant execute on function public.delete_test_project(uuid) to authenticated;
