-- Job facts, reshaped after the owner's first look at the card (2026-09-07).
--
-- WHAT CHANGED AND WHY
--
--   1. exterior_lines — a house is not one finish. The front is brick and
--      outset an inch; the sides are stucco and inset an inch and a quarter;
--      the crew hits both before lunch. One exterior_finish + one set_depth
--      per job could only describe one of those, so the four columns become
--      a LIST of situations: each line is a finish, the set depth that goes
--      with it, the inch, and a note. Stored as jsonb on the same row rather
--      than a child table: the card saves the whole list on every change
--      through the offline outbox, the list is short (capped at 20), and a
--      second table would mean a second RPC, a second policy, a second
--      fence — for a value that is only ever read and written whole. Same
--      shape the plan outline's `features` already takes.
--
--   2. flashing_system_other / fastener_type_other — "Other" used to be a
--      dead end. When the pick-list does not have the system, the foreman
--      names it in a box that appears beside the list.
--
--   3. sill_pan / sill_pan_type are gone. A sill pan is a fact about one
--      unit, not a job; the per-unit spec is where that already lives.
--
--   4. elevation_notes replaces note_north / note_south / note_east /
--      note_west. One box; write "North: …" inside it if the side matters.
--
--   gc_contact_name / gc_contact_phone STAY on this row (the GC handshake
--   still seeds the name) — the owner's call was only about where they are
--   shown: on the GC card at the top of the job, not down in Job facts.
--
-- Rows in project_build_facts are hours old, so the carry-over below is
-- belt-and-braces: a single finish/set depth becomes the first line, any
-- elevation notes fold into the one box with their side written in, and a
-- sill pan already typed becomes words in the flashing note.
--
-- Same signatures on upsert_build_facts and green_light_items, so CREATE OR
-- REPLACE is enough — no overload is created (the 20260929 trap). Idempotent
-- throughout.

-- ===========================================================================
-- 1. New columns, carried-over values
-- ===========================================================================
alter table project_build_facts add column if not exists exterior_lines jsonb not null default '[]'::jsonb;
alter table project_build_facts add column if not exists flashing_system_other text;
alter table project_build_facts add column if not exists fastener_type_other text;
alter table project_build_facts add column if not exists elevation_notes text;

alter table project_build_facts drop constraint if exists project_build_facts_exterior_lines_check;
alter table project_build_facts add constraint project_build_facts_exterior_lines_check
  check (jsonb_typeof(exterior_lines) = 'array' and jsonb_array_length(exterior_lines) <= 20);

do $carry$
begin
  -- The old single answer becomes line one. Only when the columns are still
  -- there (a re-run after the drop below has nothing to carry).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'project_build_facts'
       and column_name = 'exterior_finish'
  ) then
    execute $q$
      update project_build_facts
         set exterior_lines = jsonb_build_array(jsonb_build_object(
               'exterior_finish', exterior_finish,
               'exterior_note', exterior_note,
               'set_depth', set_depth,
               'set_depth_inches', set_depth_inches))
       where exterior_lines = '[]'::jsonb
         and (exterior_finish is not null or exterior_note is not null
              or set_depth is not null or set_depth_inches is not null)
    $q$;
    -- A sill pan already typed on a real row (the owner filed one the day
    -- this shipped) folds into the flashing note as words before the
    -- columns go. Dropping the FIELD was his call; losing the VALUE was not.
    -- Guarded on the marker text so a re-run never appends it twice.
    execute $q$
      update project_build_facts
         set flashing_note = concat_ws(E'\n', nullif(btrim(coalesce(flashing_note, '')), ''),
               'Sill pan: ' || coalesce(sill_pan_type, 'type not recorded')
               || case sill_pan when 'required' then ' (required)'
                                when 'not_required' then ' (not required)'
                                else '' end)
       where (sill_pan_type is not null or sill_pan in ('required', 'not_required'))
         and coalesce(flashing_note, '') not ilike '%Sill pan:%'
    $q$;
    execute $q$
      update project_build_facts
         set elevation_notes = concat_ws(E'\n',
               case when coalesce(btrim(note_north), '') <> '' then 'North: ' || btrim(note_north) end,
               case when coalesce(btrim(note_south), '') <> '' then 'South: ' || btrim(note_south) end,
               case when coalesce(btrim(note_east), '') <> '' then 'East: ' || btrim(note_east) end,
               case when coalesce(btrim(note_west), '') <> '' then 'West: ' || btrim(note_west) end)
       where elevation_notes is null
         and (coalesce(btrim(note_north), '') <> '' or coalesce(btrim(note_south), '') <> ''
              or coalesce(btrim(note_east), '') <> '' or coalesce(btrim(note_west), '') <> '')
    $q$;
  end if;
end
$carry$;

-- ===========================================================================
-- 2. upsert_build_facts(project, patch) — same door, new columns
-- ===========================================================================
-- Same contract as 20261001000000: a flat jsonb patch of the columns being
-- changed, unknown keys refused by name, `?` so a caller can clear a field.
-- exterior_lines arrives as the WHOLE list and replaces the stored one; each
-- element is checked and re-built with exactly its four keys so a phone on a
-- stale bundle can never smuggle a fifth in.
create or replace function public.upsert_build_facts(
  p_project_id uuid,
  p_patch jsonb
)
returns project_build_facts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed constant text[] := array[
    'exterior_lines',
    'flashing_system', 'flashing_system_other', 'flashing_note',
    'fastener_type', 'fastener_type_other', 'fastener_length_in',
    'fastener_spacing_in', 'fastener_note',
    'site_rules', 'gc_contact_name', 'gc_contact_phone', 'elevation_notes'
  ];
  v_key text;
  v_line jsonb;
  v_line_key text;
  v_lines jsonb := '[]'::jsonb;
  v_exists boolean;
  v_checkin project_gc_checkins;
  v_seed jsonb := '{}'::jsonb;
  v_patch jsonb;
  v_row project_build_facts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can save job facts.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Nothing to save.';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any(v_allowed)) then
      raise exception 'Job facts has no field called "%".', v_key;
    end if;
  end loop;

  if p_patch ? 'flashing_system' and p_patch->>'flashing_system' is not null
     and p_patch->>'flashing_system' not in ('butyl_tape', 'paper_flashing', 'fluid_applied', 'other') then
    raise exception 'Flashing system is butyl tape, paper flashing, fluid-applied, or other.';
  end if;
  if p_patch ? 'fastener_type' and p_patch->>'fastener_type' is not null
     and p_patch->>'fastener_type' not in ('flange_screw', 'jamb_screw', 'concrete_screw', 'other') then
    raise exception 'Fastener type is flange screw, jamb screw, concrete screw, or other.';
  end if;

  v_patch := p_patch;

  if p_patch ? 'exterior_lines' then
    if p_patch->'exterior_lines' is null or jsonb_typeof(p_patch->'exterior_lines') <> 'array' then
      raise exception 'Exterior situations must be a list.';
    end if;
    if jsonb_array_length(p_patch->'exterior_lines') > 20 then
      raise exception 'A job can carry at most 20 exterior situations.';
    end if;
    for v_line in select * from jsonb_array_elements(p_patch->'exterior_lines') loop
      if jsonb_typeof(v_line) <> 'object' then
        raise exception 'Each exterior situation must be a finish, a set depth, an inch, and a note.';
      end if;
      for v_line_key in select jsonb_object_keys(v_line) loop
        if v_line_key not in ('exterior_finish', 'exterior_note', 'set_depth', 'set_depth_inches') then
          raise exception 'An exterior situation has no field called "%".', v_line_key;
        end if;
      end loop;
      if v_line->>'exterior_finish' is not null
         and v_line->>'exterior_finish' not in ('stucco', 'rock', 'siding', 'brick', 'other') then
        raise exception 'Exterior finish is stucco, rock, siding, brick, or other.';
      end if;
      if v_line->>'set_depth' is not null
         and v_line->>'set_depth' not in ('inset', 'outset', 'unknown') then
        raise exception 'Set depth is inset, outset, or unknown.';
      end if;
      if v_line->'set_depth_inches' is not null
         and jsonb_typeof(v_line->'set_depth_inches') not in ('number', 'null') then
        raise exception 'Set depth inches must be a number.';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'exterior_finish', v_line->>'exterior_finish',
        'exterior_note', nullif(btrim(coalesce(v_line->>'exterior_note', '')), ''),
        'set_depth', v_line->>'set_depth',
        'set_depth_inches', (v_line->>'set_depth_inches')::numeric(4,2)));
    end loop;
    v_patch := v_patch || jsonb_build_object('exterior_lines', v_lines);
  end if;

  select exists (select 1 from project_build_facts where project_id = p_project_id) into v_exists;

  if not v_exists then
    -- Seed from the GC handshake on the very first write for this job, before
    -- the caller's own patch is applied — the GC already told us the set
    -- preference and what is going on the outside. That becomes line one of
    -- the exterior situations (finish left open: "stucco" from a GC's mouth
    -- is a note, not a pick-list value), unless the caller sent lines of
    -- their own. `unknown` stays out: an "I don't know" from the GC is not a
    -- fact worth carrying forward as one.
    select * into v_checkin
      from project_gc_checkins
     where project_id = p_project_id
     order by contacted_at desc
     limit 1;

    if found then
      if (v_checkin.set_preference is not null and v_checkin.set_preference <> 'unknown')
         or coalesce(btrim(v_checkin.exterior_material), '') <> '' then
        v_seed := v_seed || jsonb_build_object('exterior_lines', jsonb_build_array(jsonb_build_object(
          'exterior_finish', null::text,
          'exterior_note', nullif(btrim(coalesce(v_checkin.exterior_material, '')), ''),
          'set_depth', case when v_checkin.set_preference <> 'unknown' then v_checkin.set_preference end,
          'set_depth_inches', null::numeric)));
      end if;
      if coalesce(btrim(v_checkin.contact_name), '') <> '' then
        v_seed := v_seed || jsonb_build_object('gc_contact_name', v_checkin.contact_name);
      end if;
      -- The caller's own patch always wins over the seed for the same field.
      v_patch := v_seed || v_patch;
    end if;
  end if;

  insert into project_build_facts as f (
    project_id,
    exterior_lines,
    flashing_system, flashing_system_other, flashing_note,
    fastener_type, fastener_type_other, fastener_length_in, fastener_spacing_in, fastener_note,
    site_rules, gc_contact_name, gc_contact_phone, elevation_notes,
    updated_by, updated_at
  )
  values (
    p_project_id,
    coalesce(v_patch->'exterior_lines', '[]'::jsonb),
    v_patch->>'flashing_system', v_patch->>'flashing_system_other', v_patch->>'flashing_note',
    v_patch->>'fastener_type', v_patch->>'fastener_type_other',
    (v_patch->>'fastener_length_in')::numeric,
    (v_patch->>'fastener_spacing_in')::numeric,
    v_patch->>'fastener_note',
    v_patch->>'site_rules', v_patch->>'gc_contact_name', v_patch->>'gc_contact_phone',
    v_patch->>'elevation_notes',
    auth.uid(), now()
  )
  on conflict (project_id) do update set
    exterior_lines = case when v_patch ? 'exterior_lines' then v_patch->'exterior_lines' else f.exterior_lines end,
    flashing_system = case when v_patch ? 'flashing_system' then v_patch->>'flashing_system' else f.flashing_system end,
    flashing_system_other = case when v_patch ? 'flashing_system_other' then v_patch->>'flashing_system_other' else f.flashing_system_other end,
    flashing_note = case when v_patch ? 'flashing_note' then v_patch->>'flashing_note' else f.flashing_note end,
    fastener_type = case when v_patch ? 'fastener_type' then v_patch->>'fastener_type' else f.fastener_type end,
    fastener_type_other = case when v_patch ? 'fastener_type_other' then v_patch->>'fastener_type_other' else f.fastener_type_other end,
    fastener_length_in = case when v_patch ? 'fastener_length_in' then (v_patch->>'fastener_length_in')::numeric else f.fastener_length_in end,
    fastener_spacing_in = case when v_patch ? 'fastener_spacing_in' then (v_patch->>'fastener_spacing_in')::numeric else f.fastener_spacing_in end,
    fastener_note = case when v_patch ? 'fastener_note' then v_patch->>'fastener_note' else f.fastener_note end,
    site_rules = case when v_patch ? 'site_rules' then v_patch->>'site_rules' else f.site_rules end,
    gc_contact_name = case when v_patch ? 'gc_contact_name' then v_patch->>'gc_contact_name' else f.gc_contact_name end,
    gc_contact_phone = case when v_patch ? 'gc_contact_phone' then v_patch->>'gc_contact_phone' else f.gc_contact_phone end,
    elevation_notes = case when v_patch ? 'elevation_notes' then v_patch->>'elevation_notes' else f.elevation_notes end,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.upsert_build_facts(uuid, jsonb) is
  'Foreman+: merge a partial patch of job-facts columns onto the job''s row, creating it if needed. Any key outside the fixed column whitelist is refused by name. exterior_lines is sent whole (a list of {exterior_finish, exterior_note, set_depth, set_depth_inches}, at most 20) and replaces the stored list. On the first write for a job with GC handshake data on file, seeds one exterior line (set depth + the material as its note) and gc_contact_name from the latest project_gc_checkins row before the caller''s own patch is applied. Callable one field at a time so the Job facts card can save on blur through the offline outbox.';

revoke all on function public.upsert_build_facts(uuid, jsonb) from public, anon;
grant execute on function public.upsert_build_facts(uuid, jsonb) to authenticated;

-- ===========================================================================
-- 3. green_light_items — item 2 reads the list now
-- ===========================================================================
-- Only the second question changes: "an exterior finish and set depth are
-- recorded" is answered by ANY line that carries both. Everything else is
-- 20261001000000's text, restated whole because the function is.
create or replace function public.green_light_items(p_project_id uuid)
returns table (item_key text, label_en text, answered boolean, who text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_first_published_day date;
begin
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  select min(sa.start_date) into v_first_published_day
    from schedule_assignments sa
   where sa.project_id = p_project_id
     and sa.status = 'published';

  return query
  select
    'plan_set'::text,
    'A planset is uploaded and its extraction has finished'::text,
    exists (
      select 1 from project_plansets pl
       where pl.project_id = p_project_id and pl.status = 'ready'
    ),
    'supervisor'::text
  union all
  select
    'build_facts'::text,
    'An exterior finish and its set depth are recorded'::text,
    exists (
      select 1
        from project_build_facts f
        cross join lateral jsonb_array_elements(f.exterior_lines) l
       where f.project_id = p_project_id
         and l->>'exterior_finish' is not null
         and l->>'set_depth' is not null
    ),
    'foreman'::text
  union all
  select
    'materials_eta'::text,
    'The materials ETA is set and lands on or before the first day on site'::text,
    (
      v_first_published_day is not null
      and exists (
        select 1 from project_pipeline pp
         where pp.project_id = p_project_id
           and pp.materials_eta is not null
           and pp.materials_eta <= v_first_published_day
      )
    ),
    'supervisor'::text
  union all
  select
    'gc_site'::text,
    'The GC contact and site rules are recorded'::text,
    exists (
      select 1 from project_build_facts f
       where f.project_id = p_project_id
         and coalesce(btrim(f.gc_contact_name), '') <> ''
         and coalesce(btrim(f.site_rules), '') <> ''
    ),
    'foreman'::text
  union all
  select
    'day_one_crew'::text,
    'A crew and a truck are assigned for the first day on site'::text,
    (
      v_first_published_day is not null
      and exists (
        select 1
          from schedule_assignments sa
          join schedule_assignment_members sm on sm.assignment_id = sa.id
         where sa.project_id = p_project_id
           and sa.status = 'published'
           and sa.start_date = v_first_published_day
           and exists (
             select 1 from vehicle_project_assignments vpa
              where vpa.assignment_id = sa.id
           )
      )
    ),
    'supervisor'::text
  union all
  select
    'toolbox'::text,
    'A toolbox talk is pinned to the first day'::text,
    (
      v_first_published_day is not null
      and exists (
        select 1 from toolbox_talk_assignments ta
         where ta.assigned_date = v_first_published_day
      )
    ),
    'supervisor'::text;
end;
$$;

comment on function public.green_light_items(uuid) is
  'Six standing questions about a job, computed fresh from plansets/extraction, project_build_facts (any exterior line with both a finish and a set depth answers item 2), project_pipeline''s materials ETA, the first PUBLISHED schedule_assignments day plus its members and linked vehicle, and toolbox_talk_assignments — never stored. authenticated (installers included): nothing here is money-related. who names the role expected to answer.';

revoke all on function public.green_light_items(uuid) from public, anon;
grant execute on function public.green_light_items(uuid) to authenticated;

-- ===========================================================================
-- 4. Drop what the card no longer asks
-- ===========================================================================
-- After the functions above stop reading them. A phone still on the previous
-- bundle selects these columns by name and gets a 400 until it reloads;
-- getBuildFacts turns that into "nothing recorded yet" rather than a crash,
-- and the build stamp reloads it within the hour.
alter table project_build_facts drop column if exists exterior_finish;
alter table project_build_facts drop column if exists exterior_note;
alter table project_build_facts drop column if exists set_depth;
alter table project_build_facts drop column if exists set_depth_inches;
alter table project_build_facts drop column if exists sill_pan;
alter table project_build_facts drop column if exists sill_pan_type;
alter table project_build_facts drop column if exists note_north;
alter table project_build_facts drop column if exists note_south;
alter table project_build_facts drop column if exists note_east;
alter table project_build_facts drop column if exists note_west;

comment on table project_build_facts is
  'One row per job: the site answers a foreman records once so nobody on the crew has to ask twice — a list of exterior situations (finish + set depth + inch + note, because one house is brick on the front and stucco on the sides), flashing system, fasteners, site rules, the GC''s contact, and one box of elevation notes. Every column nullable; filled in over time, one field at a time. Written only by upsert_build_facts (foreman+). The per-unit spec (project_mark_specs.extra) stays authoritative for what actually gets installed where — see ADR-0011.';

comment on column project_build_facts.exterior_lines is
  'jsonb list, at most 20, of {exterior_finish: stucco|rock|siding|brick|other|null, exterior_note, set_depth: inset|outset|unknown|null, set_depth_inches}. Replaced whole on every save.';
comment on column project_build_facts.flashing_system_other is 'What the flashing system is when flashing_system = other.';
comment on column project_build_facts.fastener_type_other is 'What the fastener is when fastener_type = other.';
comment on column project_build_facts.elevation_notes is 'One free-text box for anything about a side of the house; write the side in ("North: …").';

-- ---------------------------------------------------------------------------
-- The test-login fence — re-armed after a reshape, idempotent.
-- ---------------------------------------------------------------------------
select public.attach_sandbox_guards();
