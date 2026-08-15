-- Summon (owner, 2026-08-14): an installer mid-install calls for up to 8
-- helpers on a heavy window. Everyone on the job gets rung; answering
-- clocks the helper onto that window (their own timer row, like a phase)
-- and pays 10 bonus points instantly; "Complete" stamps their minutes.
-- The window's true cost becomes lead time + every helper's time.
--
-- House pattern: reads open to authenticated, writes only through
-- security-definer RPCs.

create table if not exists summons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  opening_id uuid not null references project_openings(id) on delete cascade,
  requested_by uuid not null references profiles(id),
  needed int not null check (needed between 1 and 8),
  status text not null default 'open' check (status in ('open', 'covered', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists summons_project_idx on summons (project_id, status);
create index if not exists summons_opening_idx on summons (opening_id);

create table if not exists summon_helpers (
  id uuid primary key default gen_random_uuid(),
  summon_id uuid not null references summons(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  completed_at timestamptz,
  minutes int check (minutes >= 0),
  unique (summon_id, profile_id)
);

alter table summons enable row level security;
alter table summon_helpers enable row level security;

drop policy if exists "summons_read" on summons;
create policy "summons_read" on summons
  for select to authenticated using (true);
drop policy if exists "summon_helpers_read" on summon_helpers;
create policy "summon_helpers_read" on summon_helpers
  for select to authenticated using (true);
-- No client write policies: the RPCs below are the only writers.

-- Ask for help. One live summon per opening; needs an open shift (you're
-- mid-install by definition).
create or replace function create_summon(p_opening_id uuid, p_needed int)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_row summons;
begin
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before summoning help';
  end if;
  if p_needed is null or p_needed < 1 or p_needed > 8 then
    raise exception 'ask for between 1 and 8 helpers';
  end if;
  select project_id into v_project from project_openings where id = p_opening_id;
  if v_project is null then
    raise exception 'opening not found';
  end if;
  if exists (
    select 1 from summons
    where opening_id = p_opening_id and status in ('open', 'covered')
  ) then
    raise exception 'a summon is already live on this window';
  end if;
  insert into summons (project_id, opening_id, requested_by, needed)
  values (v_project, p_opening_id, v_uid, p_needed)
  returning * into v_row;
  return v_row;
end;
$$;

-- Answer the call: you're clocked onto the window as a helper and the 10
-- bonus points land immediately (owner pick, 2026-08-14). Answers past
-- `needed` are refused so nobody walks over for nothing.
create or replace function answer_summon(p_summon_id uuid)
returns summon_helpers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
  v_row summon_helpers;
  v_count int;
begin
  if not exists (
    select 1 from time_shifts
    where profile_id = v_uid and status = 'open' and clock_out_at is null
  ) then
    raise exception 'clock in before answering a summon';
  end if;
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.status = 'closed' then
    raise exception 'this summon has ended';
  end if;
  if v_summon.requested_by = v_uid then
    raise exception 'you called this summon — no answering yourself';
  end if;
  select count(*) into v_count from summon_helpers where summon_id = p_summon_id;
  if v_count >= v_summon.needed then
    raise exception 'this summon is covered — thanks anyway';
  end if;

  insert into summon_helpers (summon_id, profile_id)
  values (p_summon_id, v_uid)
  returning * into v_row;

  if v_count + 1 >= v_summon.needed then
    update summons set status = 'covered' where id = p_summon_id;
  end if;

  -- The bonus, instantly (leaderboard + year-end): ref carries the summon
  -- so a void/audit can find it.
  insert into points_ledger (profile_id, kind, points, ref, status)
  values (v_uid, 'summon_answer', 10, p_summon_id::text, 'confirmed');

  return v_row;
end;
$$;

-- Done helping: stamp my minutes (believability-capped like every other
-- clock) and hand me back to my own list.
create or replace function complete_summon_help(p_summon_id uuid)
returns summon_helpers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row summon_helpers;
begin
  update summon_helpers
  set completed_at = now(),
      minutes = least(480, greatest(0, floor(extract(epoch from now() - joined_at) / 60))::int)
  where summon_id = p_summon_id and profile_id = v_uid and completed_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'no open help of yours on this summon';
  end if;
  return v_row;
end;
$$;

-- End the summon (requester or foreman+). Helpers who never tapped
-- Complete get their minutes stamped here — the record stays honest.
create or replace function close_summon(p_summon_id uuid)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
begin
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.requested_by <> v_uid and not _is_lead(v_uid) then
    raise exception 'only the caller or a foreman can end a summon';
  end if;
  update summon_helpers
  set completed_at = now(),
      minutes = least(480, greatest(0, floor(extract(epoch from now() - joined_at) / 60))::int)
  where summon_id = p_summon_id and completed_at is null;
  update summons
  set status = 'closed', closed_at = now()
  where id = p_summon_id
  returning * into v_summon;
  return v_summon;
end;
$$;

grant execute on function create_summon(uuid, int) to authenticated;
grant execute on function answer_summon(uuid) to authenticated;
grant execute on function complete_summon_help(uuid) to authenticated;
grant execute on function close_summon(uuid) to authenticated;

-- The in-app ring listens for new summons the moment they land.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'summons'
  ) then
    alter publication supabase_realtime add table summons;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'summon_helpers'
  ) then
    alter publication supabase_realtime add table summon_helpers;
  end if;
end;
$$;
