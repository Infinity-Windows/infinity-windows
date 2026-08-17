-- Staging bays and the jobsite half of load-out, for packages.
--
-- These were the two features the unit system had and the package system did
-- not — the gap that blocks retiring the unit location model (ticket 08b,
-- docs/warehouse-tickets.md). Building them here does NOT retire anything;
-- it removes the reason the retirement was impossible.
--
-- What "load-out" already is: `checkout_packages` takes a package out of
-- storage to a job with a reason. That IS the truck leg, and it shipped with
-- the storage feature. What was missing is its other half — confirming what
-- actually arrived, and catching damage at the jobsite, which is where
-- `unload_units` earns its keep on the unit side.
--
-- Staging needs no new table and no new status. A job's staging bay is a
-- `locations` row (zone 'J'), and a package can already point at a location
-- (ticket 04). Staged means: still ours, still on hand, sitting on the job's
-- shelf instead of in a conex. `packages_one_place_ck` already guarantees a
-- package is in a container OR at a location, never both.

-- ------------------------------------------------- damage can name a package

-- Ticket 06 found this gap and worked around it: issues point at a WINDOW, so
-- a package could not be reported damaged, and the hub's damaged card had to
-- count damage reports instead of damaged packages. Arrival damage is
-- per-package, so the column has to exist for the report to be honest.
alter table issues
  add column if not exists package_id uuid references packages (id) on delete set null;

create index if not exists issues_package_idx on issues (package_id);

-- ---------------------------------------------------------------- staging

/**
 * The job's staging bay, by the ONE link that exists between a bay and its
 * job: `locations.rack = projects.job_code`, character for character. See
 * 20260729220000 — deriving the rack by any other rule (uppercasing,
 * trimming, re-punctuating) produces a bay that exists, shows up in every
 * picker, and belongs to no job. Slot A is the default shelf; B is overflow.
 */
create or replace function public.job_staging_bay(p_project uuid)
returns uuid
language sql
stable
security definer
as $$
  select l.id
  from locations l
  join projects p on p.job_code = l.rack
  where p.id = p_project and l.zone = 'J' and l.active
  order by l.slot
  limit 1;
$$;

-- Any signed-in crew: set packages aside on the job's shelf so they go out
-- together. Reversible — checking one back into a conex just re-stores it.
--
-- Refuses when the job has no bay rather than falling back to a shared stock
-- shelf. That fallback is exactly the bug 20260729220000 was written to kill:
-- material staged on a shared shelf gets installed at the wrong address. The
-- `no_staging_bay` hint matches suggest_location() so the app can offer the
-- same repair.
create or replace function stage_packages(p_packages uuid[], p_project uuid)
returns int
language plpgsql
security definer
as $$
declare
  v_bay uuid;
  v_id uuid;
  v_prev uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material is staged for';
  end if;

  v_bay := public.job_staging_bay(p_project);
  if v_bay is null then
    raise exception 'this job has no staging bay yet'
      using hint = 'no_staging_bay';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select container_id into v_prev
    from packages
    where id = v_id and status in ('received', 'stored');
    if not found then
      continue; -- blank stickers and checked-out packages cannot be staged
    end if;

    update packages
    set status = 'stored', container_id = null, location_id = v_bay
    where id = v_id;

    insert into movements
      (package_id, event, from_container_id, to_location_id, project_id, actor, reason)
    values (v_id, 'staged', v_prev, v_bay, p_project, auth.uid()::text,
            'staged for the job');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ------------------------------------------------------------ arrival check

-- The jobsite half of load-out. Deliberately NOT a required step and NOT a
-- new status: the package map says On site "follows the checkout — this is
-- where it is, not something you do", and that stays true. This exists for
-- the one thing arrival genuinely adds — catching damage that happened in
-- transit, while somebody is standing in front of it.
--
-- Any signed-in crew, unlike the unit-side unload (foreman+): the person who
-- opens the crate is the installer, and making them find a foreman to report
-- a cracked pane is how damage stops getting reported.
create or replace function arrive_packages(
  p_ok uuid[],
  p_damaged uuid[],
  p_project uuid,
  p_note text default null
)
returns int
language plpgsql
security definer
as $$
declare
  v_id uuid;
  v_note text;
  v_serial text;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material arrived at';
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');

  foreach v_id in array coalesce(p_ok, array[]::uuid[])
  loop
    if not exists (
      select 1 from packages where id = v_id and status = 'checked_out'
    ) then
      continue;
    end if;
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'unloaded', p_project, auth.uid()::text,
            coalesce('arrived on site — ' || v_note, 'arrived on site'));
    v_count := v_count + 1;
  end loop;

  foreach v_id in array coalesce(p_damaged, array[]::uuid[])
  loop
    select serial into v_serial from packages where id = v_id and status = 'checked_out';
    if v_serial is null then
      continue;
    end if;

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'damaged', p_project, auth.uid()::text,
            coalesce('damaged on arrival — ' || v_note, 'damaged on arrival'));

    -- Deduped per package, mirroring the unit-side rule: a second report on
    -- the same package while the first is still open is the same problem.
    if not exists (
      select 1 from issues
      where package_id = v_id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, package_id, kind, urgency, note, created_by)
      values (
        p_project, v_id, 'damage', 'urgent',
        coalesce('Package ' || v_serial || ' damaged on arrival — ' || v_note,
                 'Package ' || v_serial || ' damaged on arrival'),
        auth.uid()
      );
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
