-- A storefront is a unit type (Ammon, 2026-11-22: add "Store Front" to the
-- type when building a unit).
--
-- The list of unit types lives in four places in the database, and a type that
-- is in some of them and not the others half works: the unit saves and then is
-- counted as "unknown", or its mark's spec refuses the kind. So all four move
-- together, each restated in full from where it was last defined with only
-- the list changed:
--
--   1. project_mark_specs.unit_kind may say 'storefront' (was 20261130140000).
--   2. save_unit_details accepts it (was 20261130170000).
--   3. feed_mark_spec_from_unit offers it to the mark's spec (was 20261130140000).
--   4. project_scope_counts stops counting it as unknown and gains one column
--      at the END, storefronts (was 20261130140000). Every existing column
--      keeps its name, type and position, which `create or replace view`
--      requires; the app asks for the new one behind isMissingColumn.
--
-- app/src/lib/install/unitDetails.ts (UNIT_KINDS) holds the same list.
--
-- Widening only: every value accepted before is accepted now, no row is
-- rewritten, and running it twice changes nothing the second time.

alter table public.project_mark_specs
  drop constraint if exists project_mark_specs_unit_kind_check;
alter table public.project_mark_specs
  add constraint project_mark_specs_unit_kind_check
  check (unit_kind is null or unit_kind in ('window', 'door', 'curtain_wall', 'storefront'));

comment on column public.project_mark_specs.unit_kind is
  'window | door | curtain_wall | storefront | null. Written by the classifier (app/src/lib/install/specKinds.mjs) at the app''s specs write paths, by add_field_unit, and by the Unit Builder feed (feed_mark_spec_from_unit), which only ever fills a blank. Null means nobody has said - project_scope_counts keeps those in their own bucket rather than guessing.';

create or replace function public.save_unit_details(
  p_project uuid, p_opening uuid, p_create boolean, p_code text,
  p_details jsonb, p_previous_code text, p_previous_details jsonb,
  p_edit_id uuid, p_reason text default null
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  current_unit public.project_openings%rowtype;
  created boolean := false;
  builder boolean := coalesce(public.is_foreman_plus(auth.uid()), false);
  previous_field_add text := coalesce(current_setting('app.field_unit_add', true), '');
begin
  if not coalesce(public.custom_work_internal(), false)
     or not exists (select 1 from public.projects where id = p_project) then
    raise exception 'This job is unavailable.' using errcode = '42501';
  end if;

  if p_edit_id is null or length(btrim(p_reason)) > 500 then
    raise exception 'The edit reason must be 500 characters or fewer.' using errcode = '22023';
  end if;

  if p_create is null or nullif(btrim(p_code), '') is null
     or jsonb_typeof(p_details) is distinct from 'object'
     or (p_details->>'floor' is not null and p_details->>'floor' !~ '^-?[0-9]{1,3}$')
     -- Curtain walls (2026-11-20) and storefronts (2026-11-22) are units too;
     -- app/src/lib/install/unitDetails.ts holds the same list.
     or (p_details->>'kind' is not null and p_details->>'kind' not in ('window', 'door', 'curtain_wall', 'storefront'))
     or (p_details->>'inset' is not null and p_details->>'inset' not in ('inset', 'outset', 'unknown'))
     or (p_details->>'basis' is not null and p_details->>'basis' not in ('unit', 'rough', 'drawing'))
     or (p_create and p_details->'placeholder' is distinct from 'true'::jsonb
         and (not builder or p_details->'placeholder' is distinct from 'false'::jsonb))
     or ((p_create or p_previous_details->'placeholder' = 'true'::jsonb)
         and p_details->'placeholder' = 'false'::jsonb and p_details->>'kind' is null)
     or (p_details ? 'builderDeferred' and (
         jsonb_typeof(p_details->'builderDeferred') <> 'boolean'
         or p_details->'placeholder' is distinct from 'true'::jsonb))
     or (p_create and p_details ? 'builderDeferred' and not builder)
     or (p_details->>'placeholder' = 'true' and p_details->>'kind' is null) then
    raise exception 'Enter a unit number and type. Floor, if provided, must be a whole number.' using errcode = '22023';
  end if;

  perform set_config('forge.unit_detail_edit_id', p_edit_id::text, true);
  perform set_config('forge.unit_detail_edit_reason', coalesce(btrim(p_reason), ''), true);

  if p_create then
    -- Preserve field-created openings on re-extraction. A new placeholder
    -- carries no pin, planset, type catalog row, or manufactured dimensions.
    -- Use the existing one-opening guard escape hatch only after checking
    -- internal access, job visibility, and the placeholder's required fields.
    -- Restore it immediately so this RPC cannot authorize later inserts.
    perform set_config('app.field_unit_add', 'on', true);
    insert into public.project_openings (id, project_id, opening_code, unit_details, field_added)
    values (p_opening, p_project, btrim(p_code), p_details, true)
    on conflict (id) do nothing;
    created := found;
    perform set_config('app.field_unit_add', previous_field_add, true);
  end if;

  select * into current_unit from public.project_openings
  where id = p_opening and project_id = p_project and removed_at is null for update;
  if not found then
    raise exception 'This unit is unavailable.' using errcode = '42501';
  end if;
  -- Check receipts while holding the opening lock. A retry may arrive after
  -- somebody else has already edited the unit again.
  if created or exists (
    select 1 from public.unit_detail_edit_history
    where edit_id = p_edit_id and opening_id = p_opening and actor_id = auth.uid()
  ) or (current_unit.opening_code = btrim(p_code) and current_unit.unit_details = p_details) then
    perform set_config('forge.unit_detail_edit_id', '', true);
    return created;
  end if;
  if p_create or current_unit.opening_code is distinct from p_previous_code
      or current_unit.unit_details is distinct from p_previous_details then
    raise exception 'This unit changed elsewhere. Reload before editing again.' using errcode = '22023';
  end if;

  if current_unit.unit_details->'placeholder' is distinct from p_details->'placeholder'
     and not (builder and current_unit.unit_details->'placeholder' is not distinct from 'true'::jsonb
       and p_details->'placeholder' is not distinct from 'false'::jsonb) then
    raise exception 'Only a foreman or above can confirm a placeholder.' using errcode = '42501';
  end if;
  if current_unit.unit_details->'builderDeferred' is distinct from p_details->'builderDeferred'
     and not builder then
    raise exception 'Only a foreman or above can review a placeholder.' using errcode = '42501';
  end if;

  update public.project_openings
  set opening_code = btrim(p_code), unit_details = p_details
  where id = current_unit.id and project_id = p_project;
  perform set_config('forge.unit_detail_edit_id', '', true);
  return true;
end;
$$;

-- Restated from 20261130140000; read that file for why the search path is
-- `public` and why this is not security definer. Only the list of kinds differs.
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

  v_kind := case when p_details ->> 'kind' in ('window', 'door', 'curtain_wall', 'storefront')
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

revoke all on function public.feed_mark_spec_from_unit(uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;

-- Restated from 20261130140000; read its part 3 for the rules of this view.
-- storefronts is LAST. Do not reorder the columns or insert one in the middle;
-- the replace would be refused. The parts still add up:
-- windows + doors + curtain_walls + storefronts + unknown_units = openings.
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
       or k.kind not in ('window', 'door', 'curtain_wall', 'storefront'))             as unknown_units,
  count(o.id) filter (where k.kind = 'curtain_wall')                    as curtain_walls,
  count(o.id) filter (where k.kind = 'storefront')                      as storefronts
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
  'One row per job: openings, installed, windows, doors, doors by kind, units of unknown kind, curtain walls and storefronts. A unit''s own kind (unit_details.kind) wins over its mark''s spec; door kinds come from the spec and count only for a unit that is a door. SECURITY INVOKER - counts are computed under the reader''s own RLS, so a hidden job cannot show up as a number.';

-- A replaced view keeps its grants; restated so this file says who reads it.
revoke all on public.project_scope_counts from public, anon;
grant select on public.project_scope_counts to authenticated, service_role;
