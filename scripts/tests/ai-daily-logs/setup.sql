-- Platform stubs for the AI daily-log contribution checks. Disposable records
-- only: no production data, no real job or person. Shared by
-- scripts/verify-ai-daily-logs.mjs (PGlite) and
-- scripts/test-ai-daily-logs-postgres.sh (PostgreSQL 16, concurrent sessions).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema if not exists auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to authenticated, anon;

create table profiles(id uuid primary key, role text, display_name text, active boolean default true,
  access_revoked_at timestamptz, retired_at timestamptz, partner boolean default false, is_test boolean default false);
create table projects(id uuid primary key, name text, deleted_at timestamptz, is_test boolean default false);
create table sandbox_projects(project_id uuid primary key);
-- The columns the photo outbox writes (outboxHandlers.ts `upload`).
create table attachments(id uuid primary key default gen_random_uuid(), client_id uuid unique,
  project_id uuid, created_by text, storage_path text not null, kind text not null default 'photo', caption text);

create function is_partner_user() returns boolean language sql stable security definer as $$
  select coalesce((select partner from profiles where id = auth.uid()), false) $$;
create function my_role_rank() returns int language sql stable security definer as $$
  select case role when 'foreman' then 1 when 'lead' then 1 when 'supervisor' then 2 when 'admin' then 2
    when 'owner' then 3 when 'big_boss' then 3 else 0 end from profiles where id = auth.uid() $$;
create function _is_lead(p uuid) returns boolean language sql stable security definer as $$
  select coalesce((select role in ('foreman','lead','supervisor','admin','owner','big_boss') from profiles where id = p), false) $$;
create function _is_supervisor(p uuid) returns boolean language sql stable security definer as $$
  select coalesce((select role in ('supervisor','admin','owner','big_boss') from profiles where id = p), false) $$;
create function is_test_profile(p uuid) returns boolean language sql stable security definer as $$
  select coalesce((select is_test from profiles where id = p), false) $$;
create function is_sandbox_project(p uuid) returns boolean language sql stable security definer as $$
  select p is not null and exists (select 1 from sandbox_projects where project_id = p) $$;
-- The real fence is covered by scripts/test_sandbox_guard.py; here it is a call.
create function attach_sandbox_guards() returns void language sql as $$ select $$;

grant select on profiles, projects, attachments to authenticated;

-- The columns of ai_field_requests (20261024000000) a contribution's evidence
-- is checked against.
create table ai_field_requests(id uuid primary key, profile_id uuid not null references profiles(id), conversation_id uuid);
