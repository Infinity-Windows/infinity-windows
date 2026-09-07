-- Step 4 of the installer operating system (S4, .scratch/installer-os):
-- job facts and the green-light checklist.
--
-- WHAT THIS FILE ADDS
--
--   1. project_build_facts — one row per job: the site answers a foreman
--      fills in once instead of every installer asking the same question on
--      the way in — exterior finish, set depth, flashing system, fasteners,
--      sill pan, site rules, the GC's name and number, and a note per
--      elevation. Every column stays nullable: these are filled in over
--      time, on a truck, one field at a time.
--
--   2. upsert_build_facts(project, patch) — the one writer. A form saves one
--      field on blur through the offline outbox, so this has to accept a
--      partial jsonb patch, merge it onto whatever is already there, and
--      never require the whole row at once. On the FIRST write for a job
--      with GC handshake data on file, it seeds set_depth / exterior_note /
--      gc_contact_name from the most recent project_gc_checkins row before
--      applying the caller's patch — the GC already told us once; the form
--      should not ask again for free.
--
--   3. green_light_items(project) — six questions, computed (never stored)
--      from tables that already exist: is there a planset and has it been
--      extracted, are the finish and set depth on file, is the GC contact
--      and site rules on file, will the windows beat the crew to the job,
--      is day one's crew and truck assigned, is a toolbox talk pinned to
--      that morning. Read by installers too (rec 6 says "leaks nothing
--      money-related", and none of these six do).
--
--   4. set_project_readiness (20260981000000) refuses ONLY the manual flip
--      to 'ready' while green_light_items has open rows, naming them in one
--      sentence. Nothing else is gated — a job can run every day of its life
--      with three open items, and nobody is stopped from doing the work.
--      There is no other writer of ready_state (project_pipeline grants no
--      table-level INSERT/UPDATE to authenticated — H0 above made every
--      write to it RPC-only), so no trigger is needed to close a client
--      UPDATE path; this refusal is the whole enforcement.
--
-- RPC-ONLY, same law as project_pipeline and project_gc_checkins: no
-- INSERT/UPDATE grant on project_build_facts to authenticated at all, so
-- upsert_build_facts (SECURITY DEFINER, rank-checked in its body) is the only
-- door. Idempotent throughout — a second run changes nothing.

-- ===========================================================================
-- 1. project_build_facts
-- ===========================================================================
create table if not exists project_build_facts (
  project_id uuid primary key references projects(id) on delete cascade,
  exterior_finish text,
  exterior_note text,
  set_depth text,
  set_depth_inches numeric(4,2),
  flashing_system text,
  flashing_note text,
  fastener_type text,
  fastener_length_in numeric(4,2),
  fastener_spacing_in numeric(4,1),
  fastener_note text,
  sill_pan text,
  sill_pan_type text,
  site_rules text,
  gc_contact_name text,
  gc_contact_phone text,
  note_north text,
  note_south text,
  note_east text,
  note_west text,
  -- Who last touched this row and when. Null under the service role or a SQL
  -- console — the honest answer there, same as project_pipeline.updated_by.
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table project_build_facts drop constraint if exists project_build_facts_exterior_finish_check;
alter table project_build_facts add constraint project_build_facts_exterior_finish_check
  check (exterior_finish is null or exterior_finish in ('stucco', 'rock', 'siding', 'brick', 'other'));

alter table project_build_facts drop constraint if exists project_build_facts_set_depth_check;
alter table project_build_facts add constraint project_build_facts_set_depth_check
  check (set_depth is null or set_depth in ('inset', 'outset', 'unknown'));

alter table project_build_facts drop constraint if exists project_build_facts_flashing_system_check;
alter table project_build_facts add constraint project_build_facts_flashing_system_check
  check (flashing_system is null or flashing_system in ('butyl_tape', 'paper_flashing', 'fluid_applied', 'other'));

alter table project_build_facts drop constraint if exists project_build_facts_fastener_type_check;
alter table project_build_facts add constraint project_build_facts_fastener_type_check
  check (fastener_type is null or fastener_type in ('flange_screw', 'jamb_screw', 'concrete_screw', 'other'));

alter table project_build_facts drop constraint if exists project_build_facts_sill_pan_check;
alter table project_build_facts add constraint project_build_facts_sill_pan_check
  check (sill_pan is null or sill_pan in ('required', 'not_required', 'unknown'));

alter table project_build_facts drop constraint if exists project_build_facts_sill_pan_type_check;
alter table project_build_facts add constraint project_build_facts_sill_pan_type_check
  check (sill_pan_type is null or sill_pan_type in ('metal', 'pvc', 'fluid', 'tape', 'none'));

comment on table project_build_facts is
  'One row per job: the site answers a foreman records once so nobody on the crew has to ask twice — exterior finish, set depth, flashing system, fasteners, sill pan, site rules, the GC''s contact, and a note per elevation. Every column nullable; filled in over time, one field at a time. Written only by upsert_build_facts (foreman+). The per-unit spec (project_mark_specs.extra) stays authoritative for what actually gets installed where — see ADR-0011.';

comment on column project_build_facts.exterior_finish is 'stucco | rock | siding | brick | other.';
comment on column project_build_facts.set_depth is 'inset | outset | unknown — the job-level default. A unit''s own spec, when it disagrees, wins for that unit.';
comment on column project_build_facts.flashing_system is 'butyl_tape | paper_flashing | fluid_applied | other.';
comment on column project_build_facts.fastener_type is 'flange_screw | jamb_screw | concrete_screw | other.';
comment on column project_build_facts.sill_pan is 'required | not_required | unknown.';
comment on column project_build_facts.sill_pan_type is 'metal | pvc | fluid | tape | none.';
comment on column project_build_facts.note_north is 'Free text for the north elevation. note_south / note_east / note_west are its siblings.';

alter table project_build_facts enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`. SELECT only — the RPC
-- below is the only writer, so foreman+-to-write is a fact about the grants,
-- not just a promise in the function body.
revoke all on project_build_facts from anon, authenticated;
grant select on project_build_facts to authenticated;
grant all on project_build_facts to service_role;

-- Any signed-in crew member reads it — an installer wants to know it is
-- stucco and outset just as much as the foreman who filed it — and no
-- partner ever does. THE WALL: this is our build method and our GC contact,
-- not something a granted builder login gets to read off REST.
drop policy if exists "build_facts_crew_read" on project_build_facts;
create policy "build_facts_crew_read" on project_build_facts
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ===========================================================================
-- 2. upsert_build_facts(project, patch) — foreman+, one field or many
-- ===========================================================================
-- p_patch is a flat jsonb object of the columns being changed. Any key that
-- is not one of the whitelisted columns below is refused by name, in a
-- sentence, rather than silently ignored — a typo in a column name must not
-- look like a successful save.
--
-- `?` (jsonb key-exists) rather than `->>` is what lets a caller CLEAR a
-- field: {"exterior_note": null} in the patch sets the column to null;
-- omitting the key entirely leaves the stored value alone. `->>` alone
-- cannot tell those two apart — both read back as SQL NULL.
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
    'exterior_finish', 'exterior_note', 'set_depth', 'set_depth_inches',
    'flashing_system', 'flashing_note', 'fastener_type', 'fastener_length_in',
    'fastener_spacing_in', 'fastener_note', 'sill_pan', 'sill_pan_type',
    'site_rules', 'gc_contact_name', 'gc_contact_phone',
    'note_north', 'note_south', 'note_east', 'note_west'
  ];
  v_key text;
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

  if p_patch ? 'exterior_finish' and p_patch->>'exterior_finish' is not null
     and p_patch->>'exterior_finish' not in ('stucco', 'rock', 'siding', 'brick', 'other') then
    raise exception 'Exterior finish is stucco, rock, siding, brick, or other.';
  end if;
  if p_patch ? 'set_depth' and p_patch->>'set_depth' is not null
     and p_patch->>'set_depth' not in ('inset', 'outset', 'unknown') then
    raise exception 'Set depth is inset, outset, or unknown.';
  end if;
  if p_patch ? 'flashing_system' and p_patch->>'flashing_system' is not null
     and p_patch->>'flashing_system' not in ('butyl_tape', 'paper_flashing', 'fluid_applied', 'other') then
    raise exception 'Flashing system is butyl tape, paper flashing, fluid-applied, or other.';
  end if;
  if p_patch ? 'fastener_type' and p_patch->>'fastener_type' is not null
     and p_patch->>'fastener_type' not in ('flange_screw', 'jamb_screw', 'concrete_screw', 'other') then
    raise exception 'Fastener type is flange screw, jamb screw, concrete screw, or other.';
  end if;
  if p_patch ? 'sill_pan' and p_patch->>'sill_pan' is not null
     and p_patch->>'sill_pan' not in ('required', 'not_required', 'unknown') then
    raise exception 'Sill pan is required, not required, or unknown.';
  end if;
  if p_patch ? 'sill_pan_type' and p_patch->>'sill_pan_type' is not null
     and p_patch->>'sill_pan_type' not in ('metal', 'pvc', 'fluid', 'tape', 'none') then
    raise exception 'Sill pan type is metal, PVC, fluid-applied, tape, or none.';
  end if;

  select exists (select 1 from project_build_facts where project_id = p_project_id) into v_exists;

  v_patch := p_patch;
  if not v_exists then
    -- Seed from the GC handshake on the very first write for this job, before
    -- the caller's own patch is applied — the GC already told us the set
    -- preference and what is going on the outside; asking a foreman to retype
    -- it is the exact friction this table exists to remove. `unknown` stays
    -- null: an "I don't know" from the GC is not a fact worth carrying
    -- forward as one.
    select * into v_checkin
      from project_gc_checkins
     where project_id = p_project_id
     order by contacted_at desc
     limit 1;

    if found then
      if v_checkin.set_preference is not null and v_checkin.set_preference <> 'unknown' then
        v_seed := v_seed || jsonb_build_object('set_depth', v_checkin.set_preference);
      end if;
      if coalesce(btrim(v_checkin.exterior_material), '') <> '' then
        v_seed := v_seed || jsonb_build_object('exterior_note', v_checkin.exterior_material);
      end if;
      if coalesce(btrim(v_checkin.contact_name), '') <> '' then
        v_seed := v_seed || jsonb_build_object('gc_contact_name', v_checkin.contact_name);
      end if;
      -- The caller's own patch always wins over the seed for the same field.
      v_patch := v_seed || p_patch;
    end if;
  end if;

  insert into project_build_facts as f (
    project_id,
    exterior_finish, exterior_note, set_depth, set_depth_inches,
    flashing_system, flashing_note, fastener_type, fastener_length_in,
    fastener_spacing_in, fastener_note, sill_pan, sill_pan_type, site_rules,
    gc_contact_name, gc_contact_phone, note_north, note_south, note_east, note_west,
    updated_by, updated_at
  )
  values (
    p_project_id,
    v_patch->>'exterior_finish', v_patch->>'exterior_note', v_patch->>'set_depth',
    (v_patch->>'set_depth_inches')::numeric,
    v_patch->>'flashing_system', v_patch->>'flashing_note', v_patch->>'fastener_type',
    (v_patch->>'fastener_length_in')::numeric,
    (v_patch->>'fastener_spacing_in')::numeric,
    v_patch->>'fastener_note', v_patch->>'sill_pan', v_patch->>'sill_pan_type', v_patch->>'site_rules',
    v_patch->>'gc_contact_name', v_patch->>'gc_contact_phone',
    v_patch->>'note_north', v_patch->>'note_south', v_patch->>'note_east', v_patch->>'note_west',
    auth.uid(), now()
  )
  on conflict (project_id) do update set
    exterior_finish = case when v_patch ? 'exterior_finish' then v_patch->>'exterior_finish' else f.exterior_finish end,
    exterior_note = case when v_patch ? 'exterior_note' then v_patch->>'exterior_note' else f.exterior_note end,
    set_depth = case when v_patch ? 'set_depth' then v_patch->>'set_depth' else f.set_depth end,
    set_depth_inches = case when v_patch ? 'set_depth_inches' then (v_patch->>'set_depth_inches')::numeric else f.set_depth_inches end,
    flashing_system = case when v_patch ? 'flashing_system' then v_patch->>'flashing_system' else f.flashing_system end,
    flashing_note = case when v_patch ? 'flashing_note' then v_patch->>'flashing_note' else f.flashing_note end,
    fastener_type = case when v_patch ? 'fastener_type' then v_patch->>'fastener_type' else f.fastener_type end,
    fastener_length_in = case when v_patch ? 'fastener_length_in' then (v_patch->>'fastener_length_in')::numeric else f.fastener_length_in end,
    fastener_spacing_in = case when v_patch ? 'fastener_spacing_in' then (v_patch->>'fastener_spacing_in')::numeric else f.fastener_spacing_in end,
    fastener_note = case when v_patch ? 'fastener_note' then v_patch->>'fastener_note' else f.fastener_note end,
    sill_pan = case when v_patch ? 'sill_pan' then v_patch->>'sill_pan' else f.sill_pan end,
    sill_pan_type = case when v_patch ? 'sill_pan_type' then v_patch->>'sill_pan_type' else f.sill_pan_type end,
    site_rules = case when v_patch ? 'site_rules' then v_patch->>'site_rules' else f.site_rules end,
    gc_contact_name = case when v_patch ? 'gc_contact_name' then v_patch->>'gc_contact_name' else f.gc_contact_name end,
    gc_contact_phone = case when v_patch ? 'gc_contact_phone' then v_patch->>'gc_contact_phone' else f.gc_contact_phone end,
    note_north = case when v_patch ? 'note_north' then v_patch->>'note_north' else f.note_north end,
    note_south = case when v_patch ? 'note_south' then v_patch->>'note_south' else f.note_south end,
    note_east = case when v_patch ? 'note_east' then v_patch->>'note_east' else f.note_east end,
    note_west = case when v_patch ? 'note_west' then v_patch->>'note_west' else f.note_west end,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.upsert_build_facts(uuid, jsonb) is
  'Foreman+: merge a partial patch of job-facts columns onto the job''s row, creating it if needed. Any key outside the fixed column whitelist is refused by name. On the first write for a job with GC handshake data on file, seeds set_depth / exterior_note / gc_contact_name from the latest project_gc_checkins row before the caller''s own patch is applied. Callable one field at a time so the Job facts card can save on blur through the offline outbox.';

revoke all on function public.upsert_build_facts(uuid, jsonb) from public, anon;
grant execute on function public.upsert_build_facts(uuid, jsonb) to authenticated;

-- ===========================================================================
-- 3. green_light_items(project) — six questions, computed, never stored
-- ===========================================================================
-- STABLE, not VOLATILE: nothing here writes, and marking it stable lets
-- Postgres call it once per statement instead of once per row when a caller
-- joins it. authenticated (installers included) may call it — recommendation
-- 6 is explicit that this leaks nothing money-related, and an installer
-- driving to a job wants to know the same six things a supervisor does.
--
-- item_key order is fixed (1-6 below) so a caller can rely on it without a
-- second sort; the UI still puts open items first, which is its own concern.
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

  -- The earliest PUBLISHED schedule day for this job. Several items below are
  -- about that specific morning; a draft assignment is not a commitment yet,
  -- so it is deliberately not read here (the same "published only" rule
  -- listMyPublished applies to what a crew member sees on My Schedule).
  select min(sa.start_date) into v_first_published_day
    from schedule_assignments sa
   where sa.project_id = p_project_id
     and sa.status = 'published';

  return query
  -- (1) A planset is on file and extraction has finished.
  select
    'plan_set'::text,
    'A planset is uploaded and its extraction has finished'::text,
    exists (
      select 1 from project_plansets pl
       where pl.project_id = p_project_id and pl.status = 'ready'
    ),
    'supervisor'::text
  union all
  -- (2) Exterior finish and set depth are recorded.
  select
    'build_facts'::text,
    'Exterior finish and set depth are recorded'::text,
    exists (
      select 1 from project_build_facts f
       where f.project_id = p_project_id
         and f.exterior_finish is not null
         and f.set_depth is not null
    ),
    'foreman'::text
  union all
  -- (3) Materials are due before the crew's first day on site. No schedule
  -- yet means there is no "before" to compare against, so this reads
  -- unanswered rather than vacuously true.
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
  -- (4) The GC contact and the site rules are on file.
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
  -- (5) Day one has a published crew (at least one member) with a truck
  -- linked to that same assignment.
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
  -- (6) A toolbox talk is pinned to that first morning (the admin override in
  -- toolbox_talk_assignments — "pinned", not the weekday rotation every day
  -- gets by default; see app/src/lib/install/buildFacts.ts for the reasoning
  -- this is checked this way rather than against the always-on rotation).
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
  'Six standing questions about a job, computed fresh from plansets/extraction, project_build_facts, project_pipeline''s materials ETA, the first PUBLISHED schedule_assignments day plus its members and linked vehicle, and toolbox_talk_assignments — never stored. authenticated (installers included): recommendation 6 is explicit this leaks nothing money-related. who names the role expected to answer: supervisor for plan_set/materials_eta/day_one_crew/toolbox, foreman for build_facts/gc_site.';

revoke all on function public.green_light_items(uuid) from public, anon;
grant execute on function public.green_light_items(uuid) to authenticated;

-- ===========================================================================
-- 4. The warn-not-block rule on set_project_readiness (20260981000000)
-- ===========================================================================
-- Same name, same arguments, same return type as H0's version — CREATE OR
-- REPLACE is enough, no drop needed. The only change: refuse the manual flip
-- to 'ready' while green_light_items has open rows, and say which ones.
-- Every other call (setting 'not_ready', or 'ready' with nothing open) is
-- untouched. project_pipeline still grants no table-level INSERT/UPDATE to
-- authenticated, so this RPC remains the only writer of ready_state — the
-- "add a trigger if it's a plain client UPDATE" case in the build brief does
-- not apply here, and this paragraph is the record of having checked.
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
  v_open text[];
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

  if p_ready_state = 'ready' then
    -- Checklist order (1-6), the same order the card shows the items in —
    -- not alphabetical, which put "day one crew" ahead of "plan set".
    select array_agg(
             g.label_en
             order by array_position(
               array['plan_set', 'build_facts', 'materials_eta', 'gc_site', 'day_one_crew', 'toolbox'],
               g.item_key
             )
           )
      into v_open
      from public.green_light_items(p_project_id) g
     where not g.answered;

    if v_open is not null and array_length(v_open, 1) > 0 then
      raise exception 'This job still has open green-light items: %.', array_to_string(v_open, '; ');
    end if;
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
  'Foreman+: mark a job Ready or Not ready. Warns, never blocks (S4): setting not_ready always succeeds; setting ready is refused, with a plain sentence naming the open items, while green_light_items(project_id) has any unanswered row. Nothing else about a job is gated by the checklist.';

revoke all on function public.set_project_readiness(uuid, text) from public, anon;
grant execute on function public.set_project_readiness(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The test-login fence
-- ---------------------------------------------------------------------------
-- project_build_facts carries project_id, which is what makes a table
-- project-scoped (sandbox_scoped_tables, 20260967000000). Re-arming is
-- idempotent and reports what it did.
select public.attach_sandbox_guards();
