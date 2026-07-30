-- Removing a window or door HIDES it instead of destroying it.
--
-- WHY NOW
--
-- install_events references project_openings ON DELETE CASCADE, so until today
-- "Remove" took an opening's install history with it, along with its QC checks,
-- task sessions and service cases. install_events is still EMPTY on production,
-- which makes this the cheapest possible moment to change how removal works:
-- the same change made after crews start recording installs would be surgery on
-- live history.
--
-- THE FAILURE MODE THIS IS WRITTEN AGAINST
--
-- A half-applied soft delete is worse than none, because the counts start
-- lying: "0/42 installed" keeps saying 42 after a window is removed. Finding
-- and patching every SELECT by hand does not survive the next feature — the
-- twenty-first read path gets written without the filter and nobody notices.
--
-- So hidden rows are hidden by ROW LEVEL SECURITY rather than by a filter
-- repeated twenty times. Every read the browser makes — today's and tomorrow's,
-- every list, count, dot, rollup, embed and realtime message — is filtered by
-- the database itself. What is left over is small and enumerable, and each one
-- is handled explicitly further down:
--
--   * security definer functions, which run as the owner and bypass RLS:
--       sync_project_windows_from_openings   (section 6 — the material demand
--                                             rollup, the one real aggregate)
--       list_issues                          (section 7)
--     Every other definer function reads ONE opening the caller named, by id,
--     to act on it — install, undo, claim, start, finish, measure, condition,
--     flag, assign. Those are reached from lists that no longer contain hidden
--     rows, and remove_opening below refuses to hide anything that is installed
--     or holding a unit, so none of them can be aimed at a hidden row by a
--     person. A hostile caller aiming one at a hidden id changes a row nobody
--     can see, which is the same as changing nothing.
--   * the service-role key in edge functions, which bypasses RLS: the `ask`
--     function is the only one that reads this table, and both of its reads are
--     filtered in this PR.
--
-- WHAT IS NOT A SOFT DELETE, DELIBERATELY
--
-- A re-extract still HARD deletes the unconfirmed drafts it supersedes. Those
-- are the extractor discarding its own guesses, not a person removing a window,
-- and PR #132 already guarantees it can only ever touch drafts carrying no
-- field work. Soft-deleting them would fill the "Removed" list with extraction
-- noise on every re-read of a planset. The line is: a PERSON removing a window
-- hides it; the EXTRACTOR dropping its own draft deletes it.

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
-- Who and why as well as when, because the whole point of hiding rather than
-- deleting is that somebody can ask what happened to #12.

alter table project_openings
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references profiles(id) on delete set null,
  add column if not exists removed_reason text;

comment on column project_openings.removed_at is
  'Set when a foreman removes this window or door. Non-null rows are invisible to every ordinary read (RLS) and are excluded from every count. Nothing is deleted.';

create index if not exists project_openings_live_idx
  on project_openings (project_id) where removed_at is null;

create index if not exists project_openings_removed_idx
  on project_openings (project_id, removed_at desc) where removed_at is not null;

-- ---------------------------------------------------------------------------
-- 2. The unique code, over LIVE rows only
-- ---------------------------------------------------------------------------
-- `unique (project_id, opening_code)` counted hidden rows, so a foreman who
-- removed #12 by mistake could not add #12 back — the name was still held by a
-- row they could not see. A partial unique index moves the rule to where it
-- belongs: two LIVE marks may not share a code; a hidden one holds no name.

alter table project_openings
  drop constraint if exists project_openings_project_id_opening_code_key;

create unique index if not exists project_openings_live_code_key
  on project_openings (project_id, opening_code) where removed_at is null;

-- ---------------------------------------------------------------------------
-- 3. Row level security: hidden means hidden
-- ---------------------------------------------------------------------------
-- Replaces the single `for all … using (true)` policy with one per command, so
-- SELECT can be narrowed without touching what the crew may write. UPDATE and
-- DELETE are scoped to live rows for the same reason: a row nobody can see is
-- not a row anybody may quietly edit or destroy. Putting one back therefore has
-- to go through restore_opening(), which is exactly where the foreman check and
-- the name-clash check live.

drop policy if exists "authenticated full access" on project_openings;

drop policy if exists "openings_select_live" on project_openings;
create policy "openings_select_live" on project_openings
  for select to authenticated using (removed_at is null);

drop policy if exists "openings_insert" on project_openings;
create policy "openings_insert" on project_openings
  for insert to authenticated with check (true);

drop policy if exists "openings_update_live" on project_openings;
create policy "openings_update_live" on project_openings
  for update to authenticated using (removed_at is null) with check (true);

drop policy if exists "openings_delete_live" on project_openings;
create policy "openings_delete_live" on project_openings
  for delete to authenticated using (removed_at is null);

-- ---------------------------------------------------------------------------
-- 4. Only the two functions below may hide or unhide a row
-- ---------------------------------------------------------------------------
-- Without this, `PATCH /project_openings?id=eq.…  {"removed_at": "now()"}` is a
-- delete with no name on it. Same shape as the pin-move guard from
-- 20260730160000: a session flag the trusted functions set, checked here.

create or replace function public.guard_opening_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only interested in a change to the hidden flag itself.
  if new.removed_at is not distinct from old.removed_at then
    return new;
  end if;

  -- remove_opening / restore_opening, which have already checked the role and
  -- are recording who did it.
  if coalesce(current_setting('app.opening_removal', true), '') = 'on' then
    return new;
  end if;

  -- No JWT: a migration or the service key, both already trusted above RLS.
  if auth.uid() is null then
    return new;
  end if;

  raise exception 'Use Remove or Put back to hide a window or door, so the job keeps a record of who did it.'
    using errcode = '42501';
end;
$$;

drop trigger if exists guard_opening_removal on project_openings;
create trigger guard_opening_removal
  before update of removed_at on project_openings
  for each row execute function public.guard_opening_removal();

-- ---------------------------------------------------------------------------
-- 5. Remove, and put back
-- ---------------------------------------------------------------------------

create or replace function public.remove_opening(
  p_opening_id uuid,
  p_reason text default null
)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
begin
  -- Byte-identical to the sentence the create/delete guard raises, so the app
  -- shows one wording for "you may not remove a window" however it is reached.
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can remove a window or door from a job.'
      using errcode = '42501';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;

  -- Already hidden. Replaying this is a no-op rather than an error, so a second
  -- tap or a retried request cannot turn into a scary red message.
  if v_row.removed_at is not null then
    return v_row;
  end if;

  if v_row.status = 'installed' then
    raise exception 'That window or door is already installed, so it can''t be removed. Undo the install first.'
      using errcode = '42501';
  end if;

  -- A removed opening must not go on holding a physical unit: the warehouse
  -- would have it reserved for something nobody can see, and the damage-issue
  -- dedup in unload_units/activate_preissued_unit finds an opening BY its
  -- assigned unit. Refusing here keeps both correct without touching either.
  if v_row.assigned_window_id is not null then
    raise exception 'That window or door has a unit from the warehouse against it. Take the unit off it first.'
      using errcode = '42501';
  end if;

  perform set_config('app.opening_removal', 'on', true);
  update project_openings
     set removed_at = now(),
         removed_by = auth.uid(),
         removed_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_opening_id
   returning * into v_row;
  perform set_config('app.opening_removal', 'off', true);

  return v_row;
end;
$$;

create or replace function public.restore_opening(p_opening_id uuid)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_clash text;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can put a window or door back on a job.'
      using errcode = '42501';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;

  if v_row.removed_at is null then
    return v_row;
  end if;

  -- Somebody added the code back, or a re-extract found it on the plan again.
  -- The live one wins; this one stays hidden and the foreman is told why in the
  -- words they would use themselves.
  select opening_code into v_clash
    from project_openings
   where project_id = v_row.project_id
     and opening_code = v_row.opening_code
     and removed_at is null
   limit 1;
  if v_clash is not null then
    raise exception 'There is already a #% on this job, so this one cannot come back under that name. Remove or rename the one that is there first.', v_clash
      using errcode = '23505';
  end if;

  perform set_config('app.opening_removal', 'on', true);
  update project_openings
     set removed_at = null,
         removed_by = null,
         removed_reason = null
   where id = p_opening_id
   returning * into v_row;
  perform set_config('app.opening_removal', 'off', true);

  return v_row;
end;
$$;

-- What was taken off this job, newest first. security definer because the rows
-- are invisible to an ordinary SELECT by design — this function IS the hole in
-- that wall, so it is foreman-gated like everything else here rather than
-- returning an empty list to somebody who may not look.
create or replace function public.list_removed_openings(p_project_id uuid)
returns table (
  id uuid,
  opening_code text,
  label text,
  window_type_id uuid,
  status text,
  removed_at timestamptz,
  removed_by uuid,
  removed_by_name text,
  removed_reason text,
  code_taken boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can see what was removed from a job.'
      using errcode = '42501';
  end if;

  return query
    select o.id, o.opening_code, o.label, o.window_type_id, o.status,
           o.removed_at, o.removed_by, p.display_name, o.removed_reason,
           exists (
             select 1 from project_openings live
              where live.project_id = o.project_id
                and live.opening_code = o.opening_code
                and live.removed_at is null
           )
      from project_openings o
      left join profiles p on p.id = o.removed_by
     where o.project_id = p_project_id
       and o.removed_at is not null
     order by o.removed_at desc;
end;
$$;

grant execute on function public.remove_opening(uuid, text) to authenticated;
grant execute on function public.restore_opening(uuid) to authenticated;
grant execute on function public.list_removed_openings(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The material demand rollup
-- ---------------------------------------------------------------------------
-- The one genuine aggregate over this table in the database, and the sharpest
-- way the counts could have started lying: project_windows.quantity is how many
-- of each type the job needs, and it is a count of confirmed openings. Left
-- alone it would keep ordering glass for a window nobody is going to fit.
--
-- Recreated verbatim from 20260715200000_lifecycle_unify.sql apart from the two
-- `removed_at is null` clauses.

create or replace function sync_project_windows_from_openings(p_project_id uuid)
returns void
language plpgsql
as $$
begin
  -- Drop demand rows that no longer have any confirmed typed openings.
  delete from project_windows pw
  where pw.project_id = p_project_id
    and not exists (
      select 1
      from project_openings o
      where o.project_id = p_project_id
        and o.confirmed = true
        and o.removed_at is null
        and o.window_type_id = pw.window_type_id
    );

  -- Upsert quantities from confirmed openings that have a type.
  insert into project_windows (project_id, window_type_id, quantity)
  select
    p_project_id,
    o.window_type_id,
    count(*)::int
  from project_openings o
  where o.project_id = p_project_id
    and o.confirmed = true
    and o.removed_at is null
    and o.window_type_id is not null
  group by o.window_type_id
  on conflict (project_id, window_type_id)
  do update set quantity = excluded.quantity;
end;
$$;

-- …and make hiding or restoring a mark re-run it. Without `removed_at` in this
-- column list the rollup would only catch up the next time something else about
-- the opening changed, which is the definition of a count that lies.
drop trigger if exists project_openings_sync_demand on project_openings;
create trigger project_openings_sync_demand
  after insert or delete or update of confirmed, window_type_id, project_id, removed_at
  on project_openings
  for each row
  execute function trg_sync_project_windows_from_openings();

-- ---------------------------------------------------------------------------
-- 7. Problems raised against a window that is no longer on the job
-- ---------------------------------------------------------------------------
-- `issues` outlives its opening (opening_id is ON DELETE SET NULL), so hiding a
-- window leaves its open flag or damage report sitting on the foreman's list
-- pointing at nothing. Filtered at the read rather than resolved on removal, so
-- putting the window back brings its open problems back with it — restore means
-- restore, and nothing is written away in the meantime.

drop policy if exists "authenticated full access" on issues;

drop policy if exists "issues_select_live" on issues;
create policy "issues_select_live" on issues
  for select to authenticated using (
    opening_id is null
    or exists (
      select 1 from project_openings o
      where o.id = issues.opening_id and o.removed_at is null
    )
  );

-- Deliberately three policies rather than one `for all`: permissive policies
-- are OR'd together, so a `for all using (true)` alongside the SELECT rule
-- above would hand back every hidden issue again.
drop policy if exists "issues_insert" on issues;
create policy "issues_insert" on issues
  for insert to authenticated with check (true);

drop policy if exists "issues_update" on issues;
create policy "issues_update" on issues
  for update to authenticated using (true) with check (true);

drop policy if exists "issues_delete" on issues;
create policy "issues_delete" on issues
  for delete to authenticated using (true);

-- The cross-job list is security definer, so it bypasses the policy above and
-- needs the same rule spelled out. Recreated from 20260718005000_issues.sql.
create or replace function list_issues()
returns setof issues
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    -- Reworded from 'issues are for foreman-level users and above'. Same rule,
    -- same people refused; this one is a sentence the app already knows how to
    -- show on its own, and reads like the rest of them.
    raise exception 'Only a foreman or above can see the problem list.'
      using errcode = '42501';
  end if;
  return query
    select i.* from issues i
     where i.opening_id is null
        or exists (
          select 1 from project_openings o
          where o.id = i.opening_id and o.removed_at is null
        )
     order by i.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The undo bar
-- ---------------------------------------------------------------------------
-- Pin history is kept — it is the record of what happened to that mark — but a
-- move belonging to a hidden mark must not sit in the foreman's undo stack
-- offering to put a dot back on a plan where there is no dot.

drop policy if exists "pin_moves_select_authenticated" on project_opening_pin_moves;
create policy "pin_moves_select_authenticated" on project_opening_pin_moves
  for select to authenticated using (
    exists (
      select 1 from project_openings o
      where o.id = project_opening_pin_moves.opening_id
        and o.removed_at is null
    )
  );

comment on function public.remove_opening(uuid, text) is
  'Hides a window or door instead of deleting it, keeping its install history, assignment, measurements, QC checks and photos. Foreman+.';
comment on function public.restore_opening(uuid) is
  'Puts a hidden window or door back on the job, unless its code has since been taken by a live one. Foreman+.';
