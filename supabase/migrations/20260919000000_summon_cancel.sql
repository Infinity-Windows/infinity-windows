-- Summon cancel + re-answer (owner asks, 2026-08-19 evening):
--
--   1. A helper who answered can back out ("Can't make it") — the caller
--      sees it, the seat reopens, the 10 answer points come back off, and
--      their helper clock stops.
--   2. Backing out is not forever: answering again REVIVES the canceled row
--      (the unique (summon_id, profile_id) key means insert would refuse).
--   3. Cover math counts only ACTIVE helpers, so a cancel on a covered
--      summon reopens it for someone else.
--
-- Functions are rebuilt from their CURRENT definitions (the movements_event_ck
-- lesson) — answer_summon and the session trigger below carry their whole
-- bodies, not a diff.

alter table summon_helpers add column if not exists canceled_at timestamptz;

-- Answer: count only active helpers; a canceled row revives instead of
-- violating the unique key. Everything else is the 2026-08-18 behavior.
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

  return v_row;
end;
$$;

-- Back out of a summon you answered. Your seat reopens, the answer points
-- reverse, your helper clock stops (trigger below). Plain guards, plain
-- words.
create or replace function cancel_summon_help(p_summon_id uuid)
returns summon_helpers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_summon summons;
  v_row summon_helpers;
begin
  select * into v_summon from summons where id = p_summon_id for update;
  if v_summon.id is null then
    raise exception 'summon not found';
  end if;
  if v_summon.status = 'closed' then
    raise exception 'this summon already ended';
  end if;

  update summon_helpers
  set canceled_at = now(), minutes = 0
  where summon_id = p_summon_id and profile_id = v_uid
    and completed_at is null and canceled_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'no open help of yours on this summon';
  end if;

  -- The 10 answer points come back off — a matching negative entry, so the
  -- ledger reads as the story actually went.
  insert into points_ledger (profile_id, kind, points, ref, status)
  values (v_uid, 'summon_answer_canceled', -10, p_summon_id::text, 'confirmed');

  -- A covered summon with a freed seat is open again.
  if v_summon.status = 'covered' then
    update summons set status = 'open' where id = p_summon_id;
  end if;

  return v_row;
end;
$$;

-- The helper-session trigger gains the cancel branch: backing out ends the
-- helper clock the same way completing does, reason 'handoff' (you go back
-- to your own list). Full current body, not a diff.
create or replace function unit_sessions_follow_summon_helpers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening uuid;
begin
  if tg_op = 'INSERT' then
    select opening_id into v_opening from summons where id = new.summon_id;
    if v_opening is not null then
      perform _close_stale_sessions(new.profile_id);
      perform _end_open_session(new.profile_id, 'handoff');
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_opening, new.profile_id, 'helper', _has_open_redo(v_opening));
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.completed_at is not null and old.completed_at is null then
    update unit_sessions
    set ended_at = now(), end_reason = 'complete'
    where profile_id = new.profile_id and ended_at is null and role = 'helper';
  end if;
  if tg_op = 'UPDATE' and new.canceled_at is not null and old.canceled_at is null then
    update unit_sessions
    set ended_at = now(), end_reason = 'handoff'
    where profile_id = new.profile_id and ended_at is null and role = 'helper';
  end if;
  -- A revived answer (canceled_at cleared) opens a fresh helper session.
  if tg_op = 'UPDATE' and new.canceled_at is null and old.canceled_at is not null then
    select opening_id into v_opening from summons where id = new.summon_id;
    if v_opening is not null then
      perform _close_stale_sessions(new.profile_id);
      perform _end_open_session(new.profile_id, 'handoff');
      insert into unit_sessions (opening_id, profile_id, role, is_rework)
      values (v_opening, new.profile_id, 'helper', _has_open_redo(v_opening));
    end if;
    return new;
  end if;
  return new;
end;
$$;
