-- Crew dispatch (1B real logins + 2B foreman push).
-- Per-installer identity + skill, and lead-assigned openings so each installer
-- gets an ordered "my work" list and six people never collide.

-- Crew profiles, keyed to auth.users. Trusted-crew RLS like the rest of the app.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  skill_level int not null default 2 check (skill_level between 1 and 5),
  role text not null default 'installer' check (role in ('installer','lead')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'authenticated full access') then
    create policy "authenticated full access" on profiles
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

-- Foreman-push assignment on openings. Person-workflow state is derived:
--   status='installed' => done; work_started_at set => in-progress;
--   assigned_to set => assigned; else unassigned.
alter table project_openings
  add column if not exists assigned_to uuid references profiles(id) on delete set null,
  add column if not exists assigned_by uuid references profiles(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists sequence int,
  add column if not exists work_started_at timestamptz;

create index if not exists project_openings_assigned_idx
  on project_openings (assigned_to, sequence);

-- Assign (or reassign) an opening to an installer.
create or replace function assign_opening_to_installer(
  p_opening_id uuid,
  p_profile_id uuid,
  p_actor_id uuid default null,
  p_sequence int default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set assigned_to = p_profile_id,
      assigned_by = p_actor_id,
      assigned_at = now(),
      sequence = coalesce(p_sequence, sequence)
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

create or replace function unassign_opening(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set assigned_to = null, assigned_by = null, assigned_at = null
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Installer taps "Next" — marks the opening in-progress (soft lock / visibility).
create or replace function start_opening_work(p_opening_id uuid)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
begin
  update project_openings
  set work_started_at = coalesce(work_started_at, now())
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Bulk set the walk order for a person's list.
create or replace function set_openings_sequence(p_opening_ids uuid[])
returns void
language plpgsql
as $$
begin
  update project_openings o
  set sequence = arr.ord
  from (
    select id, (idx - 1) as ord
    from unnest(p_opening_ids) with ordinality as t(id, idx)
  ) arr
  where o.id = arr.id;
end;
$$;
