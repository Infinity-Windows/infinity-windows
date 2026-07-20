-- Offline write outbox (p1-11): server-side idempotency so a punch or photo
-- that gets retried from the offline queue can't create a duplicate row.
--
-- This migration is ADDITIVE and OPTIONAL. The app detects whether it has been
-- applied and falls back to best-effort client-side dedupe when it hasn't, so
-- the offline outbox works either way — applying this just upgrades duplicate
-- protection from "very unlikely" to "impossible".
--
-- What it adds:
--   1. A nullable client_id uuid column + partial unique index on time_shifts
--      and attachments (the two row-CREATING write paths behind the outbox).
--   2. A widened clock_in(...) overload that accepts p_client_id and returns
--      the existing shift instead of inserting a duplicate when that client id
--      has already been recorded.
--
-- Clock-out / break start / break stop are keyed by shift id and are naturally
-- idempotent (they UPDATE an existing row), so they need no new dedupe here.

-- 1) Idempotency keys ------------------------------------------------------

alter table time_shifts
  add column if not exists client_id uuid;

create unique index if not exists time_shifts_client_id_key
  on time_shifts (client_id)
  where client_id is not null;

alter table attachments
  add column if not exists client_id uuid;

create unique index if not exists attachments_client_id_key
  on attachments (client_id)
  where client_id is not null;

-- 2) clock_in overload with a stable client id ----------------------------
-- Overloads the existing clock_in by argument count. PostgREST resolves the
-- 6-arg version when the client sends p_client_id, and the original 5-arg
-- version otherwise — so old clients keep working unchanged.

create or replace function clock_in(
  p_project_id uuid,
  p_cost_code_id uuid,
  p_photo text,
  p_lat double precision,
  p_lng double precision,
  p_client_id uuid
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

  -- Close any dangling open shift for this user first (also powers job/phase
  -- switching: clocking in elsewhere submits the prior shift with no gap).
  update time_shifts set clock_out_at = now(), status = 'submitted'
  where profile_id = auth.uid() and status = 'open' and clock_out_at is null;

  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_photo, clock_in_lat, clock_in_lng, client_id)
  values
    (auth.uid(), p_project_id, p_cost_code_id, p_photo, p_lat, p_lng, p_client_id)
  returning * into v_shift;
  return v_shift;
end;
$$;
