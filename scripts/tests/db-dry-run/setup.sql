-- A tiny Supabase, for scripts/db-dry-run-harness.test.sh: just enough of the
-- real project for the harness to do what it does there — the client roles,
-- auth.uid() reading the JWT claims, profiles with the columns the pickers
-- filter on, projects with a job code, the sandbox list, and the project's
-- default privileges (20260992000000), which are what make every grant in the
-- harness load-bearing.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
  )::uuid
$$;
grant usage on schema public, auth to anon, authenticated;

create table public.profiles (
  id uuid primary key,
  role text not null,
  display_name text,
  is_test boolean not null default false,
  is_partner boolean not null default false,
  retired_at timestamptz,
  access_revoked_at timestamptz
);
create table public.projects (
  id uuid primary key,
  job_code text not null,
  is_test boolean not null default false,
  deleted_at timestamptz
);
create table public.sandbox_projects (project_id uuid primary key references public.projects(id));
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
grant select on public.profiles, public.projects to authenticated;
create policy profiles_read on public.profiles for select to authenticated using (true);
-- A testing job is invisible below supervisor, as in production.
create policy projects_read on public.projects for select to authenticated using (
  not is_test or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('supervisor', 'owner'))
);

-- Two QA logins and three real people — a real installer and a real foreman
-- for the pickers to (wrongly) fall back to if a QA login lost its role — plus
-- a retired one and a partner that the pickers must skip.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'qa.installer@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'qa.foreman@example.test'),
  ('00000000-0000-4000-8000-000000000003', 'real.installer@example.test'),
  ('00000000-0000-4000-8000-000000000004', 'real.supervisor@example.test'),
  ('00000000-0000-4000-8000-000000000005', 'retired.installer@example.test'),
  ('00000000-0000-4000-8000-000000000006', 'partner.installer@example.test'),
  ('00000000-0000-4000-8000-000000000007', 'real.foreman@example.test');
insert into public.profiles (id, role, display_name, is_test, is_partner, retired_at) values
  ('00000000-0000-4000-8000-000000000001', 'installer', 'TEST — automation', true, false, null),
  ('00000000-0000-4000-8000-000000000002', 'foreman', 'TEST — automation FOREMAN', true, false, null),
  ('00000000-0000-4000-8000-000000000003', 'installer', 'Real Installer', false, false, null),
  ('00000000-0000-4000-8000-000000000004', 'supervisor', 'Real Supervisor', false, false, null),
  ('00000000-0000-4000-8000-000000000005', 'installer', 'Retired', false, false, now()),
  ('00000000-0000-4000-8000-000000000006', 'installer', 'Partner', false, true, null),
  ('00000000-0000-4000-8000-000000000007', 'foreman', 'Real Foreman', false, false, null);

-- A real job; three that qualify as the sandbox, in dry_run_sandbox_job's
-- order (PECAN14, BLACK22, then by code: MADMOOSE); and three decoys whose
-- codes sort ahead of all of them, each failing one test — in the trash,
-- flagged but not on the sandbox list, on the list but not flagged.
insert into public.projects (id, job_code, is_test, deleted_at) values
  ('00000000-0000-4000-8000-000000000090', 'BLACK22', true, null),
  ('00000000-0000-4000-8000-000000000091', 'REAL01', false, null),
  ('00000000-0000-4000-8000-000000000092', 'PECAN14', true, null),
  ('00000000-0000-4000-8000-000000000093', 'MADMOOSE', true, null),
  ('00000000-0000-4000-8000-000000000094', 'AAA-TRASHED', true, now()),
  ('00000000-0000-4000-8000-000000000095', 'AAA-NOT-LISTED', true, null),
  ('00000000-0000-4000-8000-000000000096', 'AAA-NOT-FLAGGED', false, null);
insert into public.sandbox_projects values
  ('00000000-0000-4000-8000-000000000090'),
  ('00000000-0000-4000-8000-000000000092'),
  ('00000000-0000-4000-8000-000000000093'),
  ('00000000-0000-4000-8000-000000000094'),
  ('00000000-0000-4000-8000-000000000096');

-- What the project's default privileges do to a function postgres creates:
-- no EXECUTE for public, in any schema — pg_temp included.
alter default privileges for role postgres revoke execute on functions from public;
