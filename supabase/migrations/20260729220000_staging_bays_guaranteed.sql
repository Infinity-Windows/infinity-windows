-- Every job gets its two warehouse staging bays, guaranteed by the database.
--
-- WHY THIS EXISTS
-- Until now the "two bays per job" rule lived in seven lines of client-side
-- TypeScript inside createProject(). Nothing behind it: no trigger, no
-- constraint, no detection, no repair path. The first job to arrive by any
-- other route (a merge) landed with no bays and nobody was told — and
-- suggest_location() silently fell through to the shared stock shelves, so a
-- foreman would have been directed to put that job's windows on S-01-C next to
-- every other job's material. Windows staged on the wrong shelf get installed
-- at the wrong address. See docs/black-desert-staging-bays-2026-07-29.md §7.
--
-- WHAT IT DOES
--   1. create_staging_bays()  — the rule itself, idempotent, in one place.
--   2. An AFTER INSERT trigger on projects, so EVERY insertion path gets bays:
--      the app, a merge, a restore, a seed, a hand-written INSERT.
--   3. locations_staging_bay_exists — a BEFORE INSERT no-op guard, so asking
--      for a bay that already exists is not an error for anyone.
--   4. ensure_project_staging_bays() — a foreman-callable repair RPC.
--   5. suggest_location() stops silently recommending a shared stock shelf for
--      a job that has no bay: it refuses, and says why.
--   6. A backfill for jobs that already exist.
--
-- THE RACK CONVENTION, WHICH IS NOT NEGOTIABLE
-- rack is the job code CHARACTER FOR CHARACTER, with no shortening,
-- truncation or re-punctuation of any kind. All six bays in production
-- (BLACK22, OAKRIDGE, PECAN14) are exactly their projects.job_code. That is
-- not cosmetic: locations has no project_id, and the ONLY link from a bay to
-- its job is the string join `locations.rack = projects.job_code`, which
-- suggest_location() performs. Deriving rack by any rule that can differ from
-- job_code — uppercasing, stripping punctuation, trimming to N characters —
-- would produce a bay that exists, is visible in every picker, and belongs to
-- no job. That is a worse failure than no bay at all, because it is invisible.
-- The app normalises the job CODE at creation time (createProject uppercases
-- and dashes it); the bay then copies whatever that produced.

-- 1) The rule ----------------------------------------------------------------
-- SECURITY DEFINER so that the guarantee does not depend on the caller's own
-- rights over `locations`: whoever can create a job gets bays for it. It is
-- internal — no role is granted EXECUTE, so it is reachable only through the
-- trigger and the repair RPC below, both of which are also definers.
create or replace function public.create_staging_bays(p_job_code text)
returns setof public.locations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := btrim(coalesce(p_job_code, ''));
begin
  -- A job code of '' would generate the address 'J--A', which is not a shelf
  -- anyone can label or find. Better to create nothing and let the detection
  -- check and suggest_location()'s refusal make the gap loud.
  if v_code = '' then
    return;
  end if;

  -- Bring back a bay that was retired rather than leaving the job one short.
  -- Retiring is how the app deletes a slot (deleteLocation sets active=false),
  -- so without this the repair path would have no way to undo one.
  update public.locations
     set active = true
   where zone = 'J' and rack = v_code and slot in ('A', 'B') and not active;

  -- `where not exists` rather than relying on ON CONFLICT alone: locations.serial
  -- defaults to nextval('location_serial_seq'), sequences are not transactional,
  -- and ON CONFLICT evaluates the default before it discovers the conflict. So a
  -- bare ON CONFLICT DO NOTHING would burn two permanent serials every time this
  -- ran against a job that already had its bays — and this runs on every project
  -- insert and every repair click. ON CONFLICT stays as the race backstop only.
  --
  -- serial is never named here, exactly as createProject never named it and the
  -- seed migration never named it: the column default is the only allocator, and
  -- the six live bays hold SLOT-000039..000052 with gaps in them. Nothing
  -- requires serials to be contiguous. `address` is never named either — it is a
  -- generated column and Postgres rejects an INSERT that mentions it.
  insert into public.locations (zone, rack, slot, capacity)
  select 'J', v_code, s.slot, 10
    from (values ('A'), ('B')) as s(slot)
   where not exists (
     select 1 from public.locations l
      where l.zone = 'J' and l.rack = v_code and l.slot = s.slot
   )
  on conflict (zone, rack, slot) do nothing;

  return query
    select l.* from public.locations l
     where l.zone = 'J' and l.rack = v_code
     order by l.slot;
end;
$$;

revoke all on function public.create_staging_bays(text) from public, anon, authenticated;

comment on function public.create_staging_bays(text) is
  'Idempotently give a job code its two staging bays (J-<code>-A/B). Internal: '
  'called by the projects trigger and by ensure_project_staging_bays().';

-- 2) The guarantee -----------------------------------------------------------
create or replace function public.projects_create_staging_bays()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.create_staging_bays(new.job_code);
  return null;  -- AFTER trigger: the return value is ignored.
end;
$$;

revoke all on function public.projects_create_staging_bays() from public, anon, authenticated;

drop trigger if exists projects_create_staging_bays on public.projects;
create trigger projects_create_staging_bays
  after insert on public.projects
  for each row execute function public.projects_create_staging_bays();

-- 3) Asking for a bay that already exists is a no-op, not an error ------------
-- Two reasons. First, deployment order: the frontend currently in production
-- still inserts the two bays from createProject(), and the moment the trigger
-- above goes live that insert would hit locations_zone_rack_slot_key, and
-- createProject's compensating delete would then delete the job the user just
-- made. Second, and more lastingly, it is the right semantics — the seed
-- migration already wrote `on conflict do nothing` for exactly this, and every
-- other route that wants to be sure a job has bays should be able to just ask.
--
-- Deliberately narrow: zone 'J' only, only when a row with that exact
-- (zone, rack, slot) is already there. A duplicate stock shelf still raises.
create or replace function public.locations_staging_bay_exists()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.zone = 'J' and exists (
    select 1 from public.locations l
     where l.zone = 'J' and l.rack = new.rack and l.slot = new.slot
  ) then
    return null;  -- skip the insert; the bay is already there
  end if;
  return new;
end;
$$;

revoke all on function public.locations_staging_bay_exists() from public, anon, authenticated;

drop trigger if exists locations_staging_bay_exists on public.locations;
create trigger locations_staging_bay_exists
  before insert on public.locations
  for each row execute function public.locations_staging_bay_exists();

-- 4) The repair path a foreman can reach -------------------------------------
-- Fixing the one job that lacked bays previously required hand-written SQL
-- against production. Foreman+ only, matching preissue_project_units().
create or replace function public.ensure_project_staging_bays(p_project_id uuid)
returns setof public.locations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
  v_job_code text;
begin
  select role into v_caller_role from public.profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can create staging bays';
  end if;

  select job_code into v_job_code from public.projects where id = p_project_id;
  if v_job_code is null then
    raise exception 'unknown job %', p_project_id;
  end if;

  return query select * from public.create_staging_bays(v_job_code);
end;
$$;

revoke all on function public.ensure_project_staging_bays(uuid) from public, anon;
grant execute on function public.ensure_project_staging_bays(uuid) to authenticated;

comment on function public.ensure_project_staging_bays(uuid) is
  'Foreman+ repair: give a job its two staging bays if any are missing or retired.';

-- 5) Stop suggesting a shared shelf for a job with no bay ----------------------
-- The old body tried the job's J bays, found none, and fell through to zone S
-- WITHOUT SAYING SO. That is the dangerous half of this whole problem: the
-- foreman is told a real, valid-looking address, and the only symptom is two
-- absent entries in a 44-item dropdown.
--
-- It refuses rather than returning a shelf plus a warning flag. Refusing is the
-- honest answer — there is no correct job shelf to name, and the fix (create
-- the bays, which is now one tap) takes seconds. A warning flag would also have
-- meant widening the return type from `locations`, and every caller that did
-- not read the new field would be silently wrong again, which is the exact
-- failure being closed here. An exception cannot be read past by accident.
--
-- The bays-exist-but-are-full case still falls through to stock, and still
-- must: the windows have to go somewhere and refusing would block putaway
-- entirely. The client marks that suggestion as a shared shelf and the UI says
-- so out loud (app/src/lib/staging.ts).
--
-- hint = 'no_staging_bay' is the stable machine-readable marker the client
-- keys on; detail carries the job code so the UI can offer to fix that job.
create or replace function public.suggest_location(p_window_id uuid)
returns public.locations
language plpgsql
stable
set search_path = public
as $$
declare
  v_window windows;
  v_job_code text;
  v_bays int;
  v_loc locations;
begin
  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  if v_window.project_id is not null then
    select job_code into v_job_code from projects where id = v_window.project_id;

    select count(*) into v_bays
      from locations l
     where l.zone = 'J' and l.active and l.rack = v_job_code;

    if v_bays = 0 then
      raise exception
        'Job % has no staging bay, so there is no shelf of its own to put this window on. Create the job''s staging bays first — putting it on a shared stock shelf would mix this job''s windows in with everyone else''s.',
        coalesce(v_job_code, '(unknown)')
        using hint = 'no_staging_bay',
              detail = coalesce(v_job_code, '');
    end if;

    select l.* into v_loc
    from locations l
    join projects p on p.job_code = l.rack
    where l.zone = 'J' and l.active and p.id = v_window.project_id
      and (select count(*) from windows w where w.location_id = l.id) < l.capacity
    order by l.slot
    limit 1;
    if v_loc.id is not null then
      return v_loc;
    end if;
  end if;

  select l.* into v_loc
  from locations l
  where l.zone = 'S' and l.active
    and (select count(*) from windows w where w.location_id = l.id) < l.capacity
  order by
    (select count(*) from windows w
     where w.location_id = l.id and w.window_type_id = v_window.window_type_id) desc,
    (select count(*) from windows w where w.location_id = l.id) asc,
    l.address
  limit 1;

  return v_loc;
end;
$$;

-- 6) Backfill ------------------------------------------------------------------
-- Every job that already exists. On production all three already have their two
-- bays, so this inserts nothing and burns no serials — which is also the
-- clearest possible demonstration that the rule is idempotent.
do $$
declare
  v_job record;
begin
  for v_job in select job_code from public.projects loop
    perform public.create_staging_bays(v_job.job_code);
  end loop;
end;
$$;
