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

-- ---------------------------------------------------------------------------
-- H0. The 7 AM sweep reads the new home
-- ---------------------------------------------------------------------------
-- claim_pipeline_nudges() decided from three columns on `projects`; they are
-- gone, so its candidate CTE joins the side table instead. A LEFT JOIN with
-- coalesce, not an inner one: a job nobody has ever set readiness on has no row
-- here at all, and it is READY — the same answer the NOT NULL DEFAULT gave when
-- these were columns, and the only one that does not put a red flag on every
-- job in the company the morning this deploys.
--
-- THE RULE STILL LIVES TWICE AND THE COPIES ARE STILL PINNED. The readable
-- version is needsCall / dueNudges in app/src/lib/pipeline.ts; this body is the
-- one the sweep runs, because it has to decide and claim in one statement or
-- two overlapping sweeps both push. pipeline.test.ts carries a block named
-- after this function that spells these clauses out in TypeScript.
--
-- Dropped and recreated rather than replaced: H1 below adds a `no_gc_checkin`
-- column to the returned table, and Postgres will not let CREATE OR REPLACE
-- change a function's OUT columns. The whole body therefore lands once, here,
-- with wave H's own clause already in it — see section H1 for the reasoning
-- behind that clause and why wave J deliberately left it out.
drop function if exists public.claim_pipeline_nudges();

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
           pp.materials_arrived_at as arrived_at
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
           (c.eta is not null and c.arrived_at is null) as flag_no_materials
      from candidate c
     where c.days_out between 0 and 14
       and (
         c.ready = 'not_ready'
         or (c.eta is not null and c.arrived_at is null)
       )
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
  'Service-role only (the pipeline-sweep edge function): claims and returns the job warnings due this company-local morning. Reads project_pipeline (wave H moved readiness and the materials dates off `projects`); a job with no row there is ready. The claim and the decision are one statement, so two overlapping sweeps cannot both push. The readable copy of this rule is needsCall/dueNudges in app/src/lib/pipeline.ts.';

revoke all on function public.claim_pipeline_nudges() from public, anon, authenticated;
grant execute on function public.claim_pipeline_nudges() to service_role;

-- ---------------------------------------------------------------------------
-- H0. The test-login fence
-- ---------------------------------------------------------------------------
-- project_pipeline carries a project_id, so it is project-scoped and the fence
-- belongs on it. Re-arming is idempotent and reports what it did
-- (20260967000000); a test login can only ever touch the sandbox job's rows,
-- and the service-role sweep is unaffected because the guard is a no-op when
-- there is no JWT. Called once more at the very end of this file, after H1 and
-- H2's tables exist.
select public.attach_sandbox_guards();
