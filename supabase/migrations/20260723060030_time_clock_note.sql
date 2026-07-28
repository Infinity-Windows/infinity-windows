-- Clock-in notes (crew → office): an optional free-text note a worker can add
-- at clock-in to explain anything a cost code doesn't fully cover. Read-only
-- context for the office/leads when they review timecards.
--
-- This migration is ADDITIVE and OPTIONAL. The app detects whether it has been
-- applied and falls back to a plain note-less punch when it hasn't, so clock-in
-- keeps working either way — applying this just lets the note reach the office.
--
-- What it adds:
--   1. A nullable note text column on time_shifts (no default).
--   2. Two clock_in overloads that accept p_note and persist it — one for the
--      foreground online punch, one for the offline outbox (client_id + note).
--
-- Everything is idempotent and preserves the toolbox-talk gate + GPS behaviour
-- from the sibling time-clock migrations. Existing RLS is unchanged (the
-- "authenticated full access" policy on time_shifts already covers the column).

-- 1) Worker note column ----------------------------------------------------

alter table time_shifts
  add column if not exists note text;

-- 2) clock_in overload with a worker note (foreground online path) ---------
-- Distinct 6th arg type (text) from the client_id (uuid) overload, so PostgREST
-- resolves this one when the client sends p_note and the idempotency one when
-- it sends p_client_id. Old note-less clients keep hitting the 5-arg version.

create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_note text
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
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng, note)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     nullif(btrim(p_note), ''))
  returning * into v_shift;
  return v_shift;
end;
$$;

-- 3) clock_in overload with idempotency key + note (offline outbox path) ---
-- Mirrors the p_client_id overload from 20260720000000 but also carries the
-- worker note, so a punch queued offline keeps its note when it finally syncs.

create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_client_id uuid,
  p_note text
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  -- Idempotent replay: if this client id already punched in, return that shift.
  if p_client_id is not null then
    select * into v_shift from time_shifts
      where client_id = p_client_id and profile_id = auth.uid();
    if v_shift.id is not null then
      return v_shift;
    end if;
  end if;

  -- Hard gate: today's toolbox talk must be signed before clocking in.
  if not exists (
    select 1 from toolbox_completions
    where profile_id = auth.uid() and signed_at::date = current_date
  ) then
    raise exception 'complete today''s toolbox talk before clocking in';
  end if;

  -- Close any dangling open shift for this user first.
  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng,
     client_id, note)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng,
     p_client_id, nullif(btrim(p_note), ''))
  returning * into v_shift;
  return v_shift;
end;
$$;
