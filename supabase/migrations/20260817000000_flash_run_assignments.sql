-- Flash run becomes its own dispatched task (owner, 2026-08-14): foremen
-- assign 1..N installers to a job's flash run from the Dispatch tab; the
-- run shows up in each runner's My Work. Flashing TIME stays exactly where
-- it lives today (opening_phases.minutes, one clock per opening) — this
-- table only says WHO is running the flash ahead of the crew.
--
-- House pattern: reads open to authenticated, writes only through
-- security-definer RPCs (deliberately NOT the old warehouse wide-open RLS).

create table if not exists flash_run_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  assigned_by uuid references profiles(id),
  assigned_at timestamptz not null default now(),
  unique (project_id, profile_id)
);

alter table flash_run_assignments enable row level security;

drop policy if exists "flash_run_assignments_read" on flash_run_assignments;
create policy "flash_run_assignments_read" on flash_run_assignments
  for select to authenticated using (true);
-- No insert/update/delete policies: RPCs below are the only writers.

-- Foreman+ puts a runner on (or takes one off) a job's flash run.
create or replace function assign_flash_runner(p_project_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can assign the flash run';
  end if;
  insert into flash_run_assignments (project_id, profile_id, assigned_by)
  values (p_project_id, p_profile_id, auth.uid())
  on conflict (project_id, profile_id) do nothing;
end;
$$;

create or replace function unassign_flash_runner(p_project_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can change the flash run';
  end if;
  delete from flash_run_assignments
  where project_id = p_project_id and profile_id = p_profile_id;
end;
$$;

grant execute on function assign_flash_runner(uuid, uuid) to authenticated;
grant execute on function unassign_flash_runner(uuid, uuid) to authenticated;

-- Runners see their runs across jobs (My Work card), foremen see a job's
-- runners (Dispatch card) — both are plain reads on the table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'flash_run_assignments'
  ) then
    alter publication supabase_realtime add table flash_run_assignments;
  end if;
end;
$$;
