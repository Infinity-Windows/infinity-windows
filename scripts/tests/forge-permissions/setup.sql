-- Synthetic infrastructure for the real Schedule/Travel migration replay.
-- No auth users, storage bytes or business records are copied from production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create table public.profiles (id uuid primary key, role text, is_partner boolean default false);
create table public.projects (id uuid primary key);
create function public.is_partner_user() returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce((select is_partner from profiles where id=auth.uid()),false);
$$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create table public.vehicle_project_assignments (
 id uuid primary key default gen_random_uuid(), project_id uuid references projects(id),
 vehicle_id uuid, assignment_id uuid, start_date date, end_date date, note text
);
alter table public.vehicle_project_assignments enable row level security;
create policy "authenticated full access" on public.vehicle_project_assignments for all to authenticated
using (not public.is_partner_user()) with check (not public.is_partner_user());
