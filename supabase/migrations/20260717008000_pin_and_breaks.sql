-- Quality: PIN checked server-side (never read to the client), and break
-- state persisted server-side so a page refresh doesn't lose it.

-- Whether the current user has a PIN set (no value leaves the server).
create or replace function my_pin_status()
returns boolean
language plpgsql
security definer
as $$
declare v boolean;
begin
  select pin is not null into v from profiles where id = auth.uid();
  return coalesce(v, false);
end;
$$;

-- Verify a PIN attempt for the current user, server-side.
create or replace function check_my_pin(p_pin text)
returns boolean
language plpgsql
security definer
as $$
declare v text;
begin
  select pin into v from profiles where id = auth.uid();
  return v is not null and v = p_pin;
end;
$$;

-- Persisted break state on shifts.
alter table time_shifts
  add column if not exists break_started_at timestamptz;

create or replace function start_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts set break_started_at = coalesce(break_started_at, now())
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v;
  if v is null then raise exception 'no open shift %', p_shift_id; end if;
  return v;
end;
$$;

create or replace function end_break(p_shift_id uuid)
returns time_shifts language plpgsql as $$
declare v time_shifts;
begin
  update time_shifts
  set break_seconds = break_seconds
        + greatest(0, extract(epoch from (now() - break_started_at))::int),
      break_started_at = null
  where id = p_shift_id and profile_id = auth.uid() and break_started_at is not null
  returning * into v;
  if v is null then
    select * into v from time_shifts where id = p_shift_id and profile_id = auth.uid();
  end if;
  return v;
end;
$$;
