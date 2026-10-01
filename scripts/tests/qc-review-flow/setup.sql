-- Synthetic permissions/schema substrate; real authority, visibility and QC migrations load afterward.

  create role authenticated; create role anon; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to authenticated, anon, service_role;
  create table profiles(id uuid primary key, role text not null, retired_at timestamptz,
    access_revoked_at timestamptz, is_partner boolean default false, is_test boolean default false,
    active boolean default true);
  create table projects(id uuid primary key, job_code text, name text, is_test boolean default false,
    deleted_at timestamptz, allowed_modes text[] not null default '{data}');
  create table window_types(id uuid primary key, type_code text);
  create table project_openings(id uuid primary key, project_id uuid not null references projects,
    opening_code text, label text, status text not null, removed_at timestamptz,
    work_ended_at timestamptz, assigned_window_id uuid, window_type_id uuid references window_types);
  create table qc_checks(id uuid primary key default gen_random_uuid(),
    project_opening_id uuid unique not null references project_openings on delete cascade,
    status text not null check(status in ('pending','passed','callback')), note text,
    checked_by uuid references profiles on delete set null, checked_at timestamptz,
    created_at timestamptz default now());
  create table points_ledger(id uuid primary key default gen_random_uuid(), ref text not null,
    status text not null, void_reason text);
  create table sandbox_projects(project_id uuid primary key);
  create function is_partner_user() returns boolean language sql stable security definer set search_path=public as $$
    select coalesce((select is_partner from profiles where id=auth.uid()),false) $$;
  create function my_role_rank() returns int language sql stable security definer set search_path=public as $$
    select case role when 'installer' then 0 when 'foreman' then 1 when 'lead' then 1
      when 'supervisor' then 2 when 'admin' then 2 when 'owner' then 3 when 'big_boss' then 3 else -1 end
      from profiles where id=auth.uid() $$;
  create function _is_supervisor(p_uid uuid) returns boolean language sql stable security definer set search_path=public as $$
    select coalesce((select role in ('supervisor','admin','owner','big_boss') from profiles where id=p_uid),false) $$;
  create function is_test_profile(p_uid uuid) returns boolean language sql stable security definer set search_path=public as $$
    select coalesce((select is_test from profiles where id=p_uid),false) $$;
  create function is_sandbox_project(p_job uuid) returns boolean language sql stable security definer set search_path=public as $$
    select exists(select 1 from sandbox_projects where project_id=p_job) $$;
  create function guard_test_account_sandbox_only() returns trigger language plpgsql security definer set search_path=public as $$
  declare j uuid;
  begin
    if is_test_profile(auth.uid()) then
      select project_id into j from project_openings where id=coalesce(new.project_opening_id,old.project_opening_id);
      if not is_sandbox_project(j) then raise exception 'Test account cannot write a real job.' using errcode='42501'; end if;
    end if; return coalesce(new,old);
  end $$;
  create function attach_sandbox_guards() returns table(table_name text,link_column text,link_kind text,action text)
    language sql as $$ select null::text,null::text,null::text,null::text where false $$;
  alter table qc_checks enable row level security;
  create policy "authenticated full access" on qc_checks for all to authenticated
    using(not is_partner_user()) with check(not is_partner_user());
  grant select,insert,update,delete on qc_checks to authenticated;
  grant select on project_openings to authenticated;
  create trigger guard_test_account_sandbox_only before insert or update or delete on qc_checks
    for each row execute function guard_test_account_sandbox_only('project_opening_id','opening');

