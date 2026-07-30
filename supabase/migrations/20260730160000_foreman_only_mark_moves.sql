-- Only a foreman or above may move a mark on the plan.
--
-- 20260730130000 gave the map an undo and gated undo/reset at foreman+, but
-- left the MOVE itself open: project_openings has carried a single
-- "authenticated full access" policy since 20260715120000, so any signed-in
-- crew member could PATCH pin_x/pin_y straight through PostgREST. Taylor's call
-- is that the people who can move a mark should be exactly the people who can
-- put it back.
--
-- WHY A TRIGGER AND NOT A POLICY
--
-- The rule is about a COLUMN CHANGING, and RLS cannot express that. An UPDATE
-- policy's `using` sees the old row and its `with check` sees the new one, but
-- neither can compare the two, so there is no way to write "you may update this
-- row as long as pin_x stays where it is".
--
-- Column privileges cannot do it either. Foremen and installers are the same
-- Postgres role (`authenticated`) holding different app roles in `profiles`, so
-- `revoke update (pin_x) ... from authenticated` would lock foremen out too.
--
-- A trigger can see OLD and NEW and can ask who the caller is, so that is what
-- this uses — the same shape as the two triggers 20260730130000 already put on
-- this table.
--
-- WHY THIS BREAKS NOTHING THE CREW DOES
--
-- Every write an installer legitimately makes to project_openings already goes
-- through a security-definer RPC, and not one of them touches a pin:
--
--   assign_opening_to_installer / unassign_opening  assigned_to, assigned_by,
--                                                   assigned_at, sequence
--   claim_opening / start_opening_work              work_started_at
--   finish_install / install_opening                status, confirmed,
--                                                   work_ended_at
--   set_opening_rough_opening                       ro_width_in, ro_height_in,
--                                                   ro_measured_by/_at
--   set_opening_condition                           condition, condition_note,
--                                                   condition_checked_by/_at
--   flag_opening / create_issue                     flag_note, flagged_by/_at
--   assign_window_to_opening                        assigned_window_id,
--                                                   window_type_id, status
--
-- QC lives in qc_checks and photos in attachments/storage, neither of which is
-- this table. The only things in the whole codebase that write pin_x, pin_y or
-- page_number are the map's drag, the plan editor's drag/remove, and the undo
-- and reset functions. So a guard scoped to those three columns is invisible to
-- every real field workflow.
--
-- WHAT THIS DELIBERATELY DOES NOT COVER
--
-- INSERT. Creating an opening that already has a pin is what the planset
-- extraction does ("Load marks from plans"), and that button is not yet
-- foreman-gated in the UI. Guarding inserts here would turn a visible button
-- into an error for installers, which is the exact failure this change is
-- meant to avoid. Gating extraction is a bigger, separate decision about who
-- may re-read a planset — worth making, but not silently and not here.

create or replace function public.guard_opening_pin_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the mark's POSITION is policed. An update that leaves the pin alone —
  -- which is every claim, start, finish, measurement, condition check, flag and
  -- assignment — passes straight through.
  if new.pin_x is not distinct from old.pin_x
     and new.pin_y is not distinct from old.pin_y
     and new.page_number is not distinct from old.page_number then
    return new;
  end if;

  -- Undo and the two resets already checked the caller before setting this for
  -- their transaction; asking the same question twice would only cost a lookup.
  if coalesce(current_setting('app.pin_undo', true), '') = 'on' then
    return new;
  end if;

  -- No JWT means this is not a person holding a phone: a migration, or an edge
  -- function on the service key. Both are already trusted above RLS, and the
  -- anon role cannot reach this table at all — the only policy on it is granted
  -- `to authenticated`.
  if auth.uid() is null then
    return new;
  end if;

  if not public.is_foreman_plus(auth.uid()) then
    -- Plain English, because this sentence can reach a phone: an installer on a
    -- page cached before this shipped still has a draggable dot, and the app
    -- shows what comes back from here.
    raise exception 'Only a foreman or above can move a mark on the plan.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- Fires before `seed_opening_origin_pin` (Postgres runs BEFORE row triggers in
-- name order, and g sorts before s), so a refused move never reaches the
-- origin-seeding or move-recording logic at all.
drop trigger if exists guard_opening_pin_move on project_openings;
create trigger guard_opening_pin_move
  before update of pin_x, pin_y, page_number on project_openings
  for each row execute function public.guard_opening_pin_move();

comment on function public.guard_opening_pin_move() is
  'Refuses a change to pin_x/pin_y/page_number from anyone below foreman. Scoped to those three columns so no field workflow is affected.';
