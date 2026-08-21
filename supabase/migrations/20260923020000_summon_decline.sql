-- Summon decline (owner decision, 2026-08-21): summons stay penalty-free —
-- nobody is dinged for being unable to come — but a helper who can't make it
-- should be able to say so with one tap, so the caller sees who's out
-- instead of wondering why the room's gone quiet.
--
-- answer_summon is rebuilt from its CURRENT definition
-- (20260919000000_summon_cancel.sql) — the movements_event_ck lesson, full
-- body not a diff — plus one new line: answering retracts an earlier
-- decline, since "can't come" and "on the way" can't both be true. Same
-- signature, so no drop is needed.

create table if not exists summon_declines (
  summon_id uuid not null references summons(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (summon_id, profile_id)
);

alter table summon_declines enable row level security;

drop policy if exists "summon_declines_read" on summon_declines;
create policy "summon_declines_read" on summon_declines
  for select to authenticated using (true);
-- No client write policy: decline_summon (below) is the only writer.

-- Say you can't come. No points move and no seat changes — a decline is
-- information, not a penalty — so it's plain SQL with no ledger, no status
-- flip. Idempotent: tapping twice (or a retried request) is a no-op, not an
-- error.
create or replace function decline_summon(p_summon_id uuid)
returns summon_declines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
  v_row summon_declines;
begin
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.status not in ('open', 'covered') then
    raise exception 'this summon has ended';
  end if;

  insert into summon_declines (summon_id, profile_id)
  values (p_summon_id, v_uid)
  on conflict (summon_id, profile_id) do nothing;

  select * into v_row from summon_declines
  where summon_id = p_summon_id and profile_id = v_uid;

  return v_row;
end;
$$;

-- Full current body from 20260919000000_summon_cancel.sql, plus the decline
-- delete just before the return.
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
  select count(*) into v_count
  from summon_helpers
  where summon_id = p_summon_id and canceled_at is null;
  if v_count >= v_summon.needed then
    raise exception 'this summon is covered — thanks anyway';
  end if;

  -- Re-answer after a cancel revives the old row; first answer inserts.
  update summon_helpers
  set canceled_at = null, joined_at = now(), completed_at = null, minutes = null
  where summon_id = p_summon_id and profile_id = v_uid and canceled_at is not null
  returning * into v_row;
  if v_row.id is null then
    insert into summon_helpers (summon_id, profile_id)
    values (p_summon_id, v_uid)
    returning * into v_row;
  end if;

  if v_count + 1 >= v_summon.needed then
    update summons set status = 'covered' where id = p_summon_id;
  end if;

  insert into points_ledger (profile_id, kind, points, ref, status)
  values (v_uid, 'summon_answer', 10, p_summon_id::text, 'confirmed');

  -- You answered — any earlier "can't help" no longer applies.
  delete from summon_declines where summon_id = p_summon_id and profile_id = v_uid;

  return v_row;
end;
$$;

grant execute on function decline_summon(uuid) to authenticated;

-- The in-app ring listens for declines the moment they land, same as
-- answers and cancels.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'summon_declines'
  ) then
    alter publication supabase_realtime add table summon_declines;
  end if;
end;
$$;
