-- Platform stubs for the schedule_ai_reasons checks (K2.8). Disposable records
-- only: no production data, no real job or person. Used by
-- scripts/verify-schedule-ai-reasons.mjs (PGlite).
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

-- Match Supabase's defaults: every new table in public is handed to anon and
-- authenticated, so the migration's own REVOKE is what has to shut the door.
alter default privileges in schema public grant all on tables to anon, authenticated;

create table profiles(id uuid primary key, role text, display_name text, active boolean default true,
  access_revoked_at timestamptz, retired_at timestamptz, is_partner boolean default false, is_test boolean default false);
create table projects(id uuid primary key, name text, job_code text, deleted_at timestamptz, is_test boolean default false);

-- schedule_assignments and schedule_events as 20260721010000 made them, plus
-- created_via (20260955010000), with the policies 20261003000000 left on them:
-- every non-partner login reads; supervisors write. schedule_events is the
-- crew-READABLE audit table the reason must never be on.
create table schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  start_time time null,
  status text not null default 'draft'
    check (status in ('draft','published','in_progress','done','canceled')),
  color text null,
  note text null,
  created_by uuid references profiles(id) on delete set null,
  created_via text check (created_via is null or created_via = 'ai'),
  published_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table schedule_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid null,
  actor uuid references profiles(id) on delete set null,
  kind text check (kind in ('created','published','moved','resized','reassigned','removed','edited')),
  payload jsonb,
  created_at timestamptz not null default now()
);
create table app_release_notes(id text primary key, published_on date, audience int[], kind text,
  title_en text, title_es text, body_en text, body_es text, href text);

create function public.is_partner_user() returns boolean language sql stable security definer as $$
  select coalesce((select is_partner from profiles where id = auth.uid()), false) $$;
-- 20260723020000's rank check, the one the schedule write policies use.
create function public.travel_is_supervisor() returns boolean language sql stable security definer as $$
  select coalesce((select role in ('supervisor','owner','admin','big_boss') from profiles where id = auth.uid()), false) $$;

alter table schedule_assignments enable row level security;
alter table schedule_events enable row level security;
revoke all on schedule_assignments, schedule_events, app_release_notes from anon, authenticated;
grant select, insert, update, delete on schedule_assignments, schedule_events to authenticated;
grant select on profiles, projects to authenticated;
create policy "schedule internal read" on schedule_assignments for select to authenticated
  using (not public.is_partner_user());
create policy "schedule supervisor write" on schedule_assignments for all to authenticated
  using (not public.is_partner_user() and public.travel_is_supervisor())
  with check (not public.is_partner_user() and public.travel_is_supervisor());
create policy "schedule events internal read" on schedule_events for select to authenticated
  using (not public.is_partner_user());
create policy "schedule events supervisor write" on schedule_events for all to authenticated
  using (not public.is_partner_user() and public.travel_is_supervisor())
  with check (not public.is_partner_user() and public.travel_is_supervisor());
