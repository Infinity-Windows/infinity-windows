-- A phase clock you can pause — and minutes that stay honest about it.
--
-- The flashing clock shipped start-and-submit only: once running it could not
-- stop for lunch, and "Go on break" double-counted the same minutes as break
-- AND flashing. This adds the same accounting the shift clock uses for breaks
-- (a running paused_at stamp plus an accumulated paused_seconds), three verbs
-- (pause, resume, cancel), and one automatic kindness: starting a shift break
-- pauses every phase clock you personally have running. Resume stays a
-- deliberate tap — the app never silently restarts a clock.

alter table opening_phases
  add column if not exists paused_at timestamptz,
  add column if not exists paused_seconds int not null default 0;

-- Pause: idempotent — pausing a paused phase changes nothing.
create or replace function pause_opening_phase(p_opening_id uuid, p_kind text)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v opening_phases;
begin
  update opening_phases
     set paused_at = coalesce(paused_at, now())
   where opening_id = p_opening_id and kind = p_kind and status = 'active'
   returning * into v;
  if v is null then raise exception 'no active % on this opening', p_kind; end if;
  return v;
end;
$$;

create or replace function resume_opening_phase(p_opening_id uuid, p_kind text)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v opening_phases;
begin
  update opening_phases
     set paused_seconds = paused_seconds
           + greatest(0, extract(epoch from (now() - paused_at))::int),
         paused_at = null
   where opening_id = p_opening_id and kind = p_kind
     and status = 'active' and paused_at is not null
   returning * into v;
  if v is null then
    -- Already running (or never paused) — return the row as it stands.
    select * into v from opening_phases
    where opening_id = p_opening_id and kind = p_kind and status = 'active';
    if v is null then raise exception 'no active % on this opening', p_kind; end if;
  end if;
  return v;
end;
$$;

-- Started on the wrong window: erase the clock, file nothing. Only an ACTIVE
-- phase can be cancelled — a submitted one is a record and stays.
create or replace function cancel_opening_phase(p_opening_id uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from opening_phases
  where opening_id = p_opening_id and kind = p_kind and status = 'active';
end;
$$;

revoke all on function pause_opening_phase(uuid, text) from public;
grant execute on function pause_opening_phase(uuid, text) to authenticated;
revoke all on function resume_opening_phase(uuid, text) from public;
grant execute on function resume_opening_phase(uuid, text) to authenticated;
revoke all on function cancel_opening_phase(uuid, text) from public;
grant execute on function cancel_opening_phase(uuid, text) to authenticated;

-- Submit: minutes are the span net of every pause — including one still open
-- at submit time (finishing while paused is fine; the pause just ends there).
-- Body otherwise identical to 20260811000000.
create or replace function submit_opening_phase(
  p_opening_id uuid,
  p_kind text,
  p_photo_path text
)
returns opening_phases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_phase opening_phases;
begin
  if p_photo_path is null or btrim(p_photo_path) = '' then
    raise exception 'a finished-work photo is required to submit %', p_kind;
  end if;

  update opening_phases
     set status = 'submitted',
         submitted_at = now(),
         submitted_by = v_uid,
         photo_path = p_photo_path,
         minutes = least(
           greatest(0,
             floor((
               extract(epoch from now() - started_at)
               - paused_seconds
               - coalesce(extract(epoch from now() - paused_at), 0)
             ) / 60)::int
           ),
           install_timer_cap_minutes()
         ),
         paused_at = null
   where opening_id = p_opening_id and kind = p_kind and status = 'active'
   returning * into v_phase;

  if v_phase is null then
    raise exception 'no active % to submit on this opening', p_kind;
  end if;
  return v_phase;
end;
$$;

revoke all on function submit_opening_phase(uuid, text, text) from public;
grant execute on function submit_opening_phase(uuid, text, text) to authenticated;

-- Going on a shift break pauses every phase clock YOU have running: break
-- minutes and phase minutes must never be the same minutes. Body otherwise
-- identical to 20260718040000. Resume after the break is a deliberate tap.
create or replace function start_break(
  p_shift_id uuid,
  p_break_type text default 'other'
)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts
  set break_started_at = coalesce(break_started_at, now()),
      break_type = coalesce(break_type, p_break_type)
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v;
  if v is null then raise exception 'no open shift %', p_shift_id; end if;

  update opening_phases
     set paused_at = coalesce(paused_at, now())
   where status = 'active' and started_by = auth.uid();

  return v;
end;
$$;
