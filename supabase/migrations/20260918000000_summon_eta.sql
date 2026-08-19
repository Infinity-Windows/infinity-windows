-- Summon ETA + 5-minute warning (owner ask, 2026-08-19).
--
-- The caller can now say WHEN the hands are needed ("in 30 minutes"), every
-- viewer sees the countdown, and each answerer gets a push 5 minutes before
-- the time. The warning cannot come from a phone (a closed app can't remind
-- itself), so a once-a-minute pg_cron job pokes a parameterless, idempotent
-- edge function (summon-warning-sweep) that finds what's due and sends the
-- pushes itself. The poke carries no secrets and takes no input — the worst
-- an unauthenticated call can do is trigger a sweep that sends only what is
-- genuinely due, once (warned_at is the idempotency mark).

-- Where the hands are needed by. Null = "now", the pre-ETA behavior.
alter table summons add column if not exists needed_at timestamptz;

-- One warning per helper, ever — the sweep's idempotency mark.
alter table summon_helpers add column if not exists warned_at timestamptz;

-- create_summon grows a lead-minutes arg. Old 2-arg signature is DROPPED in
-- the same migration (the bind_package overload lesson, 2026-08-17): the new
-- arg has a default, so stale bundles calling with 2 args still resolve —
-- to THIS function, not an ambiguous overload.
drop function if exists create_summon(uuid, int);

create or replace function create_summon(
  p_opening_id uuid,
  p_needed int,
  p_lead_minutes int default null
)
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
  -- 5 minutes to 8 hours; anything else is a typo, not a plan.
  if p_lead_minutes is not null and (p_lead_minutes < 5 or p_lead_minutes > 480) then
    raise exception 'lead time must be between 5 minutes and 8 hours';
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
  insert into summons (project_id, opening_id, requested_by, needed, needed_at)
  values (
    v_project, p_opening_id, v_uid, p_needed,
    case when p_lead_minutes is null then null
         else now() + make_interval(mins => p_lead_minutes) end
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- The minute hand. pg_cron + pg_net are Supabase built-ins; the job name is
-- stable so re-running this migration replaces rather than duplicates.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  perform cron.unschedule('summon-warning-sweep');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

-- The project ref is this repo's one production project (the frontend pins
-- the same ref at build time). verify_jwt=false on the target function, so
-- no auth header rides along — see the function's own header comment for
-- why that is safe.
select cron.schedule(
  'summon-warning-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/summon-warning-sweep',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
