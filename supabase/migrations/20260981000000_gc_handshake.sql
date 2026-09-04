-- Wave H — The GC handshake (transcripts program, grill of 2026-09-03, Q10 +
-- Q11 + Q20), plus one wall fix on the wave that came before it.
--
-- Three things happen here:
--
--   H0  ready_state, materials_eta and materials_arrived_at MOVE off `projects`
--       into a crew-only side table. Wave J weighed leaving them there and
--       decided they were harmless; they are not. A builder (partner) login
--       granted a job reads the whole `projects` row, so "your windows have not
--       arrived" was readable by the general contractor — which is the exact
--       fact this wave exists to let us tell a GC on OUR schedule, in our own
--       words, on a page we built for the purpose.
--
--   H1  project_gc_checkins — the six answers somebody gets off the GC on the
--       phone, filed once, append-only, and read by the sweep so "nobody has
--       called this builder in a fortnight" finally counts for something.
--
--   H2  gc_links + gc_messages — a no-login page a GC opens from a text or an
--       email, answers the same six questions on, and asks a question back
--       through. Every read and write on that page goes through the gc-link
--       edge function on the service role. NO ANON POLICY IS ADDED TO ANY TABLE
--       BY THIS MIGRATION: a token is a key to a function, never to a table.
--
-- Idempotent throughout (add column if not exists / create ... if not exists /
-- create or replace / drop ... if exists before a signature change), so
-- re-running it changes nothing.
--
-- Timezone: 'America/Denver' spelled out, the same company-local day every
-- clock gate and both sweeps use. There is no shared helper — the convention IS
-- the literal.

-- ===========================================================================
-- H0. The wall fix: the pipeline facts move off `projects`
-- ===========================================================================
-- WHY THIS IS A BUG AND NOT A PREFERENCE. `projects` is the one table a partner
-- login reads whole, row-level, for each job they were granted (THE WALL,
-- 20260950000000 section 6). RLS has no column-level half. So when wave J put
-- readiness and the two materials dates on that table, it handed every granted
-- builder a live feed of whether we are behind on their house — no push
-- required, just the row. 20260979000000's own reasoning says a builder "is
-- never PUSHED about our problems", and that is true of the sweep and false of
-- the table.
--
-- The three facts are not secrets in the way a bid is. They are worse: they are
-- OUR OPERATIONAL STATE, and the whole point of wave H is that a GC learns
-- where we are from a conversation we start — a check-in, a link, an email —
-- and not by refreshing a portal at 6 AM. "Not ready" is a note we write to
-- ourselves about a site nobody has walked yet. Read by the builder who owns
-- that site, it is an accusation.
--
-- The shape is Z's, verbatim: a side table with its own policy, one row per
-- job, project_id as the primary key (a job has one pipeline state, and a
-- surrogate id would invite two). 20260978000000 moved bid_amount and
-- target_margin_pct off `projects` for exactly this reason and left the note
-- saying so; this is the second time, and the note was right.
--
-- sort_order STAYS on `projects`. It is a bare integer whose meaning is "fourth
-- in a list a builder cannot see", it orders every one of those lists in SQL,
-- and moving it would put a join in the hot path of the app shell to hide a
-- number that says nothing.
create table if not exists project_pipeline (
  project_id uuid primary key references projects(id) on delete cascade,
  -- Same default as the column it replaces: every job that already existed is
  -- ready, because nobody has ever been able to say otherwise about them.
  ready_state text not null default 'ready',
  materials_eta date,
  materials_arrived_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Filled by the RPCs below (auth.uid()), never by a client: who last said a
  -- job was ready is not something the browser gets to claim. Null under the
  -- service role or a SQL console, which is the honest answer there.
  updated_by uuid references profiles(id) on delete set null
);

alter table project_pipeline drop constraint if exists project_pipeline_ready_state_check;
alter table project_pipeline add constraint project_pipeline_ready_state_check
  check (ready_state in ('not_ready', 'ready'));

comment on table project_pipeline is
  'One job''s readiness and materials dates, moved off `projects` (20260979000000) by wave H so they can carry a policy of their own. A partner login reads the whole `projects` row for a job it was granted, so anything about how WE are doing has to live somewhere else — the same reasoning that moved the bid to project_financials. Written only by set_project_readiness / set_project_materials (foreman+); read by any crew login, never by a partner.';

comment on column project_pipeline.ready_state is
  'not_ready | ready — whether the site is ready for us to work. Existing jobs are ready; Monday imports and one-tap tracking jobs are born not_ready.';
comment on column project_pipeline.materials_eta is
  'The day the windows are expected on this job (job-level, not package_deliveries.expected_at, which is one truck).';
comment on column project_pipeline.materials_arrived_at is
  'When somebody tapped "Materials arrived". Null means the windows are still not in — and, with no materials_eta, that nobody has said anything either way, which is why both the sweep and needsCall read the pair.';

-- Backfill BEFORE the drop and only while the old columns still exist, so a
-- second run of this file is a no-op instead of an error. `on conflict do
-- nothing` protects a row the app has already written since.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'ready_state'
  ) then
    execute $q$
      insert into project_pipeline (project_id, ready_state, materials_eta, materials_arrived_at)
      select id,
             coalesce(ready_state, 'ready'),
             materials_eta,
             materials_arrived_at
        from projects
       where ready_state is distinct from 'ready'
          or materials_eta is not null
          or materials_arrived_at is not null
      on conflict (project_id) do nothing
    $q$;
  end if;
end;
$$;

alter table projects drop constraint if exists projects_ready_state_check;
alter table projects drop column if exists ready_state;
alter table projects drop column if exists materials_eta;
alter table projects drop column if exists materials_arrived_at;

alter table project_pipeline enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- place to stand. SELECT only — both writers are SECURITY DEFINER RPCs with a
-- rank check in the body, because "is this job ready" is a foreman's call and a
-- column grant cannot check a rank.
revoke all on project_pipeline from anon, authenticated;
grant select on project_pipeline to authenticated;
grant all on project_pipeline to service_role;

-- Any signed-in crew member reads it, and no partner ever does. An installer
-- opening a job wants to know there is no glass on site just as much as the
-- office does — hiding that behind a rank is how a crew drives to a job that
-- was never going to happen.
drop policy if exists "pipeline_crew_read" on project_pipeline;
create policy "pipeline_crew_read" on project_pipeline
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- THE PROJECTS GRANT LAW (wave D, 20260959000000, re-stated by wave Z): the
-- table-level INSERT/UPDATE on `projects` is revoked and only the columns the
-- app writes directly are granted back. Dropping a column drops its privilege
-- with it, so the lists are re-stated here — and their CONTENT is unchanged,
-- because all three dropped columns were deliberately RPC-only and never named
-- in either list. Re-stating them anyway is the law's point: a reader should
-- learn what is writable from the newest migration that touched this table
-- rather than by diffing three of them.
revoke insert, update on table projects from anon, authenticated;
grant insert (job_code, name, address, customer_name, contact_phone,
              contact_email, site_state, unit_number, start_date, end_date,
              notes)
  on projects to authenticated;
grant update (name, address, customer_name, contact_phone, contact_email,
              site_state, unit_number, start_date, end_date, notes,
              estimated_minutes, estimated_crew, estimated_at)
  on projects to authenticated;

-- ---------------------------------------------------------------------------
-- H0. set_project_readiness — same name, same arguments, new home
-- ---------------------------------------------------------------------------
-- The RETURN TYPE changes (a `projects` row no longer carries these facts), and
-- Postgres will not let CREATE OR REPLACE change one, so the old function is
-- dropped first. Its only caller is lib/api.ts's wrapper, which has always
-- ignored the returned row.
drop function if exists public.set_project_readiness(uuid, text);

create or replace function public.set_project_readiness(
  p_project_id uuid,
  p_ready_state text
)
returns project_pipeline
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_pipeline;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can say whether a job is ready.';
  end if;
  if p_ready_state is null or p_ready_state not in ('not_ready', 'ready') then
    raise exception 'A job is either ready or not ready — nothing else.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  insert into project_pipeline (project_id, ready_state, updated_at, updated_by)
  values (p_project_id, p_ready_state, now(), auth.uid())
  on conflict (project_id) do update
    set ready_state = excluded.ready_state,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_project_readiness(uuid, text) is
  'Foreman+: mark a job Ready or Not ready. Writes project_pipeline, not `projects` — wave H moved the fact off a table a granted builder reads whole. SECURITY DEFINER because the side table grants no write to any client role; the rank check belongs in a body, not in a column grant.';

revoke all on function public.set_project_readiness(uuid, text) from public, anon;
grant execute on function public.set_project_readiness(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- H0. set_project_materials — same name, same arguments, new home
-- ---------------------------------------------------------------------------
-- The argument contract is untouched, and it is worth restating because it is
-- load-bearing: nulls mean LEAVE THAT FACT ALONE, and the two ways of erasing
-- one are said out loud. "Null clears it" would make the one-tap "Materials
-- arrived" button wipe the ETA every time it was pressed, because that call has
-- no ETA to send.
drop function if exists public.set_project_materials(uuid, date, boolean, boolean);

create or replace function public.set_project_materials(
  p_project_id uuid,
  p_materials_eta date default null,
  p_clear_eta boolean default false,
  p_arrived boolean default null
)
returns project_pipeline
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_pipeline;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can set when the windows are coming.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  -- The row may not exist yet (a job nobody has touched since wave H), so this
  -- is an upsert whose INSERT branch applies the same three-way logic against
  -- "no row" that the UPDATE branch applies against the stored one.
  insert into project_pipeline (project_id, materials_eta, materials_arrived_at, updated_at, updated_by)
  values (
    p_project_id,
    case when coalesce(p_clear_eta, false) then null else p_materials_eta end,
    case when p_arrived is true then now() else null end,
    now(),
    auth.uid()
  )
  on conflict (project_id) do update
    set materials_eta = case
          when coalesce(p_clear_eta, false) then null
          when p_materials_eta is not null then p_materials_eta
          else project_pipeline.materials_eta
        end,
        materials_arrived_at = case
          -- Arriving twice must not move the time: the first tap is when the
          -- truck actually showed up, and a second tap (a mis-tap, a refresh,
          -- a second person confirming) should not quietly rewrite it.
          when p_arrived is true then coalesce(project_pipeline.materials_arrived_at, now())
          when p_arrived is false then null
          else project_pipeline.materials_arrived_at
        end,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_project_materials(uuid, date, boolean, boolean) is
  'Foreman+: set or clear a job''s window ETA and record that the windows arrived (or un-record it). Writes project_pipeline (wave H moved the facts off `projects`). Null arguments mean "leave that fact alone" so the one-tap Materials-arrived call cannot wipe the ETA.';

revoke all on function public.set_project_materials(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.set_project_materials(uuid, date, boolean, boolean) to authenticated;

-- ===========================================================================
-- H1. project_gc_checkins — what the general contractor actually said
-- ===========================================================================
-- Six questions get asked on every job, and the answers used to live in
-- somebody's memory of a phone call: when does the GC think the house is
-- finished, when does the roof go on, has the framing been checked, does he
-- want the windows inset or outset, and what is going on the outside and the
-- inside. Six answers, one row, and the row IS the record that somebody talked
-- to the builder.
--
-- APPEND-ONLY, and that is the design rather than an omission. A check-in is
-- what a person said on a day. If the GC changes his mind next week that is a
-- SECOND check-in, and the pair of them is the story: "he told us the 14th in
-- August and the 28th in September" is a fact worth having, and an UPDATE would
-- erase it. There is no update or delete policy on this table at all, and the
-- one writer below only ever inserts.
--
-- All six are NOT NULL. A half-filled check-in is worse than none: it looks
-- like somebody asked, and the next person to open the job believes it.
--
-- inset/outset here is the GC's JOB-LEVEL answer, and it does not decide
-- anything about a unit. The per-unit spec field in the signature stays
-- authoritative for what actually gets installed where — this is what the
-- builder SAID he wanted, which is a different fact and sometimes a different
-- answer.
create table if not exists project_gc_checkins (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Who filed it. Null when the GC answered on the no-login page (there is no
  -- profile to point at) and when a crew member's account is later removed.
  author_id uuid references profiles(id) on delete set null,
  -- When the conversation happened, which is not always when it was typed up.
  contacted_at timestamptz not null default now(),
  contact_name text,
  channel text not null,
  expected_end_date date not null,
  roof_on_date date not null,
  framing_checked boolean not null,
  set_preference text not null,
  exterior_material text not null,
  interior_material text not null,
  notes text,
  -- 'crew' — somebody in the office filed it after a call. 'gc' — the builder
  -- answered it himself on the link. The difference matters when the answers
  -- disagree: one of them is a memory of a phone call and the other is the
  -- builder's own typing.
  source text not null default 'crew',
  created_at timestamptz not null default now()
);

alter table project_gc_checkins drop constraint if exists project_gc_checkins_channel_check;
alter table project_gc_checkins add constraint project_gc_checkins_channel_check
  check (channel in ('call', 'text', 'email', 'site'));

alter table project_gc_checkins drop constraint if exists project_gc_checkins_set_pref_check;
alter table project_gc_checkins add constraint project_gc_checkins_set_pref_check
  check (set_preference in ('inset', 'outset', 'unknown'));

alter table project_gc_checkins drop constraint if exists project_gc_checkins_source_check;
alter table project_gc_checkins add constraint project_gc_checkins_source_check
  check (source in ('crew', 'gc'));

-- The sweep asks "when was the last one on this job" for every active job every
-- morning, and the GC card asks the same question about one job. Both are this
-- index.
create index if not exists project_gc_checkins_project_idx
  on project_gc_checkins (project_id, contacted_at desc);

comment on table project_gc_checkins is
  'One conversation with a job''s general contractor: the six standing questions, who said it, how, and when. Append-only — a changed answer is a second row, and the pair is the story. source = crew (the office filed it after a call) or gc (the builder answered on the no-login link). Filing one is what "communicated with the GC" means, and the 7 AM sweep reads the latest one.';

alter table project_gc_checkins enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`. SELECT only — the RPC
-- below is the only writer, so append-only is a fact about the grants and not
-- just about the code.
revoke all on project_gc_checkins from anon, authenticated;
grant select on project_gc_checkins to authenticated;
grant all on project_gc_checkins to service_role;

-- Any signed-in crew member reads it, and no partner ever does. THE WALL, and
-- more than mechanically: this table holds one side of a conversation with the
-- builder, written by us, and a builder login reading our own notes about
-- talking to him is the same mistake H0 just undid.
drop policy if exists "gc_checkins_crew_read" on project_gc_checkins;
create policy "gc_checkins_crew_read" on project_gc_checkins
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---------------------------------------------------------------------------
-- H1. log_gc_checkin (foreman+)
-- ---------------------------------------------------------------------------
-- Validated in here as well as in the browser, because the browser's copy is a
-- courtesy and this one is the rule. Every refusal is a sentence somebody in a
-- truck can act on — "Say when the GC expects the house to be finished", not
-- "null value in column expected_end_date violates not-null constraint".
create or replace function public.log_gc_checkin(
  p_project_id uuid,
  p_expected_end_date date,
  p_roof_on_date date,
  p_framing_checked boolean,
  p_set_preference text,
  p_exterior_material text,
  p_interior_material text,
  p_channel text default 'call',
  p_contact_name text default null,
  p_notes text default null,
  p_contacted_at timestamptz default null
)
returns project_gc_checkins
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_gc_checkins;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can file a GC check-in.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  if p_expected_end_date is null then
    raise exception 'Say when the GC expects the house to be finished.';
  end if;
  if p_roof_on_date is null then
    raise exception 'Say when the roof goes on.';
  end if;
  if p_framing_checked is null then
    raise exception 'Say whether the framing has been checked.';
  end if;
  if coalesce(p_set_preference, '') not in ('inset', 'outset', 'unknown') then
    raise exception 'Say whether the GC wants the windows inset, outset, or that he has not said.';
  end if;
  if coalesce(btrim(p_exterior_material), '') = '' then
    raise exception 'Say what is going on the outside.';
  end if;
  if coalesce(btrim(p_interior_material), '') = '' then
    raise exception 'Say what is going on the inside.';
  end if;
  if coalesce(p_channel, '') not in ('call', 'text', 'email', 'site') then
    raise exception 'Say how you talked to the GC: a call, a text, an email, or on site.';
  end if;

  insert into project_gc_checkins (
    project_id, author_id, contacted_at, contact_name, channel,
    expected_end_date, roof_on_date, framing_checked, set_preference,
    exterior_material, interior_material, notes, source
  )
  values (
    p_project_id,
    auth.uid(),
    -- A check-in typed up the morning after is dated to the conversation, not
    -- to the typing. Null means "just now", which is the common case.
    coalesce(p_contacted_at, now()),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    p_channel,
    p_expected_end_date,
    p_roof_on_date,
    p_framing_checked,
    p_set_preference,
    btrim(p_exterior_material),
    btrim(p_interior_material),
    nullif(btrim(coalesce(p_notes, '')), ''),
    'crew'
  )
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.log_gc_checkin(uuid, date, date, boolean, text, text, text, text, text, text, timestamptz) is
  'Foreman+: file one conversation with a job''s GC — the six standing answers plus who, how and any notes. Append-only; a changed answer is a second row. SECURITY DEFINER because project_gc_checkins grants no INSERT to any client role, which is what makes append-only a fact about the grants rather than a promise about the code.';

revoke all on function public.log_gc_checkin(uuid, date, date, boolean, text, text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.log_gc_checkin(uuid, date, date, boolean, text, text, text, text, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- H0 + H1. The 7 AM sweep: the new home, and the fourth reason
-- ---------------------------------------------------------------------------
-- Two changes, and they arrive together because the function has to be dropped
-- and recreated either way — Postgres will not let CREATE OR REPLACE change a
-- function's OUT columns, and the second change adds one.
--
-- H0. claim_pipeline_nudges() decided from three columns on `projects`; they
-- are gone, so its candidate CTE joins project_pipeline instead. A LEFT JOIN
-- with coalesce, not an inner one: a job nobody has ever set readiness on has
-- no row there at all, and it is READY — the same answer the NOT NULL DEFAULT
-- gave when these were columns, and the only one that does not put a red flag
-- on every job in the company the morning this deploys.
--
-- H1. THE FOURTH REASON, which 20260979000000 section 8 was written to hand
-- over: "no GC check-in in the last 14 days", as one more OR beside
-- ready_state = 'not_ready'. Wave J left it out because project_gc_checkins did
-- not exist and a rule reading a missing table either breaks the sweep or fires
-- on every job in the company. The table exists now, and here is the thing
-- worth saying out loud before this ships:
--
--   IT WILL FIRE ON EVERY JOB STARTING INSIDE A FORTNIGHT, on the first
--   morning, because no job in the company has ever had a check-in filed. THAT
--   IS THE POINT AND NOT A BUG. Unlike materials_arrived_at — where a blank
--   meant "nobody could record it" and counting it would have been a lie — a
--   missing check-in now means exactly what it says: nobody has talked to that
--   builder, and somebody should. The list empties itself as the calls get
--   made, one row each.
--
-- THE RULE STILL LIVES TWICE AND THE COPIES ARE STILL PINNED. The readable
-- version is needsCall / dueNudges in app/src/lib/pipeline.ts; this body is the
-- one the sweep runs, because it has to decide and claim in one statement or
-- two overlapping sweeps both push. pipeline.test.ts carries a block named
-- after this function that spells these clauses out in TypeScript, including
-- the fourteen days.
drop function if exists public.claim_pipeline_nudges();

create or replace function public.claim_pipeline_nudges()
returns table (
  project_id uuid,
  job_label text,
  kind text,
  days_until int,
  not_ready boolean,
  materials_missing boolean,
  no_gc_checkin boolean,
  profile_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The OUT columns above share their names with real columns in the query below.
-- Ambiguity between an OUT parameter and a column is a plpgsql RUNTIME error,
-- not a compile one, so it would first appear at 7 AM in production. Every
-- reference below is table-qualified AND this pragma makes the column win
-- regardless — belt and braces on a function nobody watches run.
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
           -- No row means nobody has ever said anything about this job, and
           -- that job is READY — the same answer wave J's NOT NULL DEFAULT gave
           -- while these were columns, and the only one that does not red-flag
           -- every job in the company on the morning the table appears.
           coalesce(pp.ready_state, 'ready') as ready,
           pp.materials_eta as eta,
           pp.materials_arrived_at as arrived_at,
           -- The company-local DAY of the most recent conversation, so "14
           -- days ago" means fourteen of the crew's days and not fourteen
           -- times twenty-four hours measured in UTC. Null means there has
           -- never been one, which is itself the thing worth calling about.
           (select max((g.contacted_at at time zone v_tz)::date)
              from project_gc_checkins g
             where g.project_id = p.id) as last_checkin_day
      from projects p
      left join project_pipeline pp on pp.project_id = p.id
     where p.status = 'active'
       and p.deleted_at is null
  ),
  due as (
    -- (a) starting soon, and still not ready or the promised windows are not
    --     here. "Promised" is c.eta is not null — a job nobody promised windows
    --     for cannot be missing them.
    select c.pid,
           c.label,
           case when c.days_out > 7 then 'start_14' else 'start_7' end::text as due_kind,
           (v_today + c.days_out) as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           (c.eta is not null and c.arrived_at is null) as flag_no_materials,
           (c.last_checkin_day is null or c.last_checkin_day <= v_today - 14) as flag_no_checkin
      from candidate c
     where c.days_out between 0 and 14
       and (
         c.ready = 'not_ready'
         or (c.eta is not null and c.arrived_at is null)
         or c.last_checkin_day is null
         or c.last_checkin_day <= v_today - 14
       )
    union all
    -- (b) the promised day came and went and nothing is here.
    select c.pid,
           c.label,
           'materials_late'::text as due_kind,
           c.eta as due_date,
           c.days_out,
           c.ready = 'not_ready' as flag_not_ready,
           true as flag_no_materials,
           -- Late windows are their own message. Whether anybody has called
           -- the builder lately is not part of it, and saying so here would
           -- pad a sentence that is already the only one that matters.
           false as flag_no_checkin
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
         d.flag_no_checkin,
         public.pipeline_nudge_audience(d.pid)
    from due d
    join claimed cl
      on cl.claimed_pid = d.pid
     and cl.claimed_kind = d.due_kind;
end;
$$;

comment on function public.claim_pipeline_nudges() is
  'Service-role only (the pipeline-sweep edge function): claims and returns the job warnings due this company-local morning — 14 and 7 days before a start date on a job that is still not ready, has no windows, or has had no GC check-in in a fortnight, and the morning after a missed materials ETA. Reads project_pipeline (wave H moved readiness and the materials dates off `projects`); a job with no row there is ready. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is needsCall/dueNudges in app/src/lib/pipeline.ts.';

revoke all on function public.claim_pipeline_nudges() from public, anon, authenticated;
grant execute on function public.claim_pipeline_nudges() to service_role;

-- ===========================================================================
-- H2. The GC's own page: gc_brand, gc_links, gc_messages
-- ===========================================================================
-- A general contractor does not have a login here and is never going to want
-- one. He gets a link in a text or an email, opens it on his phone, answers the
-- same six questions, and can ask a question back. That is the whole feature.
--
-- HOW THE TOKEN IS SAFE, said plainly because this is the first thing in this
-- schema a stranger on the internet can reach with a credential we minted:
--
--   * 32 random bytes — 256 bits. There is no guessing it, and no rate limit
--     is what makes that true; the entropy is.
--   * STORED HASHED (sha256, hex). A database backup, a support query, a
--     screenshot of a table: none of them hand anybody a working link.
--   * IT IS A KEY TO A FUNCTION, NEVER TO A TABLE. No policy in this migration
--     grants anon anything. Everything the page reads and writes goes through
--     the gc-link edge function on the service role, which builds its answer
--     field by field (wave S's projection law) from exactly four things: the
--     job's name, the brand, the six questions with any prior answers, and the
--     thread. A crew login pointing the same token at PostgREST directly gets
--     nothing it could not already read, because the token is not a grant.
--   * 30 days, then it stops working. Revocable at any time, from the card.
--
-- WHAT THE GC NEVER SEES, and this is the whole reason H0 came first: our
-- readiness, our materials dates, our schedule, our costs, our crew. The page
-- shows him the questions and his own answers. It is a conversation we started,
-- not a window into the company.

-- ---- The brand this job is presented under (Q20, the owner's design) --------
-- One company, two names, and which one a customer hears is a per-JOB decision
-- rather than a company-wide setting: some builders know us as STG Windows &
-- Doors and some as Forge, and the wrong name on an email is the kind of small
-- wrong thing that makes somebody wonder who they are actually dealing with.
--
-- On `projects` rather than on gc_links, because a job's brand outlives any one
-- link — revoke and resend and it is still the same relationship — and because
-- the page header and the email subject both need it. RPC-ONLY under the
-- projects grant law: it is deliberately NOT added to the insert or update
-- grant lists restated in section H0 above, so set_project_gc_brand is the only
-- writer. A granted builder reading it learns which of our two names we use
-- with them, which they already know.
alter table projects
  add column if not exists gc_brand text not null default 'stg';

alter table projects drop constraint if exists projects_gc_brand_check;
alter table projects add constraint projects_gc_brand_check
  check (gc_brand in ('stg', 'forge'));

comment on column projects.gc_brand is
  'stg | forge — which of the company''s two names this job''s general contractor hears, on the GC page and in the email. Default stg, the outward-facing brand. Written only by set_project_gc_brand (foreman+); deliberately absent from the projects grant lists.';

create or replace function public.set_project_gc_brand(
  p_project_id uuid,
  p_brand text
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
    raise exception 'Only a foreman or above can choose which name the GC sees.';
  end if;
  if coalesce(p_brand, '') not in ('stg', 'forge') then
    raise exception 'The GC sees us as STG Windows & Doors or as Forge Windows and Doors — nothing else.';
  end if;

  update projects set gc_brand = p_brand where id = p_project_id
  returning * into v_row;

  if not found then
    raise exception 'That job does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.set_project_gc_brand(uuid, text) is
  'Foreman+: choose which of the company''s two names this job''s GC sees on his page and in his email. SECURITY DEFINER because gc_brand is deliberately off the projects grant lists — a column grant cannot check a rank.';

revoke all on function public.set_project_gc_brand(uuid, text) from public, anon;
grant execute on function public.set_project_gc_brand(uuid, text) to authenticated;

-- ---- gc_links ---------------------------------------------------------------
create table if not exists gc_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- The credential, hashed. UNIQUE so a hash collision or a double-insert is a
  -- constraint error rather than two links that both open one job.
  token_hash text not null unique,
  brand text not null default 'stg',
  sent_to_email text,
  sent_by uuid references profiles(id) on delete set null,
  sent_at timestamptz,
  -- Thirty days. Long enough to survive a builder who reads his email weekly,
  -- short enough that a forwarded text from last spring is dead.
  expires_at timestamptz not null default now() + interval '30 days',
  -- The first time anybody answered anything on it. Not "opened" — a link the
  -- GC looked at and closed has told us nothing.
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- Rate limiting, on the row rather than in a side table: the row IS the
  -- rate-limit subject, one link is one conversation, and a table of attempts
  -- would need its own purge.
  post_count int not null default 0,
  last_post_at timestamptz,
  -- Reads are COUNTED, not limited. Refusing a refresh loop would lock out the
  -- one person the link exists for, and a read costs a lookup; 256 bits of
  -- token is what stops a stranger, not a counter.
  hit_count int not null default 0,
  last_hit_at timestamptz
);

alter table gc_links drop constraint if exists gc_links_brand_check;
alter table gc_links add constraint gc_links_brand_check
  check (brand in ('stg', 'forge'));

-- One job's links, newest first — what the GC card lists, and how "is there a
-- live link on this job" is answered.
create index if not exists gc_links_project_idx
  on gc_links (project_id, created_at desc);

comment on table gc_links is
  'A no-login link handed to one job''s general contractor. token_hash is sha256 of 32 random bytes; the plaintext is returned by create_gc_link ONCE and never stored, so a link that was not copied or emailed is gone and a fresh one gets minted. 30-day expiry, revocable. NO ROLE HAS ANY POLICY TO WRITE THIS TABLE and anon has none at all: the token is a key to the gc-link edge function, never to a table.';

alter table gc_links enable row level security;

revoke all on gc_links from anon, authenticated;
grant select on gc_links to authenticated;
grant all on gc_links to service_role;

-- Crew read, never a partner. The office has to be able to see that a link is
-- out, when it was sent and to whom — and the token is not in this table in any
-- usable form, so reading it hands nobody the ability to open the page.
drop policy if exists "gc_links_crew_read" on gc_links;
create policy "gc_links_crew_read" on gc_links
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- gc_messages -------------------------------------------------------------
-- The thread. Two people talk on it: the general contractor, on his page, and
-- the office, from the GC card.
--
-- NEVER CREW CHAT. project_messages is where the crew talks to each other about
-- a job, and it is walled from partners for a reason; putting an outsider's
-- words in it — or letting him read what is already there — is the one mistake
-- that would make this feature dangerous rather than useful. Two tables, no
-- join between them, and nothing on this one is shown on the chat tab.
create table if not exists gc_messages (
  id uuid primary key default gen_random_uuid(),
  -- Which link it came in on. SET NULL rather than CASCADE: revoking a link
  -- must not delete what the builder already said.
  gc_link_id uuid references gc_links(id) on delete set null,
  project_id uuid not null references projects(id) on delete cascade,
  -- 'gc' — the builder typed it on his page. 'office' — one of ours replied.
  author text not null,
  -- Who, when it was one of ours. Always null for a GC message: there is no
  -- profile to point at, and that is the honest answer.
  author_profile_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table gc_messages drop constraint if exists gc_messages_author_check;
alter table gc_messages add constraint gc_messages_author_check
  check (author in ('gc', 'office'));

create index if not exists gc_messages_project_idx
  on gc_messages (project_id, created_at);

comment on table gc_messages is
  'The thread between one job''s general contractor and the office. Deliberately NOT project_messages: crew chat is walled from outsiders, and an outsider''s words must not land in it nor his eyes on what is already there. Written only by post_gc_message (office, foreman+) and gc_link_say (the GC, through the edge function on the service role).';

alter table gc_messages enable row level security;

revoke all on gc_messages from anon, authenticated;
grant select on gc_messages to authenticated;
grant all on gc_messages to service_role;

drop policy if exists "gc_messages_crew_read" on gc_messages;
create policy "gc_messages_crew_read" on gc_messages
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---------------------------------------------------------------------------
-- H2. create_gc_link (foreman+) — the only place a token is ever born
-- ---------------------------------------------------------------------------
-- Returns the PLAINTEXT token exactly once, to the person who pressed the
-- button. It is never stored, never logged and cannot be recovered: "send it
-- again" mints a fresh link and revokes the old one, which is both simpler than
-- keeping a secret around and better hygiene — a resend rotates the credential.
--
-- ONE LIVE LINK PER JOB. Any earlier link on the same job is revoked in the
-- same statement, so a builder who was sent two links last month cannot answer
-- on the older one and have it look current.
create or replace function public.create_gc_link(
  p_project_id uuid,
  p_email text default null,
  p_brand text default null
)
returns table (link_id uuid, token text, expires_at timestamptz, brand text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
  v_hash text;
  v_brand text;
  v_row gc_links;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can hand a job to its GC.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;
  if p_brand is not null and p_brand not in ('stg', 'forge') then
    raise exception 'The GC sees us as STG Windows & Doors or as Forge Windows and Doors — nothing else.';
  end if;

  -- The job's own brand unless the caller names one, so the page and the email
  -- match whatever the office chose on this job.
  select coalesce(p_brand, pr.gc_brand, 'stg') into v_brand
    from projects pr where pr.id = p_project_id;

  -- base64url: the standard alphabet's + and / become - and _, and translate
  -- drops the padding = because it has no replacement character. 43 characters,
  -- safe in a URL and in a text message.
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  update gc_links
     set revoked_at = now()
   where gc_links.project_id = p_project_id
     and gc_links.revoked_at is null;

  insert into gc_links (project_id, token_hash, brand, sent_to_email, sent_by, sent_at)
  values (
    p_project_id,
    v_hash,
    v_brand,
    nullif(btrim(lower(coalesce(p_email, ''))), ''),
    auth.uid(),
    case when nullif(btrim(coalesce(p_email, '')), '') is null then null else now() end
  )
  returning * into v_row;

  return query select v_row.id, v_token, v_row.expires_at, v_row.brand;
end;
$$;

comment on function public.create_gc_link(uuid, text, text) is
  'Foreman+: mint a no-login link for one job''s GC and revoke any earlier live one. Returns the plaintext token ONCE — it is stored only as a sha256 hash, so it cannot be shown again and "send it again" mints a fresh link, rotating the credential.';

revoke all on function public.create_gc_link(uuid, text, text) from public, anon;
grant execute on function public.create_gc_link(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- H2. revoke_gc_link (foreman+)
-- ---------------------------------------------------------------------------
create or replace function public.revoke_gc_link(p_link_id uuid)
returns gc_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row gc_links;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can turn a GC link off.';
  end if;

  -- Revoking twice is not an error and does not move the time: the first
  -- revoke is when somebody decided, and a second tap should not rewrite it.
  update gc_links
     set revoked_at = coalesce(revoked_at, now())
   where id = p_link_id
  returning * into v_row;

  if not found then
    raise exception 'That link does not exist.';
  end if;

  return v_row;
end;
$$;

comment on function public.revoke_gc_link(uuid) is
  'Foreman+: turn a GC link off. Idempotent — revoking twice keeps the first time, because that is when somebody decided.';

revoke all on function public.revoke_gc_link(uuid) from public, anon;
grant execute on function public.revoke_gc_link(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- H2. post_gc_message (foreman+) — the office's side of the thread
-- ---------------------------------------------------------------------------
create or replace function public.post_gc_message(
  p_project_id uuid,
  p_body text
)
returns gc_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row gc_messages;
  v_link uuid;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can write to the GC.';
  end if;
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Write something before you send it.';
  end if;
  if length(btrim(p_body)) > 4000 then
    raise exception 'That message is too long to send — keep it under 4000 characters.';
  end if;

  -- Attached to the live link when there is one, so the GC sees the reply on
  -- the page he already has open. With no live link the reply is still recorded
  -- against the job, and the office can see it was written before anybody had
  -- somewhere to read it.
  select id into v_link
    from gc_links
   where project_id = p_project_id
     and revoked_at is null
     and expires_at > now()
   order by created_at desc
   limit 1;

  insert into gc_messages (gc_link_id, project_id, author, author_profile_id, body)
  values (v_link, p_project_id, 'office', auth.uid(), btrim(p_body))
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.post_gc_message(uuid, text) is
  'Foreman+: reply to a job''s GC on the thread he sees on his link page. Never crew chat — project_messages is a different table for a different audience.';

revoke all on function public.post_gc_message(uuid, text) from public, anon;
grant execute on function public.post_gc_message(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- H2. The three service-role doors the gc-link edge function knocks on
-- ---------------------------------------------------------------------------
-- These are the ONLY way a token turns into anything. Each is
-- service-role-only: `revoke ... from authenticated` means a crew login holding
-- a token cannot call them from the browser, and anon was never granted
-- anything. The edge function hashes the token it was handed and passes the
-- HASH, so the plaintext never reaches the database.
--
-- Each one re-checks the link's state itself rather than trusting the caller to
-- have checked: expired, revoked, or unknown all end the same way, and the
-- function tells the page one plain sentence rather than four.

/*
 * The state check and the rate limit, in one place, for both write doors.
 *
 * It CLAIMS the attempt as it checks it — the update that bumps post_count is
 * the same statement that reads last_post_at, so two taps arriving together
 * cannot both pass. A separate read-then-write would be a race with a stranger
 * on the other end of it.
 *
 * The limits are deliberately loose. Somebody answering six questions on a
 * phone with bad signal will retry, and a limit tight enough to catch a script
 * would catch him first; 256 bits of token is what stops a stranger, and this
 * only stops a stuck retry loop from filling the table.
 */
create or replace function public._gc_link_for_write(p_token_hash text)
returns gc_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link gc_links;
begin
  update gc_links
     set post_count = gc_links.post_count + 1,
         last_post_at = now()
   where token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and (last_post_at is null or last_post_at < now() - interval '2 seconds')
     and post_count < 200
  returning * into v_link;

  if found then
    return v_link;
  end if;

  -- Work out WHY, but only in the two cases where saying so helps the person
  -- holding the link. An unknown token and a revoked one get the same sentence,
  -- because telling a stranger which of the two he has is telling him something.
  select * into v_link from gc_links where token_hash = p_token_hash;
  if found and v_link.revoked_at is null and v_link.expires_at > now() then
    raise exception 'That went through a moment ago — give it a second and try again.';
  end if;

  raise exception 'This link has expired — ask your installer for a new one.';
end;
$$;

comment on function public._gc_link_for_write(text) is
  'Service role only: the shared state check and rate limit behind gc_link_answer and gc_link_say. Claims the attempt in the same statement that checks it, so two taps at once cannot both pass. An unknown token and a revoked one get the same sentence on purpose.';

revoke all on function public._gc_link_for_write(text) from public, anon, authenticated;
grant execute on function public._gc_link_for_write(text) to service_role;

/* Resolve a token to the little the page is allowed to know. */
create or replace function public.gc_link_open(p_token_hash text)
returns table (
  link_id uuid,
  project_id uuid,
  job_label text,
  brand text,
  state text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link gc_links;
begin
  select * into v_link from gc_links where token_hash = p_token_hash;
  if not found then
    -- No row, and no hint about why. A stranger learns nothing from the shape
    -- of the answer, and the one real user is told the same plain sentence
    -- whatever went wrong.
    return;
  end if;

  update gc_links
     set hit_count = gc_links.hit_count + 1,
         last_hit_at = now()
   where id = v_link.id;

  return query
  select v_link.id,
         v_link.project_id,
         coalesce(nullif(btrim(p.name), ''), p.job_code) as job_label,
         v_link.brand,
         case
           when v_link.revoked_at is not null then 'revoked'
           when v_link.expires_at <= now() then 'expired'
           else 'live'
         end as state
    from projects p
   where p.id = v_link.project_id;
end;
$$;

comment on function public.gc_link_open(text) is
  'Service role only (the gc-link edge function): turn a token HASH into the job label, the brand and whether the link is live. Counts the read. Returns no row at all for a token nobody minted, so a stranger cannot tell an unknown token from an expired one.';

revoke all on function public.gc_link_open(text) from public, anon, authenticated;
grant execute on function public.gc_link_open(text) to service_role;

/* The GC answers the six questions. Returns who should be told. */
create or replace function public.gc_link_answer(
  p_token_hash text,
  p_expected_end_date date,
  p_roof_on_date date,
  p_framing_checked boolean,
  p_set_preference text,
  p_exterior_material text,
  p_interior_material text,
  p_contact_name text default null,
  p_notes text default null
)
returns table (project_id uuid, job_label text, profile_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link gc_links;
begin
  v_link := public._gc_link_for_write(p_token_hash);

  -- The same six checks log_gc_checkin makes, in the same words. The GC reads
  -- these sentences too, so they say what to do rather than what failed.
  if p_expected_end_date is null then
    raise exception 'Please say when you expect the house to be finished.';
  end if;
  if p_roof_on_date is null then
    raise exception 'Please say when the roof goes on.';
  end if;
  if p_framing_checked is null then
    raise exception 'Please say whether the framing has been checked.';
  end if;
  if coalesce(p_set_preference, '') not in ('inset', 'outset', 'unknown') then
    raise exception 'Please say whether you want the windows inset or outset.';
  end if;
  if coalesce(btrim(p_exterior_material), '') = '' then
    raise exception 'Please say what is going on the outside.';
  end if;
  if coalesce(btrim(p_interior_material), '') = '' then
    raise exception 'Please say what is going on the inside.';
  end if;

  insert into project_gc_checkins (
    project_id, author_id, contacted_at, contact_name, channel,
    expected_end_date, roof_on_date, framing_checked, set_preference,
    exterior_material, interior_material, notes, source
  )
  values (
    v_link.project_id,
    -- No profile: the person who typed this has no login here, and inventing
    -- one for them would put a crew member's name on the builder's words.
    null,
    now(),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    'email',
    p_expected_end_date,
    p_roof_on_date,
    p_framing_checked,
    p_set_preference,
    btrim(p_exterior_material),
    btrim(p_interior_material),
    nullif(btrim(coalesce(p_notes, '')), ''),
    'gc'
  );

  update gc_links
     set used_at = coalesce(used_at, now())
   where id = v_link.id;

  return query
  select p.id,
         coalesce(nullif(btrim(p.name), ''), p.job_code),
         public.pipeline_nudge_audience(p.id)
    from projects p
   where p.id = v_link.project_id;
end;
$$;

comment on function public.gc_link_answer(text, date, date, boolean, text, text, text, text, text) is
  'Service role only (the gc-link edge function): file the GC''s own answers as a project_gc_checkins row with source = gc, and return who to push. Rate-limited and state-checked through _gc_link_for_write.';

revoke all on function public.gc_link_answer(text, date, date, boolean, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.gc_link_answer(text, date, date, boolean, text, text, text, text, text) to service_role;

/* The GC asks a question. Returns who should be told. */
create or replace function public.gc_link_say(
  p_token_hash text,
  p_body text
)
returns table (project_id uuid, job_label text, profile_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link gc_links;
begin
  v_link := public._gc_link_for_write(p_token_hash);

  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Please write something before you send it.';
  end if;
  if length(btrim(p_body)) > 4000 then
    raise exception 'That message is too long to send — please keep it under 4000 characters.';
  end if;

  insert into gc_messages (gc_link_id, project_id, author, author_profile_id, body)
  values (v_link.id, v_link.project_id, 'gc', null, btrim(p_body));

  update gc_links
     set used_at = coalesce(used_at, now())
   where id = v_link.id;

  return query
  select p.id,
         coalesce(nullif(btrim(p.name), ''), p.job_code),
         public.pipeline_nudge_audience(p.id)
    from projects p
   where p.id = v_link.project_id;
end;
$$;

comment on function public.gc_link_say(text, text) is
  'Service role only (the gc-link edge function): record a message the GC typed on his page and return who to push. Never writes project_messages — crew chat is a different table for a different audience.';

revoke all on function public.gc_link_say(text, text) from public, anon, authenticated;
grant execute on function public.gc_link_say(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The test-login fence
-- ---------------------------------------------------------------------------
-- All four tables this wave adds carry a project_id, which is what makes a
-- table project-scoped (sandbox_scoped_tables, 20260967000000), so all four are
-- fenced by this one line at the end of the file. Re-arming is idempotent and
-- reports what it did; a test login can only ever touch the sandbox job's rows,
-- and neither the service-role sweep nor the gc-link function is affected,
-- because the guard is a no-op when there is no JWT.
select public.attach_sandbox_guards();
