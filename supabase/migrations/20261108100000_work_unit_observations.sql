-- Unit dimension observations: strict normalization, immutable fact
-- revisions, a current pointer, permission-safe reads, and canonical
-- unit/link save integration. First slice of ASTRA-UNIT-FACT-QC-CONTRACT.md
-- (2026-10-03): no independent verification, no QC workflow, no timing
-- lock, no new unit writer. custom_work_command remains the ONLY place a
-- new observation is saved; this migration layers observation handling into
-- its existing unit/link branch with create or replace, the same pattern
-- 20261024000000/20261031000000 already use. See docs/work-unit-observations.md.
--
-- Corrected 2026-10-03 against the independent B1-B9 review and subsequent
-- R1-R4 correction review. See docs/work-unit-observations.md.
begin;

-- ---------------------------------------------------------------------------
-- 1. Private tables. RLS enabled, every grant revoked, no policy -- every
--    access is through the SECURITY DEFINER functions below. Original
--    unit/command/project/opening/profile UUIDs are retained as PLAIN VALUES
--    with NO foreign key to the operational tables that can delete them
--    (B7): custom_work_units.project_id cascades from projects, and an FK
--    here would block that existing purge route the moment an observation
--    exists. Only the private, never-deleted internal graph (predecessor,
--    current pointer) keeps a real FK.
-- ---------------------------------------------------------------------------

create table public.work_unit_fact_revisions (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null,
  revision integer not null check (revision > 0),
  predecessor_id uuid references public.work_unit_fact_revisions(id),
  command_id uuid not null,
  actor_id uuid not null,
  -- Nullable: unknown legacy provenance is never invented. NULL here means
  -- "no independent observer can be inferred", not "nobody".
  observation_actor_id uuid,
  event_kind text not null check (event_kind in
    ('observation','legacy_observation','incomplete','cleared','relink')),
  -- The unit's BINDING at the moment this revision was recorded -- i.e. a
  -- snapshot of "where the unit lived when this row was written". This is
  -- NOT the same thing as origin below, and a relink changes this to the
  -- new job even though origin is carried forward unchanged (B1).
  project_id uuid,
  opening_id uuid,
  -- Where this OBSERVATION/provenance originates: the job/opening at the
  -- moment it was first asserted (a fresh 'observation'/'legacy_observation'
  -- /'incomplete' sets this to the current binding; a 'relink' carries it
  -- forward UNCHANGED from the predecessor; 'cleared' has none). Reads
  -- authorize against THIS, independently of the current binding above, so
  -- a relink can never launder private provenance into a destination job
  -- whose visibility alone would not have authorized the original (B1).
  origin_project_id uuid,
  origin_opening_id uuid,
  origin_kind text not null check (origin_kind in ('job','unassigned','none')),
  -- Original unit author and QA partition are evidence, separate from observer.
  -- No profile FK: retirement/deletion/reclassification cannot rewrite origin.
  origin_author_id uuid,
  origin_is_test boolean,
  check ((origin_kind = 'job' and origin_project_id is not null and origin_author_id is not null and origin_is_test is not null)
    or (origin_kind = 'unassigned' and origin_project_id is null and origin_opening_id is null and origin_author_id is not null and origin_is_test is not null)
    or (origin_kind = 'none' and origin_project_id is null and origin_opening_id is null and origin_author_id is null and origin_is_test is null)),
  legacy_measurement_source text check (legacy_measurement_source is null or length(legacy_measurement_source) <= 4000),
  legacy_area_source text check (legacy_area_source is null or length(legacy_area_source) <= 4000),
  unit_incarnation_epoch bigint not null check (unit_incarnation_epoch between 0 and 9007199254740991),
  width_in numeric check (width_in is null or (width_in > 0 and width_in <= 100000)),
  height_in numeric check (height_in is null or (height_in > 0 and height_in <= 100000)),
  measurement_unit text check (measurement_unit is null or measurement_unit in ('in','ft','mm','cm')),
  measurement_source text check (measurement_source is null or measurement_source in ('measured','plans','estimated')),
  source_reference text check (source_reference is null or length(btrim(source_reference)) between 1 and 500),
  -- Original client width/height exactly as supplied, before inch conversion
  -- -- display rounding is a read-time concern, never baked in here.
  raw_observation jsonb check (raw_observation is null or (jsonb_typeof(raw_observation) = 'object' and octet_length(raw_observation::text) <= 2000)),
  estimated boolean,
  -- Plain snapshot of the context epochs (section 2) as of this write, using
  -- an explicit 0 baseline distinct from "epoch 1" (B6): 0 means no bump has
  -- ever happened for that scope yet.
  unit_binding_epoch bigint check (unit_binding_epoch is null or unit_binding_epoch between 0 and 9007199254740991),
  opening_context_epoch bigint check (opening_context_epoch is null or opening_context_epoch between 0 and 9007199254740991),
  project_context_epoch bigint check (project_context_epoch is null or project_context_epoch between 0 and 9007199254740991),
  -- 32 KiB accommodates the legal <=20,000-byte legacy facts subset, a
  -- <=2,000-byte raw observation and bounded reason/context metadata without
  -- truncating any accepted old evidence.
  -- The private helper's own description of what it applied, independent of
  -- custom_work_commands.payload, which record_crew_work later rewrites.
  applied_intent jsonb not null check (jsonb_typeof(applied_intent) = 'object' and octet_length(applied_intent::text) <= 32768),
  before_snapshot jsonb check (before_snapshot is null or (jsonb_typeof(before_snapshot) = 'object' and octet_length(before_snapshot::text) <= 32768)),
  reason text check (reason is null or length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now(),
  unique (unit_id, revision)
);
create index work_unit_fact_revisions_unit on public.work_unit_fact_revisions(unit_id, revision desc);

-- The only mutable row this migration adds: a CAS/lookup pointer, exactly
-- like work_configuration_draft_pointers. History lives in the append-only
-- table above. No FK either, for the same reason work_job_menu_selections
-- (20261107020000) does not carry one on project_id.
create table public.work_unit_fact_current (
  unit_id uuid primary key,
  current_revision_id uuid not null references public.work_unit_fact_revisions(id),
  current_revision integer not null check (current_revision > 0),
  updated_at timestamptz not null default now()
);

-- Narrow identity-scope epochs (contract section "Explicit transaction seam").
-- Bumped ONLY by the triggers in section 2, from real OLD/NEW row identities
-- -- never a new client command or actor. Only unit_incarnation is consumed
-- now, to prevent old evidence becoming a recreated unit's current state.
-- Binding/opening/project tokens remain snapshots for deferred verification/QC.
create table public.work_unit_fact_context_epochs (
  scope_kind text not null check (scope_kind in ('unit_binding','unit_incarnation','opening','project')),
  scope_id uuid not null,
  epoch bigint not null default 1 check (epoch between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key (scope_kind, scope_id)
);

alter table public.work_unit_fact_revisions enable row level security;
revoke all on table public.work_unit_fact_revisions from public, anon, authenticated;
alter table public.work_unit_fact_current enable row level security;
revoke all on table public.work_unit_fact_current from public, anon, authenticated;
alter table public.work_unit_fact_context_epochs enable row level security;
revoke all on table public.work_unit_fact_context_epochs from public, anon, authenticated;

-- work_capture_immutable_record() (20261107020000) is a generic "raise and
-- refuse" trigger with no table-specific logic; reused rather than duplicated.
create trigger work_capture_record_immutable before update or delete
  on public.work_unit_fact_revisions
  for each row execute function public.work_capture_immutable_record();

comment on table public.work_unit_fact_revisions is
  'Private immutable unit dimension-observation history. One revision per actual semantic change (observation, legacy edit, incomplete, cleared, or relink) -- never one per SQL UPDATE. unit_id/command_id are plain retained-evidence values with no FK to the deletable operational tables (see docs/work-unit-observations.md). origin_project_id/origin_opening_id are the immutable observation-origin context, distinct from project_id/opening_id (the binding snapshot at write time) -- a relink carries origin forward unchanged.';
comment on table public.work_unit_fact_current is
  'The only mutable row per unit -- current fact revision pointer. Advanced only under the canonical unit row (custom_work_command), never a second writer.';
comment on table public.work_unit_fact_context_epochs is
  'Narrow identity-scope epochs for unit binding, opening removal/move, project delete/restore, and separate unit physical incarnation. Only unit incarnation gates current association now; no timing, lifecycle, or QC claim.';

-- ---------------------------------------------------------------------------
-- 2. Context epochs -- bumped only from real OLD/NEW/affected-row identities
--    on the tables that already own that identity. No advisory/global lock
--    and no new actor; these ARE ordinary row-level triggers on the row
--    already being written by its own existing writer, and the upsert
--    below does take a row lock on the epoch row itself -- recorded
--    accurately rather than claimed as lock-free (B6).
-- ---------------------------------------------------------------------------

create function public._work_unit_fact_bump_epoch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kind text; v_id uuid;
begin
  if TG_TABLE_NAME = 'custom_work_units' then v_kind := 'unit_binding';
  elsif TG_TABLE_NAME = 'project_openings' then v_kind := 'opening';
  elsif TG_TABLE_NAME = 'projects' then v_kind := 'project';
  else
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;
  if TG_OP = 'DELETE' then v_id := old.id; else v_id := new.id; end if;
  if TG_OP = 'INSERT' then
    -- A brand-new identity that was never tracked before is not itself a
    -- "change" -- it stays at the 0 baseline until its first real update
    -- or delete. Only a REINSERTION of a previously-tracked id (a genuine
    -- physical reincarnation after purge) advances an existing row.
    update public.work_unit_fact_context_epochs set epoch = epoch + 1, updated_at = now()
     where scope_kind = v_kind and scope_id = v_id;
  else
    insert into public.work_unit_fact_context_epochs(scope_kind, scope_id, epoch)
      values (v_kind, v_id, 1)
    on conflict (scope_kind, scope_id) do update
      set epoch = public.work_unit_fact_context_epochs.epoch + 1, updated_at = now();
  end if;
  -- Physical lifetime is distinct from ordinary relinks. Never reset the
  -- retained token when a source row is deleted or reinserted.
  if TG_TABLE_NAME = 'custom_work_units' and TG_OP in ('INSERT','DELETE') then
    if TG_OP = 'INSERT' then
      update public.work_unit_fact_context_epochs set epoch = epoch + 1, updated_at = now()
        where scope_kind = 'unit_incarnation' and scope_id = v_id;
    else
      insert into public.work_unit_fact_context_epochs(scope_kind, scope_id, epoch)
        values ('unit_incarnation', v_id, 1)
      on conflict (scope_kind, scope_id) do update
        set epoch = public.work_unit_fact_context_epochs.epoch + 1, updated_at = now();
    end if;
  end if;
  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public._work_unit_fact_bump_epoch() from public, anon, authenticated;

-- UPDATE: only the narrow identity change that matters for each table.
create trigger work_unit_fact_binding_epoch_update after update on public.custom_work_units
  for each row when (old.project_id is distinct from new.project_id or old.opening_id is distinct from new.opening_id)
  execute function public._work_unit_fact_bump_epoch();
create trigger work_unit_fact_opening_epoch_update after update on public.project_openings
  for each row when (old.removed_at is distinct from new.removed_at or old.project_id is distinct from new.project_id)
  execute function public._work_unit_fact_bump_epoch();
create trigger work_unit_fact_project_epoch_update after update on public.projects
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function public._work_unit_fact_bump_epoch();
-- INSERT/DELETE: a physical reincarnation (purge-then-reinsert of the same
-- UUID) is a genuine identity change an UPDATE-only trigger would miss
-- entirely (B6). Unconditional -- a trigger WHEN clause cannot branch on
-- TG_OP, so these are separate triggers rather than one combined condition.
create trigger work_unit_fact_binding_epoch_write after insert or delete on public.custom_work_units
  for each row execute function public._work_unit_fact_bump_epoch();
create trigger work_unit_fact_opening_epoch_write after insert or delete on public.project_openings
  for each row execute function public._work_unit_fact_bump_epoch();
create trigger work_unit_fact_project_epoch_write after insert or delete on public.projects
  for each row execute function public._work_unit_fact_bump_epoch();

-- Absent-scope baseline is 0, deliberately distinct from "epoch 1" (the
-- value the FIRST real bump writes), so a fact recorded before any bump
-- ever happened is distinguishable from one recorded after the first (B6).
create function public._work_unit_fact_peek_epoch(p_kind text, p_scope_id uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select epoch from public.work_unit_fact_context_epochs
    where scope_kind = p_kind and scope_id = p_scope_id), 0)
$$;
revoke all on function public._work_unit_fact_peek_epoch(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Normalization -- SQL is the authority, not the client. Rejects extra
--    keys, missing keys, wrong types, numeric strings, zero/negative
--    dimensions, an out-of-range result, and an oversized reference.
--    Canonical inches: in unchanged; ft x12; mm /25.4; cm /2.54, exact
--    PostgreSQL numeric arithmetic, never rounded here -- display rounding
--    is a separate, later concern.
-- ---------------------------------------------------------------------------

create function public._work_unit_normalize_observation(p_observation jsonb)
returns table(width_in numeric, height_in numeric, m_unit text, m_source text, m_ref text)
language plpgsql set search_path = public, pg_temp as $$
declare v_unit text; v_source text; v_ref text; v_w numeric; v_h numeric;
begin
  if p_observation is null or jsonb_typeof(p_observation) <> 'object'
      or octet_length(p_observation::text) > 2000 then
    raise exception using errcode = '23514', message = 'Invalid dimension observation.';
  end if;
  if not (p_observation ?& array['width','height','unit','source']) then
    raise exception using errcode = '23514', message = 'A dimension observation needs width, height, unit and source.';
  end if;
  if exists (select 1 from jsonb_object_keys(p_observation) k
      where k not in ('width','height','unit','source','sourceReference')) then
    raise exception using errcode = '23514', message = 'Unknown dimension observation field.';
  end if;
  if jsonb_typeof(p_observation->'width') <> 'number' or jsonb_typeof(p_observation->'height') <> 'number' then
    raise exception using errcode = '23514', message = 'Width and height must be numbers.';
  end if;
  v_w := (p_observation->>'width')::numeric;
  v_h := (p_observation->>'height')::numeric;
  if v_w <= 0 or v_h <= 0 then
    raise exception using errcode = '23514', message = 'Enter a positive width and height.';
  end if;
  if jsonb_typeof(p_observation->'unit') <> 'string' then
    raise exception using errcode = '23514', message = 'Invalid measurement unit.';
  end if;
  v_unit := p_observation->>'unit';
  if v_unit not in ('in','ft','mm','cm') then
    raise exception using errcode = '23514', message = 'Unknown measurement unit.';
  end if;
  if jsonb_typeof(p_observation->'source') <> 'string' then
    raise exception using errcode = '23514', message = 'Invalid measurement source.';
  end if;
  v_source := p_observation->>'source';
  if v_source not in ('measured','plans','estimated') then
    raise exception using errcode = '23514', message = 'Unknown measurement source.';
  end if;
  v_ref := null;
  if p_observation ? 'sourceReference' then
    if jsonb_typeof(p_observation->'sourceReference') = 'null' then
      v_ref := null;
    elsif jsonb_typeof(p_observation->'sourceReference') = 'string' then
      v_ref := btrim(p_observation->>'sourceReference');
      if length(v_ref) not between 1 and 500 then
        raise exception using errcode = '23514', message = 'Invalid source reference.';
      end if;
    else
      raise exception using errcode = '23514', message = 'Invalid source reference.';
    end if;
  end if;
  width_in := case v_unit when 'in' then v_w when 'ft' then v_w * 12 when 'mm' then v_w / 25.4 when 'cm' then v_w / 2.54 end;
  height_in := case v_unit when 'in' then v_h when 'ft' then v_h * 12 when 'mm' then v_h / 25.4 when 'cm' then v_h / 2.54 end;
  if width_in <= 0 or height_in <= 0 or width_in > 100000 or height_in > 100000 then
    raise exception using errcode = '23514', message = 'Computed dimension is out of range.';
  end if;
  m_unit := v_unit; m_source := v_source; m_ref := v_ref;
  return next;
end;
$$;
revoke all on function public._work_unit_normalize_observation(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Protected-dimension-change authority. Reuses the existing
--    configuration role helpers (20261108000000) rather than duplicating
--    them. EVERY actor -- author and supervisor included -- must hold
--    source visibility on every affected job first (B4); only after that
--    does the author/owner/supervisor exemption or the foreman grant loop
--    decide. A nonauthor foreman administering a wholly unassigned (no job
--    at all) protected observation can never pass: there is no job to grant
--    against, so that case now falls straight to false rather than an empty
--    loop vacuously returning true.
-- ---------------------------------------------------------------------------

-- Shared permission predicate for reads and protected writes. Current bindings
-- require a matching live opening. Immutable origins retain their original job
-- AND authorize an opening's live job after a move. It never returns source IDs.
create function public._work_unit_fact_context_visible(
  p_uid uuid, p_kind text, p_project uuid, p_opening uuid,
  p_author uuid, p_is_test boolean, p_origin boolean
) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_opening public.project_openings;
begin
  if p_uid is null or p_kind is null then return false; end if;
  if p_kind = 'none' then return true; end if;
  if p_kind = 'unassigned' then
    return p_project is null and p_opening is null and p_author is not null and p_is_test is not null
      and (p_uid = p_author or public._work_config_is_supervisor(p_uid))
      and public.is_test_profile(p_uid) = p_is_test;
  end if;
  if p_kind <> 'job' or p_project is null or not public._ai_job_visible(p_project, p_uid) then return false; end if;
  if p_opening is not null then
    select * into v_opening from public.project_openings where id = p_opening;
    if v_opening.id is null or v_opening.removed_at is not null
      or not public._ai_job_visible(v_opening.project_id, p_uid)
      or (not p_origin and v_opening.project_id is distinct from p_project) then return false; end if;
  end if;
  return true;
end;
$$;
revoke all on function public._work_unit_fact_context_visible(uuid,text,uuid,uuid,uuid,boolean,boolean) from public, anon, authenticated;

-- Legacy free text is retained verbatim in separate columns. Only these
-- explicitly recognized labels participate in conservative normalization.
create function public._work_unit_fact_legacy_source(p_text text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case lower(btrim(p_text)) when 'measured' then 'measured'
    when 'plans' then 'plans' when 'from plans' then 'plans'
    when 'estimated' then 'estimated' else null end
$$;
revoke all on function public._work_unit_fact_legacy_source(text) from public, anon, authenticated;

create function public._work_unit_fact_can_edit_dimensions(p_uid uuid, p_author uuid, p_project_ids uuid[]) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pid uuid; v_any_job boolean := false;
begin
  if p_uid is null then return false; end if;
  foreach pid in array p_project_ids loop
    if pid is not null then
      v_any_job := true;
      if not public._ai_job_visible(pid, p_uid) then return false; end if;
    end if;
  end loop;
  if p_uid = p_author then return true; end if;
  if public._work_config_is_supervisor(p_uid) then return true; end if;
  if not v_any_job then return false; end if;
  if not public._work_config_is_foreman(p_uid) then return false; end if;
  foreach pid in array p_project_ids loop
    if pid is null then continue; end if;
    if not exists (
      select 1 from public.work_job_management_grants
       where project_id = pid and profile_id = p_uid and capability = 'dimensions_edit' and revoked_at is null
    ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function public._work_unit_fact_can_edit_dimensions(uuid, uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The explicit transaction seam (contract section "Explicit transaction
--    seam, not request-ID triggers"). Called once, after the canonical
--    history and custom_work_commands INSERT, before return, only for
--    unit/link actions with an actual semantic change. Obtains actor from
--    auth.uid() itself and verifies it against the command row THIS SAME
--    transaction just inserted/holds -- never a trigger GUC, trigger depth,
--    or a passed-in actor. Helper failure rolls the whole save back.
-- ---------------------------------------------------------------------------

create function public._work_record_unit_fact(
  p_command_id uuid, p_applied_unit_intent jsonb, p_before jsonb, p_unit_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_command public.custom_work_commands;
  v_unit public.custom_work_units;
  v_cur public.work_unit_fact_current;
  v_new_rev integer;
  v_new_id uuid;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Sign-in required.';
  end if;
  select * into v_command from public.custom_work_commands where id = p_command_id;
  if v_command.id is null or v_command.profile_id is distinct from v_actor then
    raise exception using errcode = '42501', message = 'Unit fact recording requires the actual saved command receipt.';
  end if;
  select * into v_unit from public.custom_work_units where id = p_unit_id;
  if v_unit.id is null or v_command.result_id is distinct from v_unit.id
      or coalesce(v_command.payload->>'action','') not in ('unit','link')
      or (v_command.payload->'data'->>'id')::uuid is distinct from v_unit.id then
    raise exception using errcode = '23514', message = 'Unit fact recording does not match the saved canonical unit.';
  end if;
  if p_applied_unit_intent is null or jsonb_typeof(p_applied_unit_intent) <> 'object'
      or coalesce(p_applied_unit_intent->>'event_kind','') not in ('observation','legacy_observation','incomplete','cleared','relink') then
    raise exception using errcode = '23514', message = 'Unit fact recording received an invalid applied intent.';
  end if;
  if (p_applied_unit_intent->>'width_in')::numeric is distinct from (v_unit.facts->>'width_in')::numeric
    or (p_applied_unit_intent->>'height_in')::numeric is distinct from (v_unit.facts->>'height_in')::numeric
    or p_applied_unit_intent->>'legacy_measurement_source' is distinct from v_unit.facts->>'measurement_source'
    or p_applied_unit_intent->>'legacy_area_source' is distinct from v_unit.facts->>'area_source' then
    raise exception using errcode = '23514', message = 'Unit fact intent does not match the applied canonical facts.';
  end if;
  select * into v_cur from public.work_unit_fact_current where unit_id = p_unit_id;
  v_new_rev := coalesce(v_cur.current_revision, 0) + 1;
  insert into public.work_unit_fact_revisions(
    unit_id, revision, predecessor_id, command_id, actor_id, observation_actor_id, event_kind,
    project_id, opening_id, origin_project_id, origin_opening_id, origin_kind, origin_author_id, origin_is_test,
    legacy_measurement_source, legacy_area_source, unit_incarnation_epoch,
    width_in, height_in, measurement_unit, measurement_source, source_reference,
    raw_observation, estimated, unit_binding_epoch, opening_context_epoch, project_context_epoch,
    applied_intent, before_snapshot, reason
  ) values (
    p_unit_id, v_new_rev, v_cur.current_revision_id,
    p_command_id, v_actor,
    nullif(p_applied_unit_intent->>'observation_actor_id','')::uuid,
    p_applied_unit_intent->>'event_kind',
    v_unit.project_id, v_unit.opening_id,
    nullif(p_applied_unit_intent->>'origin_project_id','')::uuid,
    nullif(p_applied_unit_intent->>'origin_opening_id','')::uuid,
    p_applied_unit_intent->>'origin_kind', (p_applied_unit_intent->>'origin_author_id')::uuid,
    (p_applied_unit_intent->>'origin_is_test')::boolean,
    p_applied_unit_intent->>'legacy_measurement_source', p_applied_unit_intent->>'legacy_area_source',
    public._work_unit_fact_peek_epoch('unit_incarnation', p_unit_id),
    nullif(p_applied_unit_intent->>'width_in','')::numeric, nullif(p_applied_unit_intent->>'height_in','')::numeric,
    p_applied_unit_intent->>'measurement_unit', p_applied_unit_intent->>'measurement_source',
    p_applied_unit_intent->>'source_reference',
    p_applied_unit_intent->'raw_observation',
    nullif(p_applied_unit_intent->>'estimated','')::boolean,
    public._work_unit_fact_peek_epoch('unit_binding', p_unit_id),
    case when v_unit.opening_id is not null then public._work_unit_fact_peek_epoch('opening', v_unit.opening_id) end,
    case when v_unit.project_id is not null then public._work_unit_fact_peek_epoch('project', v_unit.project_id) end,
    p_applied_unit_intent, p_before, p_applied_unit_intent->>'reason'
  ) returning id into v_new_id;
  insert into public.work_unit_fact_current(unit_id, current_revision_id, current_revision)
    values (p_unit_id, v_new_id, v_new_rev)
  on conflict (unit_id) do update
    set current_revision_id = excluded.current_revision_id, current_revision = excluded.current_revision, updated_at = now();
end;
$$;
revoke all on function public._work_record_unit_fact(uuid, jsonb, jsonb, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. custom_work_command: restated from 20261031000000, with the observation
--    seam added to the unit/link branch only. Every other branch
--    (type/start/stop/session) is unchanged. p_data is never mutated -- the
--    replay check above and the custom_work_commands INSERT below both
--    still hash/store the caller's original envelope untouched; the merged
--    facts live in the separate `f` variable, exactly as before.
--
--    Corrected in the unit/link branch per the independent review (B2, B4,
--    B5, B8): the existing row wait is followed by a fresh active-actor
--    recheck; an absent row is created via INSERT ... ON CONFLICT(id) DO
--    NOTHING, refusing cleanly on a lost create race rather than silently
--    overwriting the winner with a blind UPSERT; the caller's ORIGINAL
--    facts are validated before any server value can merge over an invalid
--    supplied type; width/height/area_source/measurement_source changes are
--    detected and protected even for a brand-new unit's first legacy save.
-- ---------------------------------------------------------------------------
create or replace function public.custom_work_command(p_id uuid,p_action text,p_data jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  uid uuid:=auth.uid(); c public.custom_work_commands; u public.custom_work_units;
  s public.custom_work_sessions; sh public.time_shifts; oldj jsonb; outid uuid;
  jid uuid; oid uuid; at_time timestamptz; typ public.custom_work_types;
  expected uuid; target uuid; f jsonb; finish_time timestamptz;
  v_obs jsonb; v_obs_present boolean; v_obs_is_null boolean; v_expected_fact_rev numeric;
  v_old_w numeric; v_old_h numeric; v_old_src text; v_old_area text;
  v_new_w numeric; v_new_h numeric; v_new_src text; v_new_area text;
  v_event_kind text; v_width_in numeric; v_height_in numeric; v_m_unit text; v_m_source text; v_m_ref text; v_area text;
  v_estimated boolean; v_obs_actor uuid; v_reason text; v_raw_obs jsonb; v_protected boolean;
  v_origin_project uuid; v_origin_opening uuid; v_origin_kind text; v_origin_author uuid; v_origin_is_test boolean;
  v_legacy_source text; v_legacy_area text; v_norm_source text; v_norm_area text; v_origin_live_job uuid;
  v_cur_rev_num bigint; v_cur_fact_prior public.work_unit_fact_revisions;
  v_applied_intent jsonb; v_before_snapshot jsonb;
begin
  if not public.custom_work_internal() then raise exception 'An active Forge crew login is required.' using errcode='42501'; end if;
  if p_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid work request.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,7282));
  -- Shares the lock with legacy-session inserts, preventing two surfaces/devices accruing together.
  perform pg_advisory_xact_lock(hashtextextended(uid::text,7281));
  select * into c from public.custom_work_commands where id=p_id;
  if found then
    if c.profile_id<>uid or c.payload<>jsonb_build_object('action',p_action,'data',p_data) then raise exception 'This retry belongs to a different request.'; end if;
    return c.result_id;
  end if;
  if p_action='type' then
    if not public._is_lead(uid) or public.is_test_profile(uid) then raise exception 'Only foremen and above can manage shared types.'; end if;
    target:=(p_data->>'id')::uuid;
    select * into typ from public.custom_work_types where id=target for update;
    if coalesce(typ.revision,0)<>coalesce((p_data->>'revision')::int,-1) then raise exception 'This type changed. Refresh before saving.'; end if;
    oldj:=to_jsonb(typ);
    insert into public.custom_work_types(id,label,archived,revision) values(target,btrim(p_data->>'label'),coalesce((p_data->>'archived')::boolean,false),coalesce(typ.revision,0)+1)
    on conflict(id) do update set label=excluded.label,archived=excluded.archived,revision=excluded.revision;
    outid:=target;
  elsif p_action in ('unit','link') then
    target:=(p_data->>'id')::uuid;
    select * into u from public.custom_work_units where id=target for update;
    -- Refresh active-actor status after the row wait (B4): another session
    -- could have retired/revoked this account while we waited for the lock.
    if not public.custom_work_internal() then raise exception 'An active Forge crew login is required.' using errcode='42501'; end if;
    jid:=nullif(p_data->>'project_id','')::uuid;
    oid:=nullif(p_data->>'opening_id','')::uuid;
    -- Current/destination context precedes operational CAS too: a hidden-job
    -- caller must not distinguish a correct unit revision from a guessed one.
    -- This applies to all unit/link edits; nondimensional author/lead role
    -- compatibility is preserved below, subject to actual source visibility.
    if (u.project_id is not null and not public._ai_job_visible(u.project_id,uid))
      or (jid is not null and not public._ai_job_visible(jid,uid)) then
      raise exception 'Unit source is unavailable.' using errcode='42501';
    end if;
    if oid is not null and not exists(select 1 from project_openings where id=oid and project_id=jid and removed_at is null) then
      raise exception 'Unit source is unavailable.' using errcode='42501';
    end if;
    if u.opening_id is not null and not exists(select 1 from project_openings where id=u.opening_id and project_id=u.project_id and removed_at is null) then
      raise exception 'Unit source is unavailable.' using errcode='42501';
    end if;
    if u.id is not null and u.created_by<>uid and not public._is_lead(uid) then raise exception 'Only the author or a foreman can edit this unit.'; end if;
    if u.id is not null and coalesce(u.revision,0)<>coalesce((p_data->>'revision')::int,-1) then raise exception 'Unit details changed. Refresh before saving.'; end if;
    -- Retained evidence belongs to a previous physical unit. Ordinary creates
    -- cannot silently adopt it; restoration needs explicit reconciliation.
    if u.id is null and (exists(select 1 from public.work_unit_fact_current where unit_id=target)
      or exists(select 1 from public.work_unit_fact_revisions where unit_id=target)) then
      raise exception 'Unit identity requires reconciliation before reuse.' using errcode='23514';
    end if;
    if u.id is null and coalesce((p_data->>'revision')::int,-1)<>0 then raise exception 'Unit details changed. Refresh before saving.'; end if;
    if u.project_id is not null and jid is distinct from u.project_id and not public._is_lead(uid) then raise exception 'Ask a foreman to move a record already assigned to a job.'; end if;
    if u.id is not null and (jid is distinct from u.project_id or oid is distinct from u.opening_id) and length(btrim(coalesce(p_data->>'reason','')))<3 then raise exception 'Add a short reason for assigning or linking this record.'; end if;

    -- Unit dimension observation (20261108100000). f is validated against
    -- the ORIGINAL caller shape first (B8), before any server-derived value
    -- can merge over -- and thereby hide -- an invalid supplied type.
    f:=coalesce(p_data->'facts','{}');
    perform public.validate_custom_work_facts(f);
    v_old_w:=nullif(u.facts->>'width_in','')::numeric;
    v_old_h:=nullif(u.facts->>'height_in','')::numeric;
    v_old_src:=u.facts->>'measurement_source';
    v_old_area:=u.facts->>'area_source';
    v_cur_fact_prior:=null; v_cur_rev_num:=0;
    if u.id is not null then
      select r.* into v_cur_fact_prior from public.work_unit_fact_revisions r
        join public.work_unit_fact_current cu on cu.current_revision_id=r.id
        where cu.unit_id=u.id;
      if v_cur_fact_prior.id is not null then
        if v_cur_fact_prior.unit_incarnation_epoch is distinct from public._work_unit_fact_peek_epoch('unit_incarnation',target) then
          raise exception 'Unit identity requires reconciliation before reuse.' using errcode='23514';
        end if;
        v_cur_rev_num:=v_cur_fact_prior.revision;
      end if;
    end if;
    v_obs_present:=p_data ? 'dimension_observation';
    v_obs:=p_data->'dimension_observation';
    v_obs_is_null:=v_obs_present and jsonb_typeof(v_obs)='null';
    v_event_kind:=null; v_width_in:=null; v_height_in:=null; v_m_unit:=null; v_m_source:=null; v_m_ref:=null; v_area:=null;
    v_estimated:=null; v_obs_actor:=null; v_reason:=null; v_raw_obs:=null; v_origin_project:=null; v_origin_opening:=null;
    v_applied_intent:=null; v_before_snapshot:=null;
    v_origin_kind:='none'; v_origin_author:=null; v_origin_is_test:=null;
    v_legacy_source:=null; v_legacy_area:=null;
    if v_obs_present and jsonb_typeof(v_obs) not in ('object','null') then
      raise exception 'Invalid dimension observation.';
    end if;
    if v_obs_present then
      -- Strict type check before extraction (B8): a numeric STRING like "1"
      -- must refuse, not silently coerce.
      if jsonb_typeof(p_data->'expected_fact_revision') is distinct from 'number' then
        raise exception 'A valid expected fact revision is required with a new observation or reset.';
      end if;
      v_expected_fact_rev:=(p_data->>'expected_fact_revision')::numeric;
      if v_expected_fact_rev<>trunc(v_expected_fact_rev) or v_expected_fact_rev<0 or v_expected_fact_rev>9007199254740991 then
        raise exception 'A valid expected fact revision is required with a new observation or reset.';
      end if;
    end if;
    if v_obs_is_null then
      if jsonb_typeof(p_data->'dimension_observation_reason') is distinct from 'string' then
        raise exception 'Add a short reason for clearing this observation.';
      end if;
      v_reason:=btrim(p_data->>'dimension_observation_reason');
      if length(v_reason) not between 3 and 500 then raise exception 'Add a short reason for clearing this observation.'; end if;
      v_event_kind:='cleared';
      f:=f-'width_in'-'height_in'-'measurement_source'-'area_source';
    elsif v_obs_present then
      select n.width_in,n.height_in,n.m_unit,n.m_source,n.m_ref into v_width_in,v_height_in,v_m_unit,v_m_source,v_m_ref
        from public._work_unit_normalize_observation(v_obs) n;
      -- Server mapping, exact per contract (B3): measured->Measured,
      -- plans->From plans, estimated->Estimated.
      v_area:=case v_m_source when 'measured' then 'Measured' when 'plans' then 'From plans' when 'estimated' then 'Estimated' end;
      v_estimated:=(v_m_source='estimated');
      v_obs_actor:=uid;
      v_event_kind:='observation';
      v_raw_obs:=jsonb_build_object('width',v_obs->'width','height',v_obs->'height','unit',v_m_unit,'source',v_m_source,'sourceReference',v_m_ref);
      -- f's own width_in/height_in/measurement_source/area_source, if
      -- present, are already known valid-typed by the pre-merge validation
      -- above (B8), so this comparison is safe rather than coercive.
      if f ? 'width_in' and (f->>'width_in')::numeric is distinct from v_width_in then raise exception 'Supplied width does not match the observation.'; end if;
      if f ? 'height_in' and (f->>'height_in')::numeric is distinct from v_height_in then raise exception 'Supplied height does not match the observation.'; end if;
      if f ? 'measurement_source' and f->>'measurement_source' is distinct from v_m_source then raise exception 'Supplied measurement source does not match the observation.'; end if;
      if f ? 'area_source' and f->>'area_source' is distinct from v_area then raise exception 'Supplied area source does not match the observation.'; end if;
      f:=f || jsonb_build_object('width_in',v_width_in,'height_in',v_height_in,'measurement_source',v_m_source,'area_source',v_area);
      if f ? 'unknown_fields' then
        -- Only deliberately clear a VALID string marker naming width_in/
        -- height_in (B8); anything else -- including an invalid entry --
        -- passes through unchanged for the final validator to judge.
        f:=jsonb_set(f,'{unknown_fields}',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(f->'unknown_fields') x
          where not (jsonb_typeof(x)='string' and x#>>'{}' in ('width_in','height_in'))));
      end if;
    end if;
    v_new_w:=nullif(f->>'width_in','')::numeric; v_new_h:=nullif(f->>'height_in','')::numeric;
    v_new_src:=f->>'measurement_source'; v_new_area:=f->>'area_source';
    -- Protects area_source alongside measurement_source/width/height (B3),
    -- and -- unlike the earlier draft -- applies to a brand-new unit's
    -- first legacy save too, not only an existing row (B2): an empty
    -- legacy create stays silent, but a legacy create with real dimensions
    -- is a genuine new assertion, not historical backfill.
    if v_event_kind is null and (v_new_w,v_new_h,v_new_src,v_new_area) is distinct from (v_old_w,v_old_h,v_old_src,v_old_area) then
      if v_new_w is not null and v_new_h is not null then v_event_kind:='legacy_observation'; else v_event_kind:='incomplete'; end if;
      -- Complete server intent from the FINAL validated flat facts (B2) --
      -- never left null while the unit itself carries real dimensions.
      v_width_in:=v_new_w; v_height_in:=v_new_h;
      v_norm_source:=public._work_unit_fact_legacy_source(v_new_src);
      v_norm_area:=public._work_unit_fact_legacy_source(v_new_area);
      -- Unknown or contradictory labels never become trusted provenance.
      if (v_new_src is null or v_norm_source is not null)
        and (v_new_area is null or v_norm_area is not null)
        and (v_norm_source is null or v_norm_area is null or v_norm_source=v_norm_area) then
        v_m_source:=coalesce(v_norm_source,v_norm_area);
      end if;
      v_estimated:=case when v_norm_source='estimated' or v_norm_area='estimated' then true
        when v_m_source is not null then false else null end;
    end if;
    if v_event_kind is null and u.id is not null and (jid is distinct from u.project_id or oid is distinct from u.opening_id)
        and v_cur_fact_prior.id is not null then
      v_event_kind:='relink';
      v_width_in:=v_cur_fact_prior.width_in; v_height_in:=v_cur_fact_prior.height_in;
      v_m_unit:=v_cur_fact_prior.measurement_unit; v_m_source:=v_cur_fact_prior.measurement_source; v_m_ref:=v_cur_fact_prior.source_reference;
      v_estimated:=v_cur_fact_prior.estimated; v_obs_actor:=v_cur_fact_prior.observation_actor_id; v_raw_obs:=v_cur_fact_prior.raw_observation;
      -- Origin is carried forward UNCHANGED through a pure relink (B1) --
      -- never reset to the new destination job.
      v_origin_project:=v_cur_fact_prior.origin_project_id; v_origin_opening:=v_cur_fact_prior.origin_opening_id;
      v_origin_kind:=v_cur_fact_prior.origin_kind; v_origin_author:=v_cur_fact_prior.origin_author_id;
      v_origin_is_test:=v_cur_fact_prior.origin_is_test;
    end if;
    if v_event_kind is not null and v_event_kind not in ('relink','cleared')
      and (v_new_w is not null or v_new_h is not null or v_new_src is not null or v_new_area is not null) then
      -- A genuinely fresh assertion (new/legacy/incomplete) establishes its
      -- own origin at the current binding; 'relink' already set it above
      -- from the predecessor, and 'cleared' has no observation to attribute.
      v_origin_project:=jid; v_origin_opening:=oid;
      v_origin_kind:=case when jid is null then 'unassigned' else 'job' end;
      v_origin_author:=coalesce(u.created_by,uid);
      v_origin_is_test:=public.is_test_profile(v_origin_author);
    end if;
    -- Every recorded event is protected, including a relink of a legacy/
    -- incomplete (not-yet-raw) prior observation (B4): a relink only ever
    -- reaches this point when v_cur_fact_prior.id is not null, so there is
    -- always something real being administered.
    v_protected:=v_event_kind is not null;
    if v_protected then
      -- All actors, including authors and new creators, pass source checks.
      -- Prior origin is required even for replacement/reset: before_snapshot
      -- preserves that evidence. No source IDs are exposed on a refusal.
      if (u.id is not null and not public._work_unit_fact_context_visible(uid,
          case when u.project_id is null then 'unassigned' else 'job' end,
          u.project_id,u.opening_id,u.created_by,public.is_test_profile(u.created_by),false))
        or not public._work_unit_fact_context_visible(uid,
          case when jid is null then 'unassigned' else 'job' end,
          jid,oid,coalesce(u.created_by,uid),public.is_test_profile(coalesce(u.created_by,uid)),false)
        or (v_cur_fact_prior.id is not null and not public._work_unit_fact_context_visible(uid,
          v_cur_fact_prior.origin_kind,v_cur_fact_prior.origin_project_id,v_cur_fact_prior.origin_opening_id,
          v_cur_fact_prior.origin_author_id,v_cur_fact_prior.origin_is_test,true)) then
        raise exception 'Unit source is unavailable.' using errcode='42501';
      end if;
      select project_id into v_origin_live_job from public.project_openings
        where id=v_cur_fact_prior.origin_opening_id and removed_at is null;
      if not public._work_unit_fact_can_edit_dimensions(uid,coalesce(u.created_by,uid),
          array[u.project_id,jid,v_cur_fact_prior.origin_project_id,v_origin_live_job]) then
        raise exception 'Only the author or an authorized foreman, supervisor or owner can change this unit''s dimensions.' using errcode='42501';
      end if;
    end if;
    -- Do not disclose even a private fact-revision mismatch before source
    -- authorization. Input types above are caller-owned, revision is evidence.
    if v_obs_present and v_expected_fact_rev::bigint<>v_cur_rev_num then
      raise exception 'Unit observation changed. Refresh before saving.';
    end if;
    v_legacy_source:=v_new_src; v_legacy_area:=v_new_area;

    perform public.validate_custom_work_facts(f);

    -- Absent row: FOR UPDATE locked nothing, so two concurrent creators can
    -- both reach here (B5). Decide via a real INSERT conflict rather than
    -- a blind UPSERT -- the loser refuses cleanly instead of silently
    -- overwriting the winner's row, author, and private fact.
    if u.id is null then
      insert into public.custom_work_units(id,project_id,opening_id,created_by,label,type_label,facts,revision)
      values(target,jid,oid,uid,btrim(p_data->>'label'),coalesce(nullif(btrim(p_data->>'type_label'),''),'Unknown'),f,1)
      on conflict(id) do nothing;
      if not found then raise exception 'Unit details changed. Refresh before saving.'; end if;
      -- Recheck after the INSERT wait too: a competing create/delete could
      -- have left retained evidence after our initial absent-row check.
      if exists(select 1 from public.work_unit_fact_current where unit_id=target)
        or exists(select 1 from public.work_unit_fact_revisions where unit_id=target) then
        raise exception 'Unit identity requires reconciliation before reuse.' using errcode='23514';
      end if;
      oldj:=null;
    else
      oldj:=to_jsonb(u);
      update public.custom_work_units set project_id=jid,opening_id=oid,label=btrim(p_data->>'label'),
        type_label=coalesce(nullif(btrim(p_data->>'type_label'),''),'Unknown'),facts=f,revision=u.revision+1,updated_at=now()
        where id=target;
    end if;
    update public.custom_work_units set legacy_time_present=exists(select 1 from unit_sessions where opening_id=oid) or exists(select 1 from task_sessions where opening_id=oid) where id=target;
    -- Attribution moves the observation, never the underlying payroll shift.
    update public.custom_work_sessions set project_id=jid,review_required=review_required or exists(select 1 from time_shifts t where t.id=shift_id and (t.project_id is distinct from jid or t.status in ('needs_finish','rejected','voided'))),revision=revision+1 where unit_id=target and project_id is distinct from jid;
    outid:=target;
    if v_event_kind is not null then
      -- jsonb_strip_nulls: a key assigned the PL/pgSQL `null` scalar must
      -- not become a stored JSON null (B2) -- jsonb_build_object always
      -- encodes a SQL NULL argument as JSON null, and the helper's
      -- raw_observation column CHECK only accepts SQL NULL or an object.
      -- Stripping the key entirely keeps `->` extraction returning true
      -- SQL NULL on the other side.
      v_applied_intent:=jsonb_strip_nulls(jsonb_build_object('event_kind',v_event_kind,'width_in',v_width_in,'height_in',v_height_in,
        'measurement_unit',v_m_unit,'measurement_source',v_m_source,'source_reference',v_m_ref,
        'raw_observation',v_raw_obs,'estimated',v_estimated,'observation_actor_id',v_obs_actor,'reason',v_reason,
        'origin_project_id',v_origin_project,'origin_opening_id',v_origin_opening,
        'origin_kind',v_origin_kind,'origin_author_id',v_origin_author,'origin_is_test',v_origin_is_test,
        'legacy_measurement_source',v_legacy_source,'legacy_area_source',v_legacy_area));
      v_before_snapshot:=jsonb_strip_nulls(jsonb_build_object('width_in',v_old_w,'height_in',v_old_h,'measurement_source',v_old_src,'area_source',v_old_area,
        'raw_observation',case when v_cur_fact_prior.id is not null then v_cur_fact_prior.raw_observation else null end));
    end if;
  elsif p_action in ('start','stop') then
    at_time:=coalesce((p_data->>'at')::timestamptz,now());
    if at_time>now()+interval '2 minutes' or at_time<now()-interval '7 days' then raise exception 'This work time needs a foreman review. Check the device clock.'; end if;
    expected:=nullif(p_data->>'expected_session_id','')::uuid;
    select * into s from public.custom_work_sessions where profile_id=uid and ended_at is null for update;
    if s.id is null and expected is not null then
      select * into s from public.custom_work_sessions where id=expected and profile_id=uid and ended_at is not null and end_reason in ('clock_out','stop') for update;
      if s.id is not null and (at_time<s.started_at or at_time>s.ended_at) then s.id:=null; end if;
    end if;
    if s.id is distinct from expected then raise exception 'Your current work changed. Sync and review before retrying.'; end if;
    if s.id is not null and at_time<s.started_at then raise exception 'The finish cannot be before the start.'; end if;
    if p_action='start' then
      select * into sh from public.time_shifts where id=(p_data->>'shift_id')::uuid and profile_id=uid for update;
      if sh.id is null or sh.status not in ('open','submitted','approved') or sh.clock_in_at>at_time or (sh.clock_out_at is not null and sh.clock_out_at<=at_time) or (sh.break_started_at is not null and sh.break_started_at<=at_time) then raise exception 'Clock in or resume your job clock before starting work.'; end if;
      -- The job clock already enforces its safety step; do not ask a second time.
      if now()-sh.clock_in_at>interval '16 hours' and sh.clock_out_at is null then raise exception 'Finish the older job clock before starting new work.'; end if;
      target:=nullif(p_data->>'unit_id','')::uuid;
      jid:=sh.project_id;
      -- Both kinds of start wait for today's toolbox signature, right after the
      -- open-shift check above (20261031000000): a UNIT start (a unit_id) meets
      -- the same gate every other unit-start RPC passes; PREP TIME (no unit_id;
      -- kind 'idle') meets its own, in its own sentence — the owner's answer of
      -- 2026-09-24. The two lines are the only change to this branch.
      if target is not null then
        perform public._unit_work_gate(uid);
        select * into u from public.custom_work_units where id=target for update;
        if u.id is null or (u.project_id is null and u.created_by<>uid and not public._is_lead(uid)) then raise exception 'That custom unit is unavailable.'; end if;
        if u.project_id is not null and u.project_id is distinct from sh.project_id then raise exception 'Switch your job clock to this unit''s job first.'; end if;
        jid:=u.project_id;
      else
        perform public._prep_time_gate(uid);
        if length(btrim(coalesce(p_data->>'description','')))=0 then raise exception 'Describe your idle time.'; end if;
      end if;
      if jid is not null and not exists(select 1 from projects where id=jid and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
      -- Never rewrite a newer activity based on a stale/offline start.
      if exists(select 1 from public.custom_work_sessions where profile_id=uid and id is distinct from s.id and coalesce(ended_at,'infinity')>at_time) or exists(select 1 from public.unit_sessions where profile_id=uid and (started_at>at_time or (ended_at is not null and ended_at>at_time))) or exists(select 1 from public.task_sessions where profile_id=uid and (started_at>at_time or (ended_at is not null and ended_at>at_time))) then raise exception 'This overlaps recorded work. Ask a foreman to review the timeline.'; end if;
      if at_time<now()-interval '2 minutes' and exists(select 1 from opening_phases where started_by=uid and status='active' and paused_at is null) then raise exception 'A flashing timer is now running. Ask a foreman to reconcile the older work.'; end if;
      update public.task_sessions set ended_at=at_time where profile_id=uid and ended_at is null;
      update public.unit_sessions set ended_at=at_time,end_reason='handoff' where profile_id=uid and ended_at is null;
      update public.opening_phases set paused_at=at_time where started_by=uid and status='active' and paused_at is null;
    end if;
    if s.id is not null then
      oldj:=to_jsonb(s);
      update public.custom_work_sessions set ended_at=at_time,end_reason=case when p_action='start' then 'switch' else 'stop' end,
        outcome=nullif(p_data->>'outcome',''),description=coalesce(p_data->>'finish_note',description),delay_reason=coalesce(p_data->>'delay_reason',delay_reason),revision=revision+1 where id=s.id;
      insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value) select project_id,uid,id,'stop',oldj,to_jsonb(x) from public.custom_work_sessions x where id=s.id;
    end if;
    if p_action='start' then
      -- A later visit reopens completion; the worker can mark the whole install done again.
      update public.custom_work_units set facts=jsonb_set(facts,'{installation_complete}','"No"'),revision=revision+1,updated_at=now() where id=target and facts->>'installation_complete'='Yes';
      if found then
        insert into custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason) select jid,uid,id,'reopen',to_jsonb(u),to_jsonb(x),'New work visit' from custom_work_units x where id=target;
      end if;
      outid:=(p_data->>'id')::uuid;
      insert into public.custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,participation,stage,description,started_at,ended_at,end_reason,shift_status,review_required)
      values(outid,uid,sh.id,jid,target,case when target is null then 'idle' else 'unit' end,coalesce(p_data->>'participation','install'),case when target is null then 'Idle time' else coalesce(p_data->>'stage','Installing') end,coalesce(p_data->>'description',''),at_time,sh.clock_out_at,case when sh.clock_out_at is not null then 'clock_out' end,sh.status,jid is distinct from sh.project_id or (sh.clock_out_at is not null and coalesce(sh.break_seconds,0)>0));
      oldj:=null;
    else outid:=s.id; jid:=s.project_id;
    end if;
  elsif p_action='session' then
    select * into s from public.custom_work_sessions where id=(p_data->>'id')::uuid for update;
    if s.id is null or (s.profile_id<>uid and not public._is_lead(uid)) then raise exception 'Only the worker or a foreman can correct this record.'; end if;
    if s.project_id is not null and not exists(select 1 from projects where id=s.project_id and deleted_at is null) then raise exception 'That job is unavailable.'; end if;
    if s.revision<>coalesce((p_data->>'revision')::int,-1) then raise exception 'This record changed. Refresh before saving.'; end if;
    if length(btrim(coalesce(p_data->>'reason','')))<3 then raise exception 'Add a correction reason.'; end if;
    if s.kind='idle' and length(btrim(coalesce(p_data->>'description',s.description)))=0 then raise exception 'Describe your idle time.'; end if;
    oldj:=to_jsonb(s); jid:=s.project_id; outid:=s.id;
    if coalesce((p_data->>'review_time')::boolean,false) or p_data ? 'started_at' or p_data ? 'ended_at' then
      if not public._is_lead(uid) then raise exception 'Only foremen and above can correct captured times.'; end if;
      if s.ended_at is null then raise exception 'Stop the activity before correcting its time.'; end if;
      select * into sh from time_shifts where id=s.shift_id for update;
      at_time:=coalesce((p_data->>'started_at')::timestamptz,s.started_at);
      finish_time:=coalesce((p_data->>'ended_at')::timestamptz,s.ended_at);
      if sh.status not in ('submitted','approved') or sh.clock_out_at is null or s.project_id is distinct from sh.project_id or s.project_id is null
        or at_time<sh.clock_in_at or finish_time>sh.clock_out_at or finish_time<at_time or finish_time-at_time>interval '16 hours' then
        raise exception 'First resolve the job, timecard, or shift bounds. Captured time must fit its closed job clock.';
      end if;
      if exists(select 1 from custom_work_sessions x where x.profile_id=s.profile_id and x.id<>s.id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time)
        or exists(select 1 from unit_sessions x where x.profile_id=s.profile_id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time)
        or exists(select 1 from task_sessions x where x.profile_id=s.profile_id and x.started_at<finish_time and coalesce(x.ended_at,'infinity')>at_time) then
        raise exception 'The corrected interval overlaps other recorded work.';
      end if;
      if extract(epoch from finish_time-at_time)+(select coalesce(sum(extract(epoch from ended_at-started_at)),0) from custom_work_sessions where shift_id=s.shift_id and id<>s.id)
        >extract(epoch from sh.clock_out_at-sh.clock_in_at)-coalesce(sh.break_seconds,0)+1 then
        raise exception 'Captured activity exceeds the worked shift time after breaks. Review the other intervals too.';
      end if;
      update public.custom_work_sessions set started_at=at_time,ended_at=finish_time,review_required=false,end_reason='reviewed' where id=s.id;
    end if;
    update public.custom_work_sessions set description=coalesce(p_data->>'description',description),outcome=nullif(p_data->>'outcome',''),delay_reason=coalesce(p_data->>'delay_reason',delay_reason),revision=revision+1 where id=s.id;
  else raise exception 'Unknown work action.';
  end if;
  -- Audit values live behind the same job/author boundary as the records.
  insert into public.custom_work_history(project_id,actor_id,entity_id,action,before_value,after_value,reason)
  values(jid,uid,coalesce(outid,p_id),p_action,oldj,
    case when p_action in ('unit','link') then (select to_jsonb(x) from public.custom_work_units x where id=outid)
      when p_action='type' then (select to_jsonb(x) from public.custom_work_types x where id=outid)
      else (select to_jsonb(x) from public.custom_work_sessions x where id=outid) end,coalesce(p_data->>'reason',''));
  insert into public.custom_work_commands(id,profile_id,payload,result_id) values(p_id,uid,jsonb_build_object('action',p_action,'data',p_data),outid);
  if p_action in ('unit','link') and v_event_kind is not null then
    perform public._work_record_unit_fact(p_id,v_applied_intent,v_before_snapshot,outid);
  end if;
  return outid;
end; $$;
revoke all on function public.custom_work_command(uuid,text,jsonb) from public,anon;
grant execute on function public.custom_work_command(uuid,text,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Permission-safe read. Independently authorizes: the unit's CURRENT
--    binding (live), the fact revision's immutable ORIGIN (B1 -- including
--    the origin opening's own CURRENT project, re-derived live rather than
--    trusted from the stored snapshot, since an opening can move to a
--    different project after the fact), and a standalone origin's QA
--    partition. Any one being hidden/deleted/removed refuses the whole
--    projection generically, never a partial result.
-- ---------------------------------------------------------------------------

create function public.work_unit_fact_current_read(p_unit_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_unit public.custom_work_units;
  v_rev public.work_unit_fact_revisions;
begin
  if v_actor is null or not public.custom_work_internal() then
    raise exception using errcode = '42501', message = 'Sign-in required.';
  end if;
  select * into v_unit from public.custom_work_units where id = p_unit_id;
  if v_unit.id is null then
    raise exception using errcode = '23514', message = 'Unit is unavailable.';
  end if;
  if not public._work_unit_fact_context_visible(v_actor,
      case when v_unit.project_id is null then 'unassigned' else 'job' end,
      v_unit.project_id,v_unit.opening_id,v_unit.created_by,public.is_test_profile(v_unit.created_by),false) then
    raise exception using errcode = '23514', message = 'Unit is unavailable.';
  end if;
  select r.* into v_rev from public.work_unit_fact_revisions r
    join public.work_unit_fact_current cu on cu.current_revision_id = r.id
    where cu.unit_id = p_unit_id;
  if v_rev.id is null then
    return jsonb_build_object('protocolVersion', 1, 'unitId', p_unit_id, 'revision', 0, 'observation', null);
  end if;
  if v_rev.unit_incarnation_epoch is distinct from public._work_unit_fact_peek_epoch('unit_incarnation',p_unit_id)
    or not public._work_unit_fact_context_visible(v_actor,v_rev.origin_kind,
      v_rev.origin_project_id,v_rev.origin_opening_id,v_rev.origin_author_id,v_rev.origin_is_test,true) then
    raise exception using errcode = '23514', message = 'Unit is unavailable.';
  end if;
  return jsonb_build_object(
    'protocolVersion', 1, 'unitId', p_unit_id, 'revision', v_rev.revision, 'eventKind', v_rev.event_kind,
    'observation', case when v_rev.raw_observation is not null then
      jsonb_build_object('width', v_rev.raw_observation->'width', 'height', v_rev.raw_observation->'height',
        'unit', v_rev.measurement_unit, 'source', v_rev.measurement_source, 'sourceReference', v_rev.source_reference,
        'estimated', v_rev.estimated)
      else null end,
    'widthIn', v_rev.width_in, 'heightIn', v_rev.height_in,
    'observationActorId', v_rev.observation_actor_id, 'recordedAt', v_rev.created_at
  );
end;
$$;
revoke all on function public.work_unit_fact_current_read(uuid) from public, anon;
grant execute on function public.work_unit_fact_current_read(uuid) to authenticated;

-- work_unit_fact_revisions.project_id is a direct project-scoping column;
-- every migration that creates one must end with this call (20260967000000).
select public.attach_sandbox_guards();
commit;
