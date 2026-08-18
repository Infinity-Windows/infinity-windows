-- A queued check-in can no longer undo a newer checkout (warehouse audit F2).
--
-- THE BUG. `store_packages` sets status = 'stored' and container_id without
-- ever asking what the package's state IS at the moment the write lands, and
-- 'checked_out' is in its eligible list. So a check-in that sat on a phone in
-- a conex for ten minutes beats a checkout somebody made one minute ago: the
-- package is recorded back in the conex while an installer is driving away
-- with it, and nobody anywhere is told. The count comes back, the queue
-- deletes the entry, and the record now lies about where the material is.
--
-- THE RULE, decided by the owner: the newer action wins. A queued check-in
-- that lost the race is DROPPED and REPORTED. It is never applied on top —
-- applying it anyway is the bug with extra steps.
--
-- HOW. The phone writes down what it believed about each package at the
-- moment the person ticked it — that package's status and the container it
-- was in — and sends that note with the write. This function compares the
-- note against the row PER PACKAGE, in the same statement that writes it, and
-- applies only the packages whose note still matches. Everything else comes
-- back named, so the app can tell a human which package didn't go in and what
-- beat it to the punch.
--
-- WHY AN OVERLOAD, and what an out-of-date phone does. The old two-argument
-- `store_packages(uuid[], uuid) returns int` is left EXACTLY as it is, not
-- touched, not dropped. Two reasons:
--
--   1. A phone still running the old bundle physically cannot send a note.
--      The only alternatives were to keep today's behavior for it, or to fail
--      every check-in made from a phone that hasn't reloaded. Breaking the
--      warehouse for anyone mid-deploy is worse than a rare race that has
--      been live since August 14. So it keeps working, unchanged and quietly,
--      until that phone picks up the new bundle. This is a deliberate choice
--      to fail SOFT for the deploy window.
--
--   2. A check-in sent live, online, is the common case, and it still calls
--      the two-argument version — same one round trip, same answer, not a
--      byte slower. The note exists to answer "is this still true after
--      sitting in a queue", and a write that never sat in a queue has nothing
--      to compare against.
--
-- PostgREST picks between the two by the exact set of argument names in the
-- body: {p_packages, p_container} reaches the old one, {p_packages,
-- p_container, p_expected} reaches this one. `p_expected` deliberately has NO
-- default — a default would make the two-argument call ambiguous and break
-- every check-in in the app.
--
-- Nothing here alters a table, a constraint or a policy, so it is safe
-- against a production database that is already full of rows.

create or replace function store_packages(
  p_packages uuid[],
  p_container uuid,
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
  v_id uuid;
  v_status text;
  v_container uuid;
  v_location uuid;
  v_serial text;
  v_note jsonb;
  v_exp_status text;
  v_exp_container uuid;
  v_hit int;
  v_stored int := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
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

    -- Already sitting exactly where this check-in was sending it. That is
    -- this same write arriving a second time — the answer to the first one
    -- got lost, or a foreman pressed Try again after another package in the
    -- batch was refused. It is done. Counting it and writing NO movement row
    -- keeps the history honest about how many times the package moved, and
    -- makes the whole call safe to send again.
    if v_status = 'stored' and v_container is not distinct from p_container then
      v_stored := v_stored + 1;
      continue;
    end if;

    v_note := coalesce(p_expected, '{}'::jsonb) -> v_id::text;
    v_exp_status := v_note ->> 'status';
    v_exp_container := nullif(v_note ->> 'container', '')::uuid;

    -- Apply only what the phone can vouch for. Three ways to fall out of this
    -- and every one of them ends up reported rather than skipped:
    --   * there is no such package;
    --   * the note has nothing for it, so we cannot tell whether it is still
    --     true (this is what a check-in queued by an older bundle looks like);
    --   * the note says it was a blank sticker, which was never storable —
    --     the old version skipped that one in silence, which is exactly the
    --     habit this migration exists to break.
    if v_status is not null
       and v_exp_status is not null
       and v_exp_status in ('received', 'stored', 'checked_out')
    then
      -- The compare and the write are ONE statement on purpose. Reading the
      -- row first and updating after leaves a gap another actor fits inside;
      -- putting the note in the WHERE clause makes the database do the
      -- comparing, against the row as it stands at the instant of the write.
      --
      -- location_id is cleared because a package in a container is not also
      -- on a shelf — `packages_one_place_ck` says so, and a package that was
      -- set aside on a job's bay is a real, everyday check-in candidate.
      update packages
      set status = 'stored',
          container_id = p_container,
          location_id = null
      where id = v_id
        and status = v_exp_status
        and container_id is not distinct from v_exp_container;
      get diagnostics v_hit = row_count;

      if v_hit = 1 then
        -- The previous container is v_exp_container and not a fresh read:
        -- the update only touched the row BECAUSE the two matched, so the
        -- note is the proven old value. Same movement row the old version
        -- wrote, so history reads identically for every check-in that lands.
        insert into movements (package_id, event, from_container_id, to_container_id, actor)
        values (
          v_id,
          case when v_exp_container is null then 'stored' else 'moved' end,
          v_exp_container,
          p_container,
          auth.uid()::text
        );
        v_stored := v_stored + 1;
        continue;
      end if;

      -- The note matched a moment ago and does not now: somebody wrote to
      -- this row between the read at the top of the loop and the update.
      -- Re-read so the refusal names what is actually true.
      select p.status, p.container_id, p.location_id, p.serial
        into v_status, v_container, v_location, v_serial
      from packages p
      where p.id = v_id;
    end if;

    -- Refused. Say which package and what beat it, in facts the app can turn
    -- into a sentence: the serial a person reads off the sticker, the state
    -- the package is really in, the container it is really in, and — when it
    -- was checked out — the job it went to.
    v_refused := v_refused || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'serial', v_serial,
      'status', v_status,
      'container', (
        select c.name from storage_containers c where c.id = v_container
      ),
      -- The shelf, when the package went onto a job's bay instead. Its sibling
      -- (stage_packages) has always sent this, and the app has a sentence
      -- ready for it — "it is on shelf J-BLACK22-A now" — which was
      -- unreachable for check-ins because this key was never here. That is
      -- the very case F3 made likely: set-aside became queueable, so a
      -- check-in now loses to a set-aside far more often than it used to.
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
    'stored', v_stored,
    'container', (select c.name from storage_containers c where c.id = p_container),
    'refused', v_refused
  );
end;
$$;

-- No grant needed, and none is given on purpose: every function in this
-- family (store_packages, checkout_packages, stage_packages, move_container)
-- relies on the default EXECUTE that Postgres gives PUBLIC, and re-checks
-- auth.uid() in its own body. Adding a grant here and nowhere else would read
-- as though the others were missing one.

-- ---------------------------------------------------------------------------
-- The ONLINE path had a crash the queued one did not (found by review).
--
-- packages_one_place_ck says a package is in a container OR at a shelf, never
-- both. The two-argument store_packages sets container_id and never clears
-- location_id — so checking a package back in off a job's staging bay, with
-- signal, violated the constraint and failed the whole call. The SAME tap with
-- no signal worked, because the queued path goes through the three-argument
-- version above, which clears it.
--
-- Two pieces of live copy promise the thing that crashed: "Still ours, still
-- on hand — check one back into a conex any time" on the set-aside screen, and
-- "Reversible — checking one back into a conex just re-stores it" in
-- 20260827's own header. They were true offline and false online.
--
-- This predates the branch (it arrived with staging on 20260827), but the
-- branch touched this function and would have shipped the two halves
-- disagreeing. Fixed here, in the same file that fixed its sibling, so the two
-- versions read the same way. Nothing else about the two-argument version
-- changes: same signature, same return type, same eligible statuses, same
-- movement rows — so every caller and every stale phone keeps working.
create or replace function store_packages(p_packages uuid[], p_container uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_prev uuid;
  v_prev_loc uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select container_id, location_id into v_prev, v_prev_loc
    from packages
    where id = v_id and status in ('received', 'stored', 'checked_out');
    if not found then
      continue; -- blank stickers can't be stored
    end if;

    update packages
    set status = 'stored', container_id = p_container, location_id = null
    where id = v_id;

    -- from_location_id carries the shelf it came off, so a package moving from
    -- a job's bay into a conex leaves a trail that says where it was. Without
    -- it the bay simply vanishes from the history.
    insert into movements (
      package_id, event, from_container_id, from_location_id, to_container_id, actor
    )
    values (
      v_id,
      case when v_prev is null and v_prev_loc is null then 'stored' else 'moved' end,
      v_prev,
      v_prev_loc,
      p_container,
      auth.uid()::text
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
