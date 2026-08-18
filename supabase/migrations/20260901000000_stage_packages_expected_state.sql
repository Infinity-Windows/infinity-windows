-- A queued set-aside can no longer land on top of something newer
-- (warehouse audit F3 follow-up — the same hole F2 closed for check-in).
--
-- THE BUG, and where it came from. Until this branch, "Set aside" talked
-- straight to the server: press it, it lands, it cannot go stale. F3 put it on
-- the offline queue so a foreman standing in a conex does not skip the step —
-- right call — but `stage_packages` writes status = 'stored', container_id =
-- null, location_id = the job's bay without ever asking what the package's
-- state IS at the moment the write lands. So a set-aside that sat on a phone
-- for ten minutes beats a checkout made one minute ago: the record says the
-- package is on BLACK22's shelf while it is riding to PECAN14 in a truck, and
-- nobody anywhere is told.
--
-- It is worse than a slow phone. The queue does not preserve order across a
-- failed entry, so a queued set-aside can replay AFTER a queued check-in for
-- the same package — the package is physically in a conex and the record puts
-- it on a job bay. Somebody walks to the bay and finds nothing.
--
-- THE RULE is the one F2 already settled, and it is deliberately not re-argued
-- here: the newer action wins. A queued set-aside that lost the race is
-- DROPPED and REPORTED. Applying it anyway is the bug with extra steps.
--
-- HOW. The phone writes down what it believed about each package at the moment
-- the person ticked it — that package's status, the container it was in, and
-- the shelf it was on — and sends that note with the write. This function
-- compares the note against the row PER PACKAGE, in the same statement that
-- writes it, and applies only the packages whose note still matches.
-- Everything else comes back named, so the app can tell a human which package
-- did not go on the shelf and what beat it there.
--
-- WHY THE NOTE CARRIES A SHELF, when the check-in note does not. Check-in has
-- one destination kind: a container. Set-aside's destination is a shelf, and
-- the state it has to tell apart is "already staged, on a DIFFERENT job's
-- bay" — where status is still 'stored' and container_id is still null, and
-- only location_id moved. A note of status + container alone would call that a
-- match and quietly drag another job's material onto this job's shelf, which
-- is the exact failure 20260729220000 exists to prevent.
--
-- WHY AN OVERLOAD, and what an out-of-date phone does. The old two-argument
-- `stage_packages(uuid[], uuid) returns int` is left EXACTLY as it is, not
-- touched, not dropped. Two reasons, the same two F2 gave:
--
--   1. A phone still running the old bundle physically cannot send a note.
--      Failing every set-aside made from a phone that has not reloaded is
--      worse than a rare race, so it keeps working, unchanged and quietly,
--      until that phone picks up the new bundle. A deliberate soft failure
--      for the deploy window.
--
--   2. A set-aside sent live, online, is the common case, and it still calls
--      the two-argument version — same one round trip, same answer, not a byte
--      slower. The note answers "is this still true after sitting in a queue",
--      and a write that never sat in a queue has nothing to compare against.
--
-- PostgREST picks between the two by the exact set of argument names in the
-- body: {p_packages, p_project} reaches the old one, {p_packages, p_project,
-- p_expected} reaches this one. `p_expected` deliberately has NO default — a
-- default would make the two-argument call ambiguous and break every set-aside
-- in the app.
--
-- Nothing here alters a table, a constraint or a policy, so it is safe against
-- a production database that is already full of rows.

create or replace function stage_packages(
  p_packages uuid[],
  p_project uuid,
  p_expected jsonb
)
returns jsonb
language plpgsql
security definer
-- Pinned because this runs as the owner and RLS is off inside it. There is a
-- whole migration in this repo (20260729210100) that exists because this was
-- forgotten twice; the neighbours it copies are still unpinned, and that is
-- the reason to pin here rather than the reason not to.
set search_path = public
as $$
declare
  v_bay uuid;
  v_id uuid;
  v_status text;
  v_container uuid;
  v_location uuid;
  v_serial text;
  v_note jsonb;
  v_exp_status text;
  v_exp_container uuid;
  v_exp_location uuid;
  v_hit int;
  v_staged int := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material is staged for';
  end if;

  -- Same refusal as the two-argument version, raised before anything is read:
  -- a job with no bay is not a race, it is a missing shelf, and only a person
  -- adding the bay fixes it. The `no_staging_bay` hint is what the app matches
  -- on to offer that repair, so it has to survive into this overload.
  v_bay := public.job_staging_bay(p_project);
  if v_bay is null then
    raise exception 'this job has no staging bay yet'
      using hint = 'no_staging_bay';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    -- `select into` sets every target to null when nothing comes back, and
    -- packages.status is NOT NULL, so a null status here means one thing:
    -- there is no such package. Read that instead of `FOUND`, which several
    -- later statements in this loop would clobber.
    select p.status, p.container_id, p.location_id, p.serial
      into v_status, v_container, v_location, v_serial
    from packages p
    where p.id = v_id;

    -- Already sitting exactly where this set-aside was sending it. That is
    -- this same write arriving a second time — the answer to the first one got
    -- lost, or a foreman pressed Try again after another package in the batch
    -- was refused. It is done. Counting it and writing NO movement row keeps
    -- the history honest about how many times the package moved, and makes the
    -- whole call safe to send again.
    if v_status = 'stored'
       and v_container is null
       and v_location is not distinct from v_bay
    then
      v_staged := v_staged + 1;
      continue;
    end if;

    v_note := coalesce(p_expected, '{}'::jsonb) -> v_id::text;
    v_exp_status := v_note ->> 'status';
    v_exp_container := nullif(v_note ->> 'container', '')::uuid;
    v_exp_location := nullif(v_note ->> 'location', '')::uuid;

    -- Apply only what the phone can vouch for. Four ways to fall out of this
    -- and every one of them ends up reported rather than skipped:
    --   * there is no such package;
    --   * the note has nothing for it, so we cannot tell whether it is still
    --     true (this is what a set-aside queued by an older bundle looks like);
    --   * the note says it was a blank sticker, which was never stageable;
    --   * the note says it was already checked out, which was never stageable
    --     either — the two-argument version skipped both of those in silence,
    --     which is exactly the habit F2 exists to break.
    if v_status is not null
       and v_exp_status is not null
       and v_exp_status in ('received', 'stored')
    then
      -- The compare and the write are ONE statement on purpose. Reading the
      -- row first and updating after leaves a gap another actor fits inside;
      -- putting the note in the WHERE clause makes the database do the
      -- comparing, against the row as it stands at the instant of the write.
      --
      -- container_id is cleared because a package on a shelf is not also in a
      -- box — `packages_one_place_ck` says so — and a package coming off a
      -- conex shelf onto its job's bay is the everyday set-aside.
      update packages
      set status = 'stored',
          container_id = null,
          location_id = v_bay
      where id = v_id
        and status = v_exp_status
        and container_id is not distinct from v_exp_container
        and location_id is not distinct from v_exp_location;
      get diagnostics v_hit = row_count;

      if v_hit = 1 then
        -- The previous spot is the note and not a fresh read: the update only
        -- touched the row BECAUSE the two matched, so the note is the proven
        -- old value. Same movement row the two-argument version wrote, plus
        -- the shelf it came off, so history reads the same for every set-aside
        -- that lands.
        insert into movements
          (package_id, event, from_container_id, from_location_id,
           to_location_id, project_id, actor, reason)
        values (v_id, 'staged', v_exp_container, v_exp_location, v_bay,
                p_project, auth.uid()::text, 'staged for the job');
        v_staged := v_staged + 1;
        continue;
      end if;

      -- The note matched a moment ago and does not now: somebody wrote to this
      -- row between the read at the top of the loop and the update. Re-read so
      -- the refusal names what is actually true.
      select p.status, p.container_id, p.location_id, p.serial
        into v_status, v_container, v_location, v_serial
      from packages p
      where p.id = v_id;
    end if;

    -- Refused. Say which package and what beat it, in facts the app can turn
    -- into a sentence: the serial a person reads off the sticker, the state
    -- the package is really in, the box or the shelf it is really on, and —
    -- when it was checked out — the job it went to.
    v_refused := v_refused || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'serial', v_serial,
      'status', v_status,
      'container', (
        select c.name from storage_containers c where c.id = v_container
      ),
      'location', (
        select l.address from locations l where l.id = v_location
      ),
      'job', case when v_status = 'checked_out' then (
        select pr.job_code
        from movements m
        join projects pr on pr.id = m.project_id
        where m.package_id = v_id and m.event = 'checked_out'
        order by m.created_at desc
        limit 1
      ) end
    ));
  end loop;

  return jsonb_build_object(
    'staged', v_staged,
    -- The job this batch was FOR, by its code — the name a foreman uses for a
    -- shelf ("BLACK22's shelf"), not the address on the label. `bay` carries
    -- the address for anyone who needs to walk to it.
    'job', (select pr.job_code from projects pr where pr.id = p_project),
    'bay', (select l.address from locations l where l.id = v_bay),
    'refused', v_refused
  );
end;
$$;

-- No grant needed, and none is given on purpose: every function in this family
-- (store_packages, checkout_packages, stage_packages, move_container) relies on
-- the default EXECUTE that Postgres gives PUBLIC, and re-checks auth.uid() in
-- its own body. Adding a grant here and nowhere else would read as though the
-- others were missing one.
