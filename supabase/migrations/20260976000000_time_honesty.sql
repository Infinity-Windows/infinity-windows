-- Wave K — Time honesty (transcripts program, grill of 2026-09-03).
--
-- Three honest things about time, in one migration because they are one
-- feature: the app knows where you were last seen, it asks once in the evening
-- whether you are really still on the job, and a worker can finally read the
-- record of who changed their own punches.
--
-- THE LOCATION LAW, written here because the database is the only place it
-- cannot be quietly dropped: this app has NO background location and must never
-- grow one. `touch_shift_location` is written ONLY when the app is brought to
-- the foreground, ONLY while the caller is genuinely on the clock, and only
-- from a fix the phone had already granted permission for. It records ONE point
-- per foreground visit, overwriting the last — there is no track, no history,
-- and nothing to reconstruct a day's movements from. A crew member's phone is
-- not a tracker; it is a timecard that can say "I was 14 miles away when I
-- opened the app".
--
-- Timezone: 'America/Denver' spelled out, the same company-local day
-- 20260813000000_toolbox_gate_timezone.sql settled for every clock gate. There
-- is no helper function to reuse — the convention IS the literal — so this file
-- follows it rather than inventing a second source of truth.
--
-- Idempotent throughout (create ... if not exists / create or replace /
-- on conflict do nothing), so re-running it changes nothing.

-- ---------------------------------------------------------------------------
-- 1. K3 — where a shift was last seen, and whether tonight's nudge already went
-- ---------------------------------------------------------------------------
-- On time_shifts rather than a table of its own for two reasons: the answer is
-- about ONE shift ("last seen while on this punch"), and a per-shift column
-- makes the evening claim below a single atomic UPDATE ... RETURNING, the way
-- summon_helpers.warned_at makes the 5-minute warning sweep atomic.
alter table time_shifts add column if not exists last_seen_at timestamptz;
alter table time_shifts add column if not exists last_seen_lat double precision;
alter table time_shifts add column if not exists last_seen_lng double precision;

-- The company-local DAY the evening nudge last went out for this shift — a
-- date, not a timestamp, on purpose. A shift nobody closed for three days
-- should be asked about again each evening (that is precisely the shift worth
-- asking about), and a date is what makes "once per person per day" the claim
-- key rather than "once ever".
alter table time_shifts add column if not exists evening_nudged_on date;

comment on column time_shifts.last_seen_at is
  'When the app was last brought to the foreground while this shift was open. Foreground only — there is no background location in this app and there must not be (Wave K, K3).';
comment on column time_shifts.last_seen_lng is
  'Longitude of the last foreground fix on this shift. One point, overwritten each time — never a track.';

-- ---------------------------------------------------------------------------
-- 2. K3 — touch_shift_location: the one door, and it only opens on yourself
-- ---------------------------------------------------------------------------
-- SELF-ONLY by construction: the WHERE clause pins profile_id to auth.uid(),
-- so there is no argument a caller could pass to stamp somebody else's shift.
-- SECURITY DEFINER because time_shifts' table policy is a broad
-- "authenticated full access" today; when that wall tightens, this narrow door
-- keeps working without a second migration.
--
-- A caller who is not on the clock gets `null` and no error. That is deliberate:
-- this runs on every app open, and an app that threw an error at somebody for
-- the crime of opening it off the clock would teach the crew to distrust it.
create or replace function public.touch_shift_location(
  p_lat double precision default null,
  p_lng double precision default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Sign in before the app can save where you are.';
  end if;

  update time_shifts
     set last_seen_at = now(),
         -- A fix we do not have must not erase the one we do: a foreground
         -- visit with location switched off still updates the TIME (they had
         -- the app open) and leaves the last known point alone.
         last_seen_lat = coalesce(p_lat, last_seen_lat),
         last_seen_lng = coalesce(p_lng, last_seen_lng)
   where profile_id = v_uid
     and status = 'open'
     and clock_out_at is null
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.touch_shift_location(double precision, double precision) is
  'Self-only: stamps the caller''s own OPEN shift with the moment the app came to the foreground and, when the phone already had permission, where it was. Returns the shift id, or null when the caller is not on the clock (never an error — this runs on every app open). Foreground only; this app has no background location (Wave K, K3).';

revoke all on function public.touch_shift_location(double precision, double precision) from public, anon;
grant execute on function public.touch_shift_location(double precision, double precision) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. K2 — the one company setting behind the evening nudge
-- ---------------------------------------------------------------------------
-- A single-row settings table, the same shape as ai_spend_limits (20260729230000):
-- id fixed at 1 by a CHECK, seeded on creation, changed through an RPC rather
-- than a table grant. There was no general company settings row in this schema
-- to hang this on — ai_spend_limits is about the AI budget and nothing else —
-- so this is the first, and the place the next such setting belongs.
create table if not exists company_settings (
  id integer primary key default 1 check (id = 1),

  -- The company's local time of day the "Still on the job?" nudge goes out.
  -- 17:30 by default: late enough that a normal day is over, early enough that
  -- a forgotten clock-out is fixed the same evening rather than at payroll.
  evening_nudge_local_time time not null default '17:30',

  -- The off switch. A company that decides the nudge is noise turns it off
  -- here rather than having someone unschedule a cron job.
  evening_nudge_enabled boolean not null default true,

  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into company_settings (id) values (1) on conflict (id) do nothing;

alter table company_settings enable row level security;

-- Readable by any signed-in crew member (the clock sheet may one day want to
-- say when the nudge goes out), never by a partner login — the mechanical
-- wall guard every crew table carries since 20260950000000. No insert/update/
-- delete policy at all: set_evening_nudge_time below is the only writer.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'company_settings' and policyname = 'crew read'
  ) then
    create policy "crew read" on company_settings
      for select to authenticated
      using (not public.is_partner_user() and (true));
  end if;
end;
$$;

create or replace function public.set_evening_nudge_time(
  p_local_time text,
  p_enabled boolean default null
)
returns company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row company_settings;
  v_time time;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can change when the evening reminder goes out.';
  end if;

  begin
    v_time := p_local_time::time;
  exception when others then
    raise exception 'That is not a time of day. Use something like 17:30.';
  end;

  update company_settings
     set evening_nudge_local_time = v_time,
         evening_nudge_enabled = coalesce(p_enabled, evening_nudge_enabled),
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_evening_nudge_time(text, boolean) is
  'Foreman+: set the company-local time of day the "Still on the job?" nudge goes out (and optionally switch it off). Rejects anything that is not a time of day with a plain sentence.';

revoke all on function public.set_evening_nudge_time(text, boolean) from public, anon;
grant execute on function public.set_evening_nudge_time(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. K2 — claiming tonight's nudges, atomically
-- ---------------------------------------------------------------------------
-- The decision and the claim are ONE statement, for the reason ai_spend_limits
-- gives about its own counter: a read-then-write ("who is still on, then mark
-- them") loses exactly when it matters, because two overlapping sweeps both
-- read the same unmarked rows and both push. `update ... where
-- evening_nudged_on is distinct from <today> ... returning` takes the row lock,
-- so the second sweep genuinely sees the first one's work and returns nobody.
--
-- Who is claimed: an OPEN shift, on a cost code that is not Travel (900),
-- clocked in BEFORE tonight's nudge moment. That last clause is what stops a
-- 6 PM clock-in being asked "still on the job?" at 6:05 — the question only
-- makes sense for someone who was already on the clock when the hour came.
--
-- Service context only. auth.uid() is null under the service-role key the edge
-- function uses and under pg_cron, and a crew member has no business firing the
-- company's evening push by hand.
create or replace function public.claim_still_on_the_job_nudges()
returns table (shift_id uuid, profile_id uuid, project_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz constant text := 'America/Denver';
  v_settings company_settings;
  v_now_local timestamp;
  v_nudge_local timestamp;
  v_nudge_moment timestamptz;
  v_local_day date;
begin
  if auth.uid() is not null then
    raise exception 'The evening reminder sends itself — nobody needs to press anything.';
  end if;

  select * into v_settings from company_settings where id = 1;
  if not found or not v_settings.evening_nudge_enabled then
    return;
  end if;

  v_now_local := (now() at time zone v_tz);
  v_local_day := v_now_local::date;
  v_nudge_local := date_trunc('day', v_now_local) + v_settings.evening_nudge_local_time;
  -- Before the hour: nothing is due. The sweep runs every few minutes and
  -- says nothing all day, which is the point.
  if v_now_local < v_nudge_local then
    return;
  end if;
  v_nudge_moment := (v_nudge_local at time zone v_tz);

  return query
  update time_shifts ts
     set evening_nudged_on = v_local_day
    from cost_codes cc
   where ts.cost_code_id = cc.id
     and ts.status = 'open'
     and ts.clock_out_at is null
     and cc.code <> '900'
     and ts.clock_in_at < v_nudge_moment
     and ts.evening_nudged_on is distinct from v_local_day
  returning ts.id, ts.profile_id, ts.project_id;
end;
$$;

comment on function public.claim_still_on_the_job_nudges() is
  'Service-role only (the still-on-the-job-sweep edge function): claims and returns everyone with an open shift on a job cost code — never Travel 900 — once the company-local nudge hour has passed, at most once per person per local day. The claim and the decision are one UPDATE ... RETURNING so two overlapping sweeps cannot both push.';

revoke all on function public.claim_still_on_the_job_nudges() from public, anon, authenticated;
grant execute on function public.claim_still_on_the_job_nudges() to service_role;

-- ---------------------------------------------------------------------------
-- 5. K2 — the sweep itself
-- ---------------------------------------------------------------------------
-- Every few minutes rather than once at 17:30: the hour is a company setting a
-- foreman can move, and a cron line cannot follow a setting. The claim above is
-- what makes a frequent poke free — before the hour it returns nobody, and
-- after it, only the first sweep of the evening claims anyone.
--
-- Wrapped in exception handlers the way 20260963000000_summon_expiry.sql wraps
-- its own: a database without pg_cron (a local `supabase start`, a fork for a
-- test) still applies this migration. The nudge is a courtesy, not a rule —
-- nothing about time depends on it — so a missing scheduler earns a warning in
-- the log, never a failed migration.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise warning 'still-on-the-job-sweep: pg_cron is not available here (%) — the evening reminder will not run. Nothing else about the clock changes.', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise warning 'still-on-the-job-sweep: pg_net is not available here (%) — the evening reminder will not run. Nothing else about the clock changes.', sqlerrm;
end;
$$;

do $$
begin
  perform cron.unschedule('still-on-the-job-sweep');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

-- The project ref is this repo's one production project, pinned the same way
-- 20260918000000 pins it for the summon sweep. verify_jwt = false on the target
-- function, so no auth header rides along — see the function's own header for
-- why that is safe.
do $$
begin
  perform cron.schedule(
    'still-on-the-job-sweep',
    '*/5 * * * *',
    $c$
    select net.http_post(
      url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/still-on-the-job-sweep',
      body := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
    $c$
  );
exception when others then
  raise warning 'still-on-the-job-sweep: could not schedule the sweep (%) — the evening reminder will not run. Nothing else about the clock changes.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. K4 — a worker can read the edits made to their OWN punches
-- ---------------------------------------------------------------------------
-- time_shift_edits has been supervisor-read-only since 20260810000000, which
-- means the one person whose hours were changed was the one person who could
-- not see what changed. That is backwards: the audit log exists so a change to
-- somebody's pay is visible to them, not only to the people above them.
--
-- Read-only, and only for rows about their own shifts. There is still no
-- insert/update/delete policy on this table at all — lead_edit_shift, running
-- security definer, remains the single writer, and nothing rewrites history.
drop policy if exists "own shift read" on time_shift_edits;
create policy "own shift read" on time_shift_edits
  for select to authenticated
  using (
    not public.is_partner_user()
    and exists (
      select 1 from time_shifts ts
       where ts.id = time_shift_edits.shift_id
         and ts.profile_id = auth.uid()
    )
  );
