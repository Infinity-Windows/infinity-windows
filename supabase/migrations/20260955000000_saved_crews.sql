-- Wave A, A1: saved crews — named teams a supervisor builds because they work
-- together. Owner decision (spec a1-ai-scheduler-spec.md, grilled 2026-08-27,
-- "SAVED CREWS (owner's addition)"): NAMED TEAMS (2-6 people) built by
-- supervisor+ on the Roster. The AI's scheduling tools (wave A2) keep a saved
-- crew together to the best of their ability and must say when they split
-- one — a SOFT law enforced in the tool's system prompt, not in this table.
--
-- RPC-only writes, same house rule as file_daily_log/set_capability_badge:
-- zero insert/update/delete policies below, so save_crew/delete_crew are the
-- only path in and every write is validated (member count, active profiles,
-- supervisor+) in one place.

create table if not exists saved_crews (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  member_ids uuid[] not null check (array_length(member_ids, 1) between 2 and 6),
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_crews_member_ids_idx
  on saved_crews using gin (member_ids);

alter table saved_crews enable row level security;

-- Foreman+ read (crew visibility norm — the same floor daily_logs and the
-- crew/job schedule use): a saved crew is company knowledge a foreman
-- coordinating a job benefits from seeing, even though only supervisor+ may
-- build one.
drop policy if exists "saved_crews_select_foreman_plus" on saved_crews;
create policy "saved_crews_select_foreman_plus" on saved_crews
  for select to authenticated
  using (public.my_role_rank() >= 1);
-- No insert/update/delete policy — save_crew/delete_crew are the only writers.

-- Create (p_id null) or rename/reshuffle (p_id set) a saved crew in one call.
-- Supervisor+ only; member_ids must be 2-6 profiles that actually exist and
-- are active — a saved crew of somebody who no longer works here is a trap
-- the scheduling AI would otherwise walk a supervisor into.
create or replace function save_crew(
  p_id uuid default null,
  p_name text default null,
  p_members uuid[] default null,
  p_note text default null
)
returns saved_crews
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_active_count int;
  v_row saved_crews;
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or above can manage saved crews';
  end if;
  if v_name = '' or char_length(v_name) > 40 then
    raise exception 'a saved crew needs a name, 1-40 characters';
  end if;
  if p_members is null or array_length(p_members, 1) is null
     or array_length(p_members, 1) < 2 or array_length(p_members, 1) > 6 then
    raise exception 'a saved crew needs 2-6 members';
  end if;

  select count(*) into v_active_count
  from profiles
  where id = any(p_members) and active;
  if v_active_count <> array_length(p_members, 1) then
    raise exception 'every member of a saved crew must be an active profile';
  end if;

  if p_id is null then
    insert into saved_crews (name, member_ids, note, created_by)
    values (v_name, p_members, nullif(btrim(coalesce(p_note, '')), ''), v_uid)
    returning * into v_row;
  else
    update saved_crews
    set name = v_name,
        member_ids = p_members,
        note = nullif(btrim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = p_id
    returning * into v_row;
    if v_row.id is null then
      raise exception 'saved crew % not found', p_id;
    end if;
  end if;

  return v_row;
end;
$$;

comment on function save_crew(uuid, text, uuid[], text) is
  'Create (p_id null) or update a saved crew. Supervisor+ only; validates name length, member count (2-6), and that every member is an active profile.';

create or replace function delete_crew(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.my_role_rank() < 2 then
    raise exception 'only a supervisor or above can manage saved crews';
  end if;
  delete from saved_crews where id = p_id;
end;
$$;

comment on function delete_crew(uuid) is
  'Delete a saved crew. Supervisor+ only.';

revoke all on function save_crew(uuid, text, uuid[], text) from public, anon;
revoke all on function delete_crew(uuid) from public, anon;
grant execute on function save_crew(uuid, text, uuid[], text) to authenticated;
grant execute on function delete_crew(uuid) to authenticated;
