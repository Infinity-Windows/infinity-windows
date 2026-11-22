-- The Unit Builder feeds the tables the rest of the app already reads.
--
-- Matt, 2026-11-20: "Our unit builder, and the add placeholder units is the way
-- we will add units from now on. but we do want it to be feeding existing data
-- tables".
--
-- WHAT WAS WRONG. A unit saved through the builder keeps its type and size on
-- its own row (project_openings.unit_details, 20261130060000). Everything
-- older reads a unit's type and size from its MARK's spec (project_mark_specs,
-- keyed by mark_base(opening_code)): the unit sheet, the schedule list, the 3D
-- map, and the "62 openings · 34 windows · 8 doors" line on the job header.
-- So a job built entirely in the builder read "62 openings" and nothing else,
-- every unit in the unknown bucket, and a curtain wall (a unit type since
-- 20261130100000) had nowhere to be counted at all.
--
-- WHAT THIS DOES, in the order the parts depend on each other:
--
--   1. project_mark_specs.unit_kind may say 'curtain_wall'.
--   2. A trigger on project_openings copies what a unit knows about itself
--      into its mark's spec row — creating the row when the mark has none,
--      and otherwise filling ONLY what is blank.
--   3. project_scope_counts lets a unit's own kind win over its mark's, and
--      gains one column at the end, curtain_walls.
--   4. The units that already carry details are fed once, here.
--
-- THE ONE RULE THE FEED LIVES BY. A spec is shared by every unit of a mark:
-- "1-1" through "1-40" all read mark "1". One unit's details are therefore
-- evidence about the mark, never authority over it. The feed never overwrites
-- a value that is already there, never touches a spec a foreman has confirmed,
-- and never changes where an existing row says it came from. The unit's own
-- answer still wins ON THAT UNIT, because the app and the counts view read
-- unit_details first.
--
-- The app needs nothing from this to keep working and nothing here needs the
-- app: the feed is a trigger, and the view keeps every column it had, same
-- name, type and order. Showing curtain walls on the header is a later app
-- change that must guard the new column with isMissingColumn.
--
-- IDEMPOTENT: or-replace, drop-if-exists, and a fill that only ever writes
-- into blanks, so running it twice changes nothing the second time.

-- ---------------------------------------------------------------------------
-- 1. A mark can be a curtain wall
-- ---------------------------------------------------------------------------
--
-- save_unit_details has accepted 'curtain_wall' since 20261130100000; the spec
-- column still refused it (20260980000000), so feeding one would have failed
-- the check. Widening only: every row that passed the old check passes this
-- one. door_kind's own check is untouched — it already requires unit_kind =
-- 'door', so a curtain wall can never carry a door kind.

alter table public.project_mark_specs
  drop constraint if exists project_mark_specs_unit_kind_check;
alter table public.project_mark_specs
  add constraint project_mark_specs_unit_kind_check
  check (unit_kind is null or unit_kind in ('window', 'door', 'curtain_wall'));

comment on column public.project_mark_specs.unit_kind is
  'window | door | curtain_wall | null. Written by the classifier (app/src/lib/install/specKinds.mjs) at the app''s specs write paths, by add_field_unit, and by the Unit Builder feed (feed_mark_spec_from_unit, 20261130140000), which only ever fills a blank. Null means nobody has said - project_scope_counts keeps those in their own bucket rather than guessing.';

-- ---------------------------------------------------------------------------
-- 2. The feed
-- ---------------------------------------------------------------------------

-- Inches out of a jsonb value, or null. unit_details is written by the app as
-- numbers, but nothing at the table says so (the only check is "is an
-- object", and save_unit_details does not look at width or height at all) —
-- so a string, a boolean or a null can be sitting there. A cast that raises here
-- would fail somebody's save of a unit over a size the spec feed merely
-- wanted to copy. plpgsql and not a SQL case-expression, so the cast is only
-- ever reached by a value that has already been shown to be a number.
create or replace function public.unit_detail_inches(p_value jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text;
  v_n numeric;
begin
  if p_value is null then
    return null;
  end if;
  if jsonb_typeof(p_value) = 'number' then
    v_n := (p_value #>> '{}')::numeric;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := btrim(p_value #>> '{}');
    if v_text !~ '^[0-9]{1,5}(\.[0-9]{1,6})?$' then
      return null;
    end if;
    v_n := v_text::numeric;
  else
    return null;
  end if;
  -- Zero and negatives are "not measured"; a thousand feet is a typo. Neither
  -- belongs on the record a purchase order is cut from.
  if v_n <= 0 or v_n >= 10000 then
    return null;
  end if;
  return v_n;
end;
$$;

revoke all on function public.unit_detail_inches(jsonb) from public, anon, authenticated;

-- One unit's details, offered to its mark's spec.
--
-- Takes the four values rather than a row so the trigger and the backfill at
-- the end of this file run exactly the same rules.
--
-- SEARCH PATH IS `public`, NOT EMPTY, and that is load-bearing. Writing a spec
-- fires project_mark_specs_sync_mark (20260822000000), whose function
-- sync_project_mark() names `project_marks` unqualified and pins no path of
-- its own, so it resolves names on whatever path its caller is running with.
-- Called from a function pinned to '' — as save_unit_details is — it would
-- not find the table. add_field_unit, the other SQL writer of specs, pins
-- `public` for the same reason.
--
-- NOT security definer itself: nobody may call it (execute is revoked from
-- every client role), and its two callers — the definer trigger function
-- below and this migration — already run as the owner.
create or replace function public.feed_mark_spec_from_unit(
  p_project uuid,
  p_code text,
  p_details jsonb,
  p_removed_at timestamptz
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mark text;
  v_kind text;
  v_basis text;
  v_width numeric;
  v_height numeric;
  v_operation text;
  v_material text;
  v_spec project_mark_specs%rowtype;
begin
  -- Nothing to say, or nobody to say it about. A removed unit is off the job.
  -- A placeholder is "there is a window here, number unknown": its code is a
  -- stand-in, not a mark (unitSourceMark in the app returns null for one), so
  -- a spec written under it would be a row keyed to a name that will change.
  if p_project is null
     or p_removed_at is not null
     or p_details is null
     or jsonb_typeof(p_details) <> 'object'
     or p_details = '{}'::jsonb
     or p_details ->> 'placeholder' = 'true' then
    return;
  end if;

  -- A unit whose NUMBER was changed remembers the mark it was drawn as
  -- (sourceMark, written by UnitDetails.tsx and JobUnitBuilderForm.tsx), and
  -- that is the mark its spec belongs to: "1-12" renumbered to "301" is still
  -- a mark-1 window. Without it, the unit's own code is the mark's instance.
  v_mark := public.mark_base(coalesce(
    nullif(btrim(case when jsonb_typeof(p_details -> 'sourceMark') = 'string'
                      then p_details ->> 'sourceMark' end), ''),
    p_code));
  if coalesce(v_mark, '') = '' then
    return;
  end if;

  v_kind := case when p_details ->> 'kind' in ('window', 'door', 'curtain_wall')
                 then p_details ->> 'kind' end;

  -- A ROUGH OPENING IS NOT THE UNIT'S SIZE. basis 'rough' is the hole in the
  -- wall; spec width_in/height_in are the unit that goes in it, and the glass
  -- is ordered off them. Only an outside-frame measurement ('unit') or the
  -- drawing's own dimension ('drawing') is the same kind of number. No basis
  -- at all is "nobody said which", and that is not good enough to order from.
  v_basis := p_details ->> 'basis';
  if v_basis in ('unit', 'drawing') then
    v_width := public.unit_detail_inches(p_details -> 'width');
    v_height := public.unit_detail_inches(p_details -> 'height');
  end if;

  v_operation := case when jsonb_typeof(p_details -> 'configuration') = 'string'
                      then nullif(btrim(p_details ->> 'configuration'), '') end;
  -- The unit sheet already falls back to spec.extra.material when the unit has
  -- no material of its own (UnitDetails.tsx), so that is where it goes.
  v_material := case when jsonb_typeof(p_details -> 'material') = 'string'
                     then nullif(btrim(p_details ->> 'material'), '') end;

  -- Details that say nothing a spec holds (a floor, a face, an inset) make no
  -- row: an empty 'field' spec would show up in the schedule as a mark with
  -- nothing known about it.
  if v_kind is null and v_width is null and v_height is null
     and v_operation is null and v_material is null then
    return;
  end if;

  -- Twice at most. The second pass is for two people saving the first two
  -- units of a new mark in the same second: both find no spec, one insert
  -- wins, and the other comes back round to fill whatever is still blank
  -- instead of meeting a duplicate key.
  for v_pass in 1..2 loop
    -- The same row the sheet and the counts view would pick: matched without
    -- regard to case (indexSpecsByMark upper-cases both sides), confirmed
    -- before draft, then most recently touched. Locked, so two units of one
    -- mark saved together fill it one after the other.
    select ms.* into v_spec
      from project_mark_specs ms
     where ms.project_id = p_project
       and upper(ms.mark_code) = upper(v_mark)
     order by ms.confirmed desc, ms.updated_at desc
     limit 1
       for update;

    if found then
      -- A foreman has signed this one off. It is right until a foreman says
      -- otherwise, blanks included: an empty size on a confirmed spec may be
      -- the foreman's answer.
      if coalesce(v_spec.confirmed, false) then
        return;
      end if;

      -- FILL, NEVER OVERWRITE. Every column keeps its value when it has one.
      -- source and confirmed are not in the list at all: filling a blank on
      -- the extractor's draft does not make it a field row or a reviewed one.
      -- The trailing condition keeps a save that has nothing to add from
      -- touching the row, so updated_at (which decides which duplicate the
      -- sheet shows) and the realtime feed only move when something changed.
      update project_mark_specs ms
         set unit_kind = coalesce(ms.unit_kind, v_kind),
             -- unit_kind blank means door_kind is blank too (its check says
             -- so). A door nobody has classified is 'other', the same answer
             -- add_field_unit gives and the header prints as "not stated".
             door_kind = case when ms.unit_kind is null and v_kind = 'door'
                              then 'other' else ms.door_kind end,
             width_in = coalesce(ms.width_in, v_width),
             height_in = coalesce(ms.height_in, v_height),
             operation = case when nullif(btrim(ms.operation), '') is null
                              then coalesce(v_operation, ms.operation)
                              else ms.operation end,
             -- Merge the one key; every other key in the blob is somebody
             -- else's (20260828000000).
             extra = case when v_material is not null
                               and jsonb_typeof(ms.extra) = 'object'
                               and ms.extra ->> 'material' is null
                          then ms.extra || jsonb_build_object('material', v_material)
                          else ms.extra end
       where ms.id = v_spec.id
         and coalesce(ms.confirmed, false) = false
         and (
           (ms.unit_kind is null and v_kind is not null)
           or (ms.width_in is null and v_width is not null)
           or (ms.height_in is null and v_height is not null)
           or (nullif(btrim(ms.operation), '') is null and v_operation is not null)
           or (v_material is not null
               and jsonb_typeof(ms.extra) = 'object'
               and ms.extra ->> 'material' is null)
         );
      return;
    end if;

    -- Nobody has described this mark. 'field' is the provenance for "a person
    -- on the job said so" (20260977000000), and it arrives unconfirmed like
    -- every other draft, for a foreman to review.
    insert into project_mark_specs (
      project_id, mark_code, unit_kind, door_kind,
      width_in, height_in, operation, extra, source, confirmed
    ) values (
      p_project, v_mark, v_kind, case when v_kind = 'door' then 'other' end,
      v_width, v_height, v_operation,
      case when v_material is not null
           then jsonb_build_object('material', v_material)
           else '{}'::jsonb end,
      'field', false
    )
    on conflict (project_id, mark_code) do nothing;
    if found then
      return;
    end if;
  end loop;
end;
$$;

comment on function public.feed_mark_spec_from_unit(uuid, text, jsonb, timestamptz) is
  'Offers one unit''s own details (project_openings.unit_details) to its mark''s spec: creates a source=field, unconfirmed row when the mark has none, otherwise fills only blank columns. Never overwrites a value, never touches a confirmed spec, never changes source or confirmed on an existing row. Called by the feed_mark_spec_from_unit trigger and nothing else.';

revoke all on function public.feed_mark_spec_from_unit(uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;

-- SECURITY DEFINER because the person saving a unit is often not allowed to
-- write a spec: project_mark_specs is foreman+ for insert and update
-- (mark_specs_insert_foreman / _update_foreman), and an installer may correct
-- a unit's details. The rules above are what make that safe — an installer's
-- save can add a draft or fill a blank, which is what add_field_unit already
-- lets anyone on the clock do, and can never change a value a foreman set.
--
-- A SAVE OF A UNIT MUST NEVER FAIL BECAUSE OF THIS. The feed is a courtesy to
-- the older screens; the unit's own row is the record. So anything the feed
-- trips over is logged and swallowed, and the save commits. (`when others`
-- does not catch a cancelled query, so a statement timeout still stops.)
--
-- It cannot recurse and it does not trip the guards on either table: it never
-- writes project_openings, so guard_opening_create_delete and its
-- app.field_unit_add escape hatch are not involved and that setting is left
-- exactly as save_unit_details restored it; the spec triggers it fires write
-- updated_at and project_marks, neither of which leads back here. The test
-- login fence (guard_test_account_sandbox_only) still applies to the spec
-- write, by design — auth.uid() is still the person who saved the unit, and a
-- QA login could only have saved a unit on a sandbox job in the first place.
create or replace function public.trg_feed_mark_spec_from_unit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- `update of` fires whenever the column is NAMED in the statement, changed
  -- or not, so a write that restates the same code and details ends here.
  if tg_op = 'UPDATE'
     and new.opening_code is not distinct from old.opening_code
     and new.unit_details is not distinct from old.unit_details then
    return new;
  end if;

  begin
    perform public.feed_mark_spec_from_unit(
      new.project_id, new.opening_code, new.unit_details, new.removed_at);
  exception when others then
    raise warning 'unit builder spec feed skipped for opening %: % %',
      new.id, sqlstate, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.trg_feed_mark_spec_from_unit()
  from public, anon, authenticated;

-- AFTER, so it sees the row every BEFORE trigger and guard has already let
-- through, and so a refused write feeds nothing. The WHEN keeps every row
-- with empty details — which is every unit the planset extractor wrote and
-- nobody has edited — from ever entering the function.
drop trigger if exists feed_mark_spec_from_unit on public.project_openings;
create trigger feed_mark_spec_from_unit
  after insert or update of unit_details, opening_code on public.project_openings
  for each row
  when (new.unit_details is not null and new.unit_details <> '{}'::jsonb)
  execute function public.trg_feed_mark_spec_from_unit();

-- ---------------------------------------------------------------------------
-- 3. The counts: a unit's own kind wins
-- ---------------------------------------------------------------------------
--
-- Everything 20260980000000 says about this view still holds — read its part
-- 3 for why it is SECURITY INVOKER and why the spec join is LATERAL. Three
-- things change:
--
--   * EFFECTIVE KIND = the unit's own (unit_details.kind), else its mark's
--     (spec.unit_kind). The unit sheet has resolved it in that order since the
--     builder shipped; the header now agrees with the sheet. A value outside
--     the three kinds counts as unknown, so the parts still add up:
--     windows + doors + curtain_walls + unknown_units = openings.
--   * DOOR KINDS still come from the spec — the builder does not ask which
--     kind of door — but only count when the effective kind is 'door'. A unit
--     somebody has said is a window, on a mark the paperwork calls a slider,
--     is not a slider.
--   * The spec is looked up by the unit's sourceMark when it has one, the
--     same mark the feed above writes to and the sheet reads from. Only a
--     unit whose number was changed in the builder carries one, so no row
--     that existed before the builder is looked up any differently.
--
-- `create or replace`, not drop-and-create: Postgres lets a replaced view keep
-- its columns and append new ones, so every existing column below has the
-- name, type (bigint counts) and position it had, and curtain_walls is LAST.
-- Do not reorder them and do not insert one in the middle; the replace will
-- be refused. The app selects columns by name and does not ask for the new
-- one yet.
--
-- REMOVED UNITS: the view has never filtered on removed_at and still does
-- not. What keeps a removed unit out of the header is row security, not this
-- query: openings_select_live (20260730210000, restated by 20260950000000)
-- shows a signed-in person only rows where removed_at is null, and the view
-- reads as that person. So nobody using the app has ever had a removed unit
-- counted, while a reader that bypasses row security (the service key) sees
-- them included. Both halves of that are unchanged here — adding a filter
-- would have been a second, silent change to what the service key reads.

create or replace view public.project_scope_counts
  with (security_invoker = true)
as
select
  p.id                                                                  as project_id,
  count(o.id)                                                           as openings,
  count(o.id) filter (where o.status = 'installed')                     as installed,
  count(o.id) filter (where k.kind = 'window')                          as windows,
  count(o.id) filter (where k.kind = 'door')                            as doors,
  count(o.id) filter (where k.kind = 'door' and s.door_kind = 'slider') as door_sliders,
  count(o.id) filter (where k.kind = 'door' and s.door_kind = 'french') as door_french,
  count(o.id) filter (where k.kind = 'door' and s.door_kind = 'bifold') as door_bifold,
  count(o.id) filter (where k.kind = 'door' and s.door_kind = 'swing')  as door_swing,
  count(o.id) filter (where k.kind = 'door' and s.door_kind = 'other')  as door_other,
  count(o.id) filter (
    where k.kind is null
       or k.kind not in ('window', 'door', 'curtain_wall'))             as unknown_units,
  count(o.id) filter (where k.kind = 'curtain_wall')                    as curtain_walls
from public.projects p
left join public.project_openings o
  on o.project_id = p.id
left join lateral (
  select ms.unit_kind, ms.door_kind
    from public.project_mark_specs ms
   where ms.project_id = p.id
     and upper(ms.mark_code) = upper(public.mark_base(coalesce(
           nullif(btrim(o.unit_details ->> 'sourceMark'), ''),
           o.opening_code)))
   order by ms.confirmed desc, ms.updated_at desc
   limit 1
) s on true
-- Always exactly one row, so it never drops a job or an opening.
cross join lateral (
  select coalesce(nullif(o.unit_details ->> 'kind', ''), s.unit_kind) as kind
) k
group by p.id;

comment on view public.project_scope_counts is
  'One row per job: openings, installed, windows, doors, doors by kind, units of unknown kind, and curtain walls. A unit''s own kind (unit_details.kind) wins over its mark''s spec; door kinds come from the spec and count only for a unit that is a door. SECURITY INVOKER - counts are computed under the reader''s own RLS, so a hidden job cannot show up as a number. Retires the whole-table project_openings pull the job cards used to do.';

-- A replaced view keeps its grants; restated so this file says who reads it.
revoke all on public.project_scope_counts from public, anon;
grant select on public.project_scope_counts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The units that already have details
-- ---------------------------------------------------------------------------
--
-- The trigger only hears about saves from now on, and the builder has been
-- writing units since 20261130060000. Each of them is offered to its mark
-- through the same function the trigger calls, so the backfill cannot hold
-- different rules from the live path.
--
-- SAFE ON THE LIVE TABLE: it only reads project_openings (no row there is
-- written, so no other trigger fires and nobody's save waits on it); what it
-- writes is spec rows under the fill-only rules, one mark at a time; and a
-- unit it cannot feed is logged and skipped rather than failing the deploy
-- over one odd row. A fixed order, so that when two units of one mark
-- disagree about a blank, every run and every database picks the same one.
do $$
declare
  r record;
  v_seen int := 0;
begin
  for r in
    select o.id, o.project_id, o.opening_code, o.unit_details, o.removed_at
      from public.project_openings o
     where o.removed_at is null
       and o.unit_details is not null
       and o.unit_details <> '{}'::jsonb
     order by o.project_id, o.opening_code, o.id
  loop
    begin
      perform public.feed_mark_spec_from_unit(
        r.project_id, r.opening_code, r.unit_details, r.removed_at);
    exception when others then
      raise warning 'unit builder spec backfill skipped opening %: % %',
        r.id, sqlstate, sqlerrm;
    end;
    v_seen := v_seen + 1;
  end loop;
  raise notice 'unit builder spec backfill: % unit(s) with details offered to their mark specs', v_seen;
end;
$$;
