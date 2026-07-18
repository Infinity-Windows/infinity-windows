-- Horizon-style clock: typed breaks (lunch/rest/other) + soft GPS at punches.
-- Adds columns to time_shifts and widens the clock_in / clock_out / start_break
-- RPCs. GPS is best-effort — the client passes null when a fix isn't available
-- and the punch still succeeds. The toolbox-talk gate from
-- 20260718003000_toolbox_talks.sql is preserved in clock_in.

alter table time_shifts
  add column if not exists break_type text
    check (break_type in ('lunch', 'rest', 'other')),
  add column if not exists clock_in_lat double precision,
  add column if not exists clock_in_lng double precision,
  add column if not exists clock_out_lat double precision,
  add column if not exists clock_out_lng double precision;

-- Drop the old signatures so the widened versions replace them cleanly
-- (adding params would otherwise create ambiguous overloads).
drop function if exists clock_in(uuid, uuid, text);
drop function if exists clock_out(uuid, text, boolean, boolean, int);
drop function if exists start_break(uuid);

-- Clock in — toolbox gate + optional GPS.
create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  -- Hard gate: today's toolbox talk must be signed before clocking in.
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  -- Close any dangling open shift for this user first (also powers job/phase
  -- switching: clocking in elsewhere submits the prior shift with no gap).
  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng)
  values (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- Clock out + sign-off — optional GPS.
create or replace function clock_out(
  p_shift_id uuid,
  p_photo text default null,
  p_injured boolean default false,
  p_time_confirmed boolean default true,
  p_break_seconds int default null,
  p_lat double precision default null,
  p_lng double precision default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  update time_shifts
  set clock_out_at = now(),
      clock_out_photo = coalesce(p_photo, clock_out_photo),
      injured = p_injured,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds, break_seconds),
      break_started_at = null,
      break_type = null,
      clock_out_lat = coalesce(p_lat, clock_out_lat),
      clock_out_lng = coalesce(p_lng, clock_out_lng),
      signed_at = now(),
      status = 'submitted'
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v_shift;
  if v_shift is null then raise exception 'no open shift %', p_shift_id; end if;
  return v_shift;
end;
$$;

-- Start a typed break (lunch / rest / other). Defaults to 'other'.
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
  return v;
end;
$$;

-- End the current break: accumulate elapsed seconds and clear the type.
create or replace function end_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null,
      break_type = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();
  end if;
  return v;
end;
$$;
