-- Wave J — Job pipeline (transcripts program, grill of 2026-09-03, Q8 + Q9).
--
-- A job used to be either "active" or not, and everything between winning the
-- bid and the first window going in lived in somebody's head. This migration
-- gives that stretch four facts and one voice:
--
--   * ready_state          — is this job ready for us to work, or not yet?
--   * materials_eta        — when the windows are supposed to land
--   * materials_arrived_at — when they actually did
--   * sort_order           — the order the office wants the jobs read in
--
-- and a 7 AM sweep that says, out loud and before it is too late, "Sand Hollow
-- starts in 7 days — still Not ready · windows not in".
--
-- Timezone: 'America/Denver' spelled out, the same company-local day
-- 20260813000000_toolbox_gate_timezone.sql settled for every clock gate and
-- 20260976000000 (wave K) followed for the evening nudge. There is no shared
-- timezone helper in this schema — the convention IS the literal — so this file
-- follows it rather than inventing a second source of truth.
--
-- Idempotent throughout (add column if not exists / create ... if not exists /
-- create or replace / on conflict do nothing), so re-running it changes nothing.

-- ---------------------------------------------------------------------------
-- 1. J1/J2 — the four columns
-- ---------------------------------------------------------------------------
-- ready_state is NOT NULL with a default of 'ready', which is what backfills
-- every job that already exists: nobody has ever told this app a job was not
-- ready, so claiming otherwise about six months of live jobs would put a red
-- flag on work that is going fine. The two ways a job is BORN not ready — an
-- import from Monday, and a tracking job built in one tap from the clock-in —
-- say so explicitly at creation instead.
alter table projects
  add column if not exists ready_state text not null default 'ready',
  -- A date, not a timestamp: "the windows land on the 15th" is the whole fact.
  -- Deliberately NOT package_deliveries.expected_at, which is a per-TRUCK ETA
  -- for one delivery. This is the job-level answer to "when do we have glass",
  -- and merging the two would make a single early truck look like the whole
  -- order arriving.
  add column if not exists materials_eta date,
  -- A timestamp, because this one is an event somebody did: a foreman tapped
  -- "Materials arrived" at a moment, and the record should say when.
  add column if not exists materials_arrived_at timestamptz,
  -- Null means "nobody has placed this job by hand" — every such job sorts
  -- AFTER the ones somebody deliberately ordered, by start date and then name.
  -- Sparse on purpose: ordering the whole list is a foreman's occasional act,
  -- not a property every job must carry.
  add column if not exists sort_order int;

alter table projects drop constraint if exists projects_ready_state_check;
alter table projects add constraint projects_ready_state_check
  check (ready_state in ('not_ready', 'ready'));

comment on column projects.ready_state is
  'not_ready | ready — whether the site is ready for us to work. Existing jobs backfilled to ready; Monday imports and one-tap tracking jobs are born not_ready. RPC-only (set_project_readiness) — the projects grant law, see below.';
comment on column projects.materials_eta is
  'The day the windows are expected on this job (job-level, not a truck ETA). Written by set_project_materials (foreman+).';
comment on column projects.materials_arrived_at is
  'When somebody tapped "Materials arrived" on this job. Null means the windows are still not in. Written by set_project_materials (foreman+).';
comment on column projects.sort_order is
  'The office''s hand-made order for the jobs list, 1..n, written by set_projects_order (foreman+). Null sorts last, then start_date, then name.';

-- THE PROJECTS GRANT LAW (wave D, 20260959000000): table-level INSERT/UPDATE on
-- projects is revoked, and only the columns the app writes directly are granted
-- back. A new column is therefore RPC-only unless it is named there. All four
-- of these are deliberately left OFF the grant list: readiness, the materials
-- dates and the list order are each decisions with a rank behind them
-- (foreman+), and a column-level grant cannot check a rank. `start_date` is
-- already on wave D's update grant, which is why "expected start" stays an
-- ordinary inline edit through updateProject and needs nothing here.

create index if not exists projects_pipeline_start_idx
  on projects (start_date)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. J1 — set_project_readiness (foreman+)
-- ---------------------------------------------------------------------------
create or replace function public.set_project_readiness(
  p_project_id uuid,
  p_ready_state text
)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can say whether a job is ready.';
  end if;
  if p_ready_state is null or p_ready_state not in ('not_ready', 'ready') then
    raise exception 'A job is either ready or not ready — nothing else.';
  end if;

  update projects
     set ready_state = p_ready_state
   where id = p_project_id
  returning * into v_row;

  if not found then
    raise exception 'That job does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_project_readiness(uuid, text) is
  'Foreman+: mark a job Ready or Not ready. SECURITY DEFINER because projects'' table-level UPDATE grant is revoked (wave D) and ready_state is deliberately not granted back — the rank check belongs in a body, not in a column grant.';

revoke all on function public.set_project_readiness(uuid, text) from public, anon;
grant execute on function public.set_project_readiness(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. J1 — set_project_materials (foreman+)
-- ---------------------------------------------------------------------------
-- Two facts, one door, and every combination has to be sayable without a
-- sentinel that means two things. So: nulls mean LEAVE ALONE, and the two ways
-- of erasing a fact are said out loud.
--
--   change the ETA        p_materials_eta := '2026-09-15'
--   clear the ETA         p_clear_eta := true
--   the windows are here  p_arrived := true
--   no, they are not      p_arrived := false
--   touch neither         (defaults)
--
-- The alternative — "null clears it" — would have made the one-tap "Materials
-- arrived" button wipe the ETA every time it was pressed, because that call
-- has no ETA to send.
create or replace function public.set_project_materials(
  p_project_id uuid,
  p_materials_eta date default null,
  p_clear_eta boolean default false,
  p_arrived boolean default null
)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can set when the windows are coming.';
  end if;

  update projects
     set materials_eta = case
           when coalesce(p_clear_eta, false) then null
           when p_materials_eta is not null then p_materials_eta
           else materials_eta
         end,
         materials_arrived_at = case
           -- Arriving twice must not move the time: the first tap is when the
           -- truck actually showed up, and a second tap (a mis-tap, a refresh,
           -- a second person confirming) should not quietly rewrite it.
           when p_arrived is true then coalesce(materials_arrived_at, now())
           when p_arrived is false then null
           else materials_arrived_at
         end
   where id = p_project_id
  returning * into v_row;

  if not found then
    raise exception 'That job does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_project_materials(uuid, date, boolean, boolean) is
  'Foreman+: set or clear a job''s window ETA and record that the windows arrived (or un-record it). Null arguments mean "leave that fact alone" so the one-tap Materials-arrived call cannot wipe the ETA.';

revoke all on function public.set_project_materials(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.set_project_materials(uuid, date, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. J2 — set_projects_order (foreman+)
-- ---------------------------------------------------------------------------
-- Takes the WHOLE visible list in its new order and writes 1..n. Sending the
-- whole list rather than "move this one to position 4" is what makes the
-- result the same whichever way it was dragged, and what makes a second
-- foreman's save land as a whole coherent order instead of interleaving with
-- somebody else's half-finished one.
--
-- Jobs not named in the array keep whatever sort_order they had. The Jobs page
-- always sends every job it is showing, so in practice the array IS the list;
-- leaving absent jobs alone is what stops a filtered or paged caller from
-- silently un-ordering everything it could not see.
create or replace function public.set_projects_order(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can reorder the jobs list.';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  update projects p
     set sort_order = o.position
    from (
      select id, ordinality::int as position
      from unnest(p_ids) with ordinality as u(id, ordinality)
    ) as o
   where p.id = o.id;
end;
$$;

comment on function public.set_projects_order(uuid[]) is
  'Foreman+: write the jobs list order as 1..n in the order the ids arrive. Ids not in the array keep the sort_order they had.';

revoke all on function public.set_projects_order(uuid[]) from public, anon;
grant execute on function public.set_projects_order(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. J4 — pipeline_nudges: the record of what has already been said
-- ---------------------------------------------------------------------------
-- One row per thing the sweep has said about a job. The unique key IS the
-- idempotency: a sweep that runs twice, or a database that keeps a cron job
-- alive through a deploy, cannot push the same sentence twice.
--
-- `on_date` is THE DAY THE NUDGE IS ABOUT, not the day it was sent — a
-- deliberate choice, and the one that makes the record survive an outage. The
-- 14-day warning is keyed to the job's start date, so if the sweep misses a
-- morning the warning still goes out the next one and still only once; and if
-- somebody MOVES the start date, the new date is a new key and the crew is
-- warned again about the new plan, which is exactly right. The late-materials
-- nudge is keyed to the ETA it missed, so it fires once per promised date,
-- forever, rather than every morning until somebody notices.
--
-- `kind` deliberately carries NO check constraint. This table is the shared
-- idempotency ledger for every "the app noticed something and said so" rule,
-- and wave O's credential-expiry warnings (O4) are meant to land here as new
-- kinds with no migration at all. See the extension point in section 8.
create table if not exists pipeline_nudges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null,
  on_date date not null,
  created_at timestamptz not null default now(),
  unique (project_id, kind, on_date)
);

create index if not exists pipeline_nudges_project_idx
  on pipeline_nudges (project_id, created_at desc);

alter table pipeline_nudges enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- wall — one permissive policy added later by anybody would turn a table with
-- no write policy into a write hole. The sweep runs on the service-role key,
-- which these revokes never touch.
revoke all on pipeline_nudges from anon, authenticated;
grant select on pipeline_nudges to authenticated;
grant all on pipeline_nudges to service_role;

-- Readable by any signed-in crew member (a job's own history of "we told you"
-- is not a secret, and the Overview may one day show it), never by a partner
-- login — the mechanical wall guard every crew table carries since
-- 20260950000000. No insert/update/delete policy at all: the sweep is the only
-- writer, and it writes as the service role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pipeline_nudges' and policyname = 'crew read'
  ) then
    create policy "crew read" on pipeline_nudges
      for select to authenticated
      using (not public.is_partner_user() and (true));
  end if;
end;
$$;

comment on table pipeline_nudges is
  'One row per nudge the pipeline sweep has already sent about a job. The unique (project_id, kind, on_date) is the idempotency: on_date is the day the nudge is ABOUT (a start date, a missed ETA), never the day it was sent. Open vocabulary of kinds so later rules — wave O credential expiry — reuse this ledger.';

-- ---------------------------------------------------------------------------
-- 6. J4 — who hears about it
-- ---------------------------------------------------------------------------
-- Everyone who can actually do something: every supervisor and owner (they own
-- the pipeline), plus every foreman who is either scheduled on the job in the
-- next fortnight or standing on it right now with an open shift. NOT every
-- foreman in the company — a foreman with no connection to Sand Hollow reading
-- about Sand Hollow every morning is how a crew learns to swipe the app's
-- notifications away without reading them.
--
-- Partner logins are excluded outright. They are not crew, and a builder must
-- never learn from a notification that our windows are late.
--
-- Defined before the claim that calls it so the file reads in dependency
-- order; plpgsql would not have minded either way, but a reader would.
create or replace function public.pipeline_nudge_audience(p_project_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[])
    from profiles pr
   where pr.active
     and not coalesce(pr.is_partner, false)
     and (
       public._is_supervisor(pr.id)
       or (
         public._is_lead(pr.id)
         and (
           exists (
             select 1
               from schedule_assignments sa
               join schedule_assignment_members sam on sam.assignment_id = sa.id
              where sa.project_id = p_project_id
                and sam.profile_id = pr.id
                and sa.status <> 'canceled'
                and sa.end_date >= (now() at time zone 'America/Denver')::date
                and sa.start_date <= (now() at time zone 'America/Denver')::date + 14
           )
           or exists (
             select 1
               from time_shifts ts
              where ts.project_id = p_project_id
                and ts.profile_id = pr.id
                and ts.status = 'open'
                and ts.clock_out_at is null
           )
         )
       )
     );
$$;

comment on function public.pipeline_nudge_audience(uuid) is
  'Who hears a pipeline warning about one job: every active supervisor+, plus every foreman scheduled on it within the next fortnight or clocked into it right now. Partner logins never.';

revoke all on function public.pipeline_nudge_audience(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_nudge_audience(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. J4 — claim_pipeline_nudges: the decision and the claim, in one statement
-- ---------------------------------------------------------------------------
-- THE RULE LIVES TWICE, ON PURPOSE, AND THE TWO COPIES ARE PINNED TOGETHER.
-- app/src/lib/pipeline.ts holds the readable version (needsCall / dueNudges),
-- which drives the "Needs a call" chip on the Jobs page; this body holds the
-- same rule in SQL, because the sweep must decide and claim in ONE statement or
-- two overlapping sweeps both push. pipeline.test.ts carries a test named after
-- this function that spells these clauses out in TypeScript, so a change made
-- to one side and not the other fails a test rather than going quietly live.
--
-- The claim is `insert ... on conflict do nothing returning`, the same trick
-- 20260976000000's claim_still_on_the_job_nudges plays with UPDATE: the insert
-- takes the row lock, so a second sweep genuinely sees the first one's work and
-- returns nobody.
--
-- Two rules today:
--   (a) the job starts soon and something is still not settled — once at the
--       14-day mark, once at the 7-day mark. WINDOWED (8..14 days out, then
--       0..7) rather than "exactly 14", because one missed sweep must not
--       silently drop a warning; the unique key already guarantees each is said
--       once per start date. A job whose start date MOVES is warned again about
--       the new date, which is the right answer and not an accident.
--   (b) the promised ETA came and went with nothing arrived — said once, keyed
--       to the date that was missed, so it does not become a daily drumbeat.
--
-- The spec's third start-date clause, "no GC check-in in the last 14 days", is
-- NOT here: wave H ships the project_gc_checkins table it needs, and a rule
-- that reads a missing table would either break the sweep or fire on every job
-- in the company for the crime of never having been asked. See section 8.
--
-- Service context only. auth.uid() is null under the service-role key the edge
-- function uses and under pg_cron, and no crew member should be able to fire
-- the company's morning push by hand.
create or replace function public.claim_pipeline_nudges()
returns table (
  project_id uuid,
  job_label text,
  kind text,
  days_until int,
  not_ready boolean,
  materials_missing boolean,
  profile_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The OUT columns above share their names with real columns in the query below
-- (project_id, kind). Ambiguity between an OUT parameter and a column is a
-- plpgsql runtime error, not a compile one, so it would first appear at 7 AM in
-- production. Every reference below is table-qualified AND this pragma makes
-- the column win regardless — belt and braces on a function nobody watches run.
#variable_conflict use_column
declare
  v_tz constant text := 'America/Denver';
  v_today date;
  v_hour int;
begin
  if auth.uid() is not null then
    raise exception 'The pipeline reminder sends itself — nobody needs to press anything.';
  end if;

  v_today := (now() at time zone v_tz)::date;
  v_hour := extract(hour from (now() at time zone v_tz))::int;

  -- Before 7 AM company time there is nothing due. The cron pokes this hourly
  -- rather than once at a fixed UTC hour so the "morning" stays the crew's
  -- morning through both halves of the year; the claim is what makes a repeated
  -- poke free.
  if v_hour < 7 then
    return;
  end if;

  return query
  with candidate as (
    select p.id as pid,
           coalesce(nullif(btrim(p.name), ''), p.job_code) as label,
           (p.start_date - v_today)::int as days_out,
           p.ready_state as ready,
           p.materials_eta as eta,
           p.materials_arrived_at as arrived_at
      from projects p
     where p.status = 'active'
       and p.deleted_at is null
  ),
  due as (
    -- (a) starting soon, and still not ready or still no windows.
    select c.pid,
           c.label,
           case when c.days_out > 7 then 'start_14' else 'start_7' end::text as due_kind,
           (v_today + c.days_out) as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           c.arrived_at is null as flag_no_materials
      from candidate c
     where c.days_out between 0 and 14
       and (c.ready = 'not_ready' or c.arrived_at is null)
    union all
    -- (b) the promised day came and went and nothing is here.
    select c.pid,
           c.label,
           'materials_late'::text as due_kind,
           c.eta as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           true as flag_no_materials
      from candidate c
     where c.eta is not null
       and c.arrived_at is null
       and c.eta < v_today
  ),
  claimed as (
    insert into pipeline_nudges (project_id, kind, on_date)
    select d.pid, d.due_kind, d.due_date from due d
    on conflict (project_id, kind, on_date) do nothing
    returning pipeline_nudges.project_id as claimed_pid,
              pipeline_nudges.kind as claimed_kind
  )
  select d.pid,
         d.label,
         d.due_kind,
         d.days_out,
         d.flag_not_ready,
         d.flag_no_materials,
         public.pipeline_nudge_audience(d.pid)
    from due d
    join claimed cl
      on cl.claimed_pid = d.pid
     and cl.claimed_kind = d.due_kind;
end;
$$;

comment on function public.claim_pipeline_nudges() is
  'Service-role only (the pipeline-sweep edge function): claims and returns the job warnings due this company-local morning — 14 and 7 days before a start date on a job that is still not ready or has no windows, and the morning after a missed materials ETA. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is needsCall/dueNudges in app/src/lib/pipeline.ts.';

revoke all on function public.claim_pipeline_nudges() from public, anon, authenticated;
grant execute on function public.claim_pipeline_nudges() to service_role;

-- ---------------------------------------------------------------------------
-- 8. J5 — the extension point, written down so the next wave finds it
-- ---------------------------------------------------------------------------
-- Two later waves are meant to ride this sweep rather than grow one of their
-- own. Both need the same three things — a rule that yields (subject, kind,
-- date-it-is-about), a claim through pipeline_nudges, and an audience — and
-- both should arrive as ONE new function plus one call added to the edge
-- function's list, never as a second cron job.
--
--   WAVE O (O4, credential expiry). Add claim_credential_nudges() shaped
--   exactly like claim_pipeline_nudges above: same service-role-only guard,
--   same 7 AM local gate, and an insert into pipeline_nudges with kinds of its
--   own ('cert_expiring_30', 'cert_expired', …) whose on_date is the expiry
--   date the warning is ABOUT. Nothing here needs to change: `kind` carries no
--   check constraint precisely so a new rule needs no migration, and the
--   supabase/functions/pipeline-sweep index.ts already loops over a list of
--   rules rather than hard-coding this one.
--
--   WAVE H (H1, the GC handshake). The spec's third start-date clause — "no GC
--   check-in in the last 14 days" — belongs in the `due` CTE's (a) branch, as
--   one more OR beside `ready_state = 'not_ready'`:
--       or not exists (select 1 from project_gc_checkins g
--                       where g.project_id = c.id
--                         and g.contacted_at >= (v_today - 14))
--   It is deliberately absent today because project_gc_checkins does not exist
--   yet, and a rule that reads a missing table would either fail the sweep or
--   (worse) fire on every job in the company for never having been asked. The
--   matching seam on the app side is needsCall's `gcCheckinsKnown` argument in
--   app/src/lib/pipeline.ts, which defaults to false for exactly this reason.

-- ---------------------------------------------------------------------------
-- 9. J4 — the cron
-- ---------------------------------------------------------------------------
-- Hourly rather than once a day at a fixed UTC hour, for the reason wave K's
-- sweep is every five minutes: pg_cron schedules in UTC, the company's morning
-- is in Denver, and the offset between them changes twice a year. An hourly
-- poke with the 7 AM test inside the SQL is right in both halves of the year
-- and costs nothing — before 7 the claim returns nobody, and after it, only the
-- first sweep of the morning claims anything.
--
-- Wrapped in exception handlers the way 20260963000000_summon_expiry.sql wraps
-- its own: a database without pg_cron (a local `supabase start`, a fork for a
-- test) still applies this migration. The nudge is a courtesy — every fact it
-- reads is on the job's own Overview whether or not anyone is told — so a
-- missing scheduler earns a warning in the log, never a failed migration.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise warning 'pipeline-sweep: pg_cron is not available here (%) — the morning job reminder will not run. Nothing else about the job pipeline changes.', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise warning 'pipeline-sweep: pg_net is not available here (%) — the morning job reminder will not run. Nothing else about the job pipeline changes.', sqlerrm;
end;
$$;

do $$
begin
  perform cron.unschedule('pipeline-sweep');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

-- The project ref is this repo's one production project, pinned the same way
-- 20260918000000 and 20260976000000 pin it for their sweeps. verify_jwt = false
-- on the target function, so no auth header rides along — see the function's
-- own header for why that is safe.
do $$
begin
  perform cron.schedule(
    'pipeline-sweep',
    '0 * * * *',
    $c$
    select net.http_post(
      url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/pipeline-sweep',
      body := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
    $c$
  );
exception when others then
  raise warning 'pipeline-sweep: could not schedule the sweep (%) — the morning job reminder will not run. Nothing else about the job pipeline changes.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. The test-login fence
-- ---------------------------------------------------------------------------
-- pipeline_nudges carries project_id, so it is project-scoped and the fence
-- belongs on it. Re-arming is idempotent and reports what it did
-- (20260967000000); a test login can only ever touch the sandbox job's rows,
-- and the service-role sweep is unaffected because the guard is a no-op when
-- there is no JWT.
select public.attach_sandbox_guards();
