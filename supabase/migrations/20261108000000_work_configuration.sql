-- Versioned activity/menu configuration APIs over the dormant private
-- substrate from 20261107020000. No activity capture engine, source
-- callback, timing write, or personal-activity-state transition is added
-- here. This slice is reviewable, not released: see
-- docs/work-configuration.md for exact scope, every deliberate scoping
-- choice, and the open questions left for the parent.
--
-- Every mutating RPC follows one order: real auth.uid() -> the single
-- dedicated configuration gate (pg_advisory_xact_lock(7710,0), chosen from
-- the unused 7710/7711 pair; 7711 stays reserved for a future split) ->
-- a FRESH re-read of caller authority (never a value captured before the
-- wait) -> exact-replay / conflicting-reuse check against
-- work_configuration_commands -> input/typed-field validation -> the
-- domain compare-and-swap -> one immutable receipt, all inside the same
-- transaction. A CAS mismatch or validation failure raises and rolls back
-- the whole transaction; nothing partial is ever stored. This is
-- intentionally the same conservative single-gate shape
-- ASTRA-CAPTURE-SQL-CONTRACT.md asks for on the capture engine, reused here
-- for configuration instead of personal timing.
--
-- receipts: work_configuration_commands is the only place a command_id is
-- remembered. The SAME command_id with the SAME actor and the SAME
-- canonical payload hash replays the stored result and mutates nothing
-- further. The same command_id from a DIFFERENT actor never returns that
-- receipt's contents (raises instead of leaking it). The same command_id
-- with a CHANGED payload is refused rather than silently overwriting the
-- original. Canonical hashing relies on jsonb's own normalized key
-- ordering on cast to text (unlike json, jsonb does not preserve input key
-- order), over core pg_catalog.sha256 -- no pgcrypto/extension-schema
-- dependency, matching 20261106000000's reasoning.
begin;

-- Existing immutable foundation versions keep their publication instant as
-- their immediate effective time. New RPC publications store both explicitly.
-- No historical version body or timestamp is rewritten by this additive DDL.
alter table public.work_activity_definition_versions add column effective_from timestamptz
  check (effective_from is null or (isfinite(effective_from) and effective_from >= published_at));
alter table public.work_capture_menu_versions add column effective_from timestamptz
  check (effective_from is null or (isfinite(effective_from) and effective_from >= published_at));

-- ---------------------------------------------------------------------------
-- 1. Caller authority -- parameterized, because a grant target is not
--    always the caller. custom_work_internal() (20261024000000) reads only
--    auth.uid(); _is_lead (20260718050000) answers a coarser "lead-level"
--    question the brief explicitly says not to reuse here. This mirrors
--    its exclusions (retired/revoked/partner/role) but takes an explicit
--    uid so a grant RPC can ask "is THIS OTHER profile an active internal
--    foreman" without trusting any client-supplied role or preview state.
-- ---------------------------------------------------------------------------

create function public._work_config_internal(p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_uid is not null and exists (
    select 1 from public.profiles
     where id = p_uid and retired_at is null and access_revoked_at is null
       and not coalesce(is_partner, false)
       and role in ('installer', 'foreman', 'supervisor', 'owner'))
$$;
revoke all on function public._work_config_internal(uuid) from public, anon, authenticated;

create function public._work_config_is_owner(p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._work_config_internal(p_uid) and exists (
    select 1 from public.profiles where id = p_uid and role = 'owner')
$$;
revoke all on function public._work_config_is_owner(uuid) from public, anon, authenticated;

-- Company publishing/retiring is owner-only; this is deliberately the
-- supervisor-OR-owner helper used only for drafting/proposing and for job
-- menu selection/grant administration, never for publish/retire.
create function public._work_config_is_supervisor(p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._work_config_internal(p_uid) and exists (
    select 1 from public.profiles where id = p_uid and role in ('owner', 'supervisor'))
$$;
revoke all on function public._work_config_is_supervisor(uuid) from public, anon, authenticated;

create function public._work_config_is_foreman(p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._work_config_internal(p_uid) and exists (
    select 1 from public.profiles where id = p_uid and role = 'foreman')
$$;
revoke all on function public._work_config_is_foreman(uuid) from public, anon, authenticated;

-- Visibility alone is not foreman management authority: an owner/supervisor
-- may select a visible job's menu outright; a foreman additionally needs an
-- explicit, currently-active menu_select grant on that exact job.
-- _ai_job_visible (20261024000000) already encodes "currently visible/live"
-- (not deleted; sandbox/test-login scoping), reused rather than
-- reimplemented.
create function public._work_config_can_manage_menu(p_project_id uuid, p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._ai_job_visible(p_project_id, p_uid) and (
    public._work_config_is_supervisor(p_uid) or (
      public._work_config_is_foreman(p_uid) and exists (
        select 1 from public.work_job_management_grants
         where project_id = p_project_id and profile_id = p_uid
           and capability = 'menu_select' and revoked_at is null)))
$$;
revoke all on function public._work_config_can_manage_menu(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Typed field and draft-menu validation -- SQL is the authority, not the
--    client. Strict known keys; unknown keys, a null `required`, a
--    fractional bound on a `count` unit, an invalid/duplicated field or
--    option id, an invalid bound (min > max), an invalid field type, and
--    options on a type that is not single/multi-select are all refused.
--    "Fractional count" is this migration's literal reading of an ambiguous
--    owner phrase: a field whose `unit` is exactly 'count' cannot declare a
--    non-integer min/max. Flagged in docs/work-configuration.md for the
--    parent to confirm or correct; nothing here invents a final meaning
--    beyond that narrow, explicit rule.
-- ---------------------------------------------------------------------------

create function public._work_config_validate_typed_fields(p_fields jsonb) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  field jsonb; option_item jsonb; seen_ids text[] := '{}'; option_ids text[];
  field_id text; field_type text; unit_val text; min_val numeric; max_val numeric; option_id text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 40
      or octet_length(p_fields::text) > 20000 then
    raise exception using errcode = '23514', message = 'Invalid typed field list.';
  end if;
  for field in select value from jsonb_array_elements(p_fields) loop
    if jsonb_typeof(field) <> 'object'
        or not (field ?& array['id', 'label_en', 'label_es', 'type', 'required'])
        or exists (select 1 from jsonb_object_keys(field) k
          where k not in ('id', 'label_en', 'label_es', 'type', 'required', 'unit', 'min', 'max', 'options'))
        or jsonb_typeof(field->'id') <> 'string'
        or jsonb_typeof(field->'label_en') <> 'string'
        or jsonb_typeof(field->'label_es') <> 'string'
        or jsonb_typeof(field->'type') <> 'string'
        or jsonb_typeof(field->'required') <> 'boolean' then
      raise exception using errcode = '23514', message = 'Invalid typed field shape.';
    end if;
    field_id := field->>'id';
    if field_id !~ '^[a-z][a-z0-9_]{0,79}$' or field_id = any(seen_ids) then
      raise exception using errcode = '23514', message = 'Typed field id is invalid or duplicated.';
    end if;
    seen_ids := array_append(seen_ids, field_id);
    if length(btrim(field->>'label_en')) not between 1 and 120
        or length(btrim(field->>'label_es')) not between 1 and 120 then
      raise exception using errcode = '23514', message = 'Typed field label is invalid.';
    end if;
    field_type := field->>'type';
    if field_type not in ('text', 'number', 'boolean', 'single_select', 'multi_select') then
      raise exception using errcode = '23514', message = 'Typed field type is invalid.';
    end if;
    if field_type <> 'number' and (field ? 'unit' or field ? 'min' or field ? 'max') then
      raise exception using errcode = '23514', message = 'Only a number field may have units or numeric bounds.';
    end if;
    unit_val := null;
    if field ? 'unit' then
      if jsonb_typeof(field->'unit') <> 'string' or length(btrim(field->>'unit')) not between 1 and 40 then
        raise exception using errcode = '23514', message = 'Typed field unit is invalid.';
      end if;
      unit_val := field->>'unit';
      if unit_val not in ('count', 'in', 'ft', 'mm', 'cm', 'sq_ft', 'sq_m', 'min', 'h', 'lb', 'kg') then
        raise exception using errcode = '23514', message = 'Unknown typed field unit.';
      end if;
    end if;
    min_val := null; max_val := null;
    if field ? 'min' then
      if jsonb_typeof(field->'min') <> 'number' then
        raise exception using errcode = '23514', message = 'Typed field min is invalid.';
      end if;
      min_val := (field->>'min')::numeric;
    end if;
    if field ? 'max' then
      if jsonb_typeof(field->'max') <> 'number' then
        raise exception using errcode = '23514', message = 'Typed field max is invalid.';
      end if;
      max_val := (field->>'max')::numeric;
    end if;
    if min_val is not null and max_val is not null and min_val > max_val then
      raise exception using errcode = '23514', message = 'Typed field bounds are invalid.';
    end if;
    if unit_val = 'count' and (
        (min_val is not null and min_val <> trunc(min_val)) or
        (max_val is not null and max_val <> trunc(max_val))) then
      raise exception using errcode = '23514', message = 'A count field cannot have a fractional bound.';
    end if;
    if field ? 'options' then
      if field_type not in ('single_select', 'multi_select') then
        raise exception using errcode = '23514', message = 'Only a select field may carry options.';
      end if;
      if jsonb_typeof(field->'options') <> 'array' or jsonb_array_length(field->'options') not between 1 and 50 then
        raise exception using errcode = '23514', message = 'Invalid option list.';
      end if;
      option_ids := '{}';
      for option_item in select value from jsonb_array_elements(field->'options') loop
        if jsonb_typeof(option_item) <> 'object'
            or not (option_item ?& array['id', 'label_en', 'label_es'])
            or exists (select 1 from jsonb_object_keys(option_item) k where k not in ('id', 'label_en', 'label_es'))
            or jsonb_typeof(option_item->'id') <> 'string'
            or jsonb_typeof(option_item->'label_en') <> 'string'
            or jsonb_typeof(option_item->'label_es') <> 'string' then
          raise exception using errcode = '23514', message = 'Invalid typed field option shape.';
        end if;
        option_id := option_item->>'id';
        if option_id !~ '^[a-z][a-z0-9_]{0,79}$' or option_id = any(option_ids) then
          raise exception using errcode = '23514', message = 'Typed field option id is invalid or duplicated.';
        end if;
        if length(btrim(option_item->>'label_en')) not between 1 and 120
            or length(btrim(option_item->>'label_es')) not between 1 and 120 then
          raise exception using errcode = '23514', message = 'Typed field option label is invalid.';
        end if;
        option_ids := array_append(option_ids, option_id);
      end loop;
    elsif field_type in ('single_select', 'multi_select') then
      raise exception using errcode = '23514', message = 'A select field requires options.';
    end if;
  end loop;
end;
$$;
revoke all on function public._work_config_validate_typed_fields(jsonb) from public, anon, authenticated;

-- Draft menu items name activity CODES, not published version ids: a draft
-- may propose a menu before every activity on it has a published version.
-- Publishing a menu version still goes through the real, existing
-- work_capture_validate_menu trigger (20261107020000), which requires real
-- definitionId/versionId pairs; this validator never substitutes for that.
create function public._work_config_validate_menu_draft_items(p_items jsonb) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  item jsonb; code text; item_position integer;
  seen_codes text[] := '{}'; seen_positions integer[] := '{}';
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200
      or octet_length(p_items::text) > 40000 then
    raise exception using errcode = '23514', message = 'Invalid draft menu snapshot.';
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object'
        or not (item ?& array['code', 'position', 'enabled'])
        or exists (select 1 from jsonb_object_keys(item) k where k not in ('code', 'position', 'enabled'))
        or jsonb_typeof(item->'code') <> 'string'
        or jsonb_typeof(item->'position') <> 'number'
        or jsonb_typeof(item->'enabled') <> 'boolean' then
      raise exception using errcode = '23514', message = 'Invalid draft menu item.';
    end if;
    code := item->>'code';
    if code !~ '^[a-z][a-z0-9_]{0,79}$' or code = any(seen_codes) then
      raise exception using errcode = '23514', message = 'Draft menu item code is invalid or duplicated.';
    end if;
    if (item->>'position')::numeric <> trunc((item->>'position')::numeric) then
      raise exception using errcode = '23514', message = 'Draft menu position must be an integer.';
    end if;
    item_position := (item->>'position')::integer;
    if item_position not between 0 and 199 or item_position = any(seen_positions) then
      raise exception using errcode = '23514', message = 'Draft menu position is invalid or duplicated.';
    end if;
    seen_codes := array_append(seen_codes, code);
    seen_positions := array_append(seen_positions, item_position);
  end loop;
end;
$$;
revoke all on function public._work_config_validate_menu_draft_items(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Tables -- private, RLS enabled, every grant revoked, no policy. All
--    access is through the SECURITY DEFINER RPCs below. None of these link
--    to a project/opening, so none needs attach_sandbox_guards(); the two
--    existing job-scoped tables this file writes into
--    (work_job_menu_selections, work_job_management_grants) were already
--    guarded by 20261107020000.
-- ---------------------------------------------------------------------------

-- The only place a configuration command_id is ever remembered. Bounded at
-- 45000 bytes because a menu draft/publish payload can carry up to 200
-- items (<=40000 bytes by _work_config_validate_menu_draft_items / the
-- existing menu trigger) plus wrapper overhead; every other action's
-- payload is far smaller.
create table public.work_configuration_commands (
  command_id uuid primary key,
  actor_id uuid not null,
  action text not null check (action in (
    'propose_activity_draft', 'propose_menu_draft',
    'publish_activity_version', 'publish_menu_version',
    'retire_activity', 'retire_menu',
    'grant_job_capability', 'revoke_job_capability',
    'select_job_menu')),
  normalized_payload jsonb not null
    check (jsonb_typeof(normalized_payload) = 'object' and octet_length(normalized_payload::text) <= 45000),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  status text not null check (status = 'applied'),
  result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 20000)
);
create index work_configuration_commands_actor on public.work_configuration_commands(actor_id, received_at);

-- Mutable draft body, immutable history. The pointer row is the ONLY
-- mutable thing in this slice's new schema: expected_revision CAS reads and
-- advances it; the revision itself is forever in work_configuration_draft_revisions.
create table public.work_configuration_draft_revisions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('activity', 'menu')),
  code text not null check (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  body jsonb not null check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 45000),
  proposed_by uuid not null,
  proposed_at timestamptz not null default now(),
  predecessor_id uuid references public.work_configuration_draft_revisions(id),
  unique (kind, code, revision),
  check (predecessor_id is null or predecessor_id <> id)
);
create table public.work_configuration_draft_pointers (
  kind text not null check (kind in ('activity', 'menu')),
  code text not null check (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  revision bigint not null check (revision between 0 and 9007199254740991),
  latest_draft_id uuid not null references public.work_configuration_draft_revisions(id),
  updated_at timestamptz not null default now(),
  primary key (kind, code)
);

alter table public.work_configuration_commands enable row level security;
revoke all on table public.work_configuration_commands from public, anon, authenticated;
alter table public.work_configuration_draft_revisions enable row level security;
revoke all on table public.work_configuration_draft_revisions from public, anon, authenticated;
alter table public.work_configuration_draft_pointers enable row level security;
revoke all on table public.work_configuration_draft_pointers from public, anon, authenticated;

-- work_capture_immutable_record() (20261107020000) is a generic "raise and
-- refuse" trigger with no table-specific logic; reused here rather than
-- duplicated.
create trigger work_capture_record_immutable before update or delete
  on public.work_configuration_commands
  for each row execute function public.work_capture_immutable_record();
create trigger work_capture_record_immutable before update or delete
  on public.work_configuration_draft_revisions
  for each row execute function public.work_capture_immutable_record();

comment on table public.work_configuration_commands is
  'Private immutable configuration command receipts. Exact replay (same actor, same canonical payload hash) returns the stored result; a different actor or payload on the same command_id is refused, never overwritten or leaked.';
comment on table public.work_configuration_draft_pointers is
  'The only mutable row per (kind,code) draft lineage -- CAS target for propose_*_draft. History lives in work_configuration_draft_revisions, which is append-only.';

-- ---------------------------------------------------------------------------
-- 4. Receipt replay / storage helpers, shared by every mutating RPC below.
-- ---------------------------------------------------------------------------

create function public._work_config_replay(p_command_id uuid, p_actor uuid, p_action text, p_payload_hash text, p_payload jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_row public.work_configuration_commands;
begin
  select * into v_row from public.work_configuration_commands where command_id = p_command_id;
  if not found then return null; end if;
  if v_row.actor_id <> p_actor then
    raise exception using errcode = '42501', message = 'That command id belongs to a different actor.';
  end if;
  if v_row.action is distinct from p_action or v_row.payload_hash is distinct from p_payload_hash
      or v_row.normalized_payload is distinct from p_payload then
    raise exception using errcode = '23514', message = 'That command id was already used for a different request.';
  end if;
  return v_row.result;
end;
$$;
revoke all on function public._work_config_replay(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

create function public._work_config_store_receipt(
  p_command_id uuid, p_actor uuid, p_action text, p_payload jsonb, p_payload_hash text, p_result jsonb
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.work_configuration_commands
    (command_id, actor_id, action, normalized_payload, payload_hash, status, result)
  values (p_command_id, p_actor, p_action, p_payload, p_payload_hash, 'applied', p_result)
$$;
revoke all on function public._work_config_store_receipt(uuid, uuid, text, jsonb, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Draft/propose -- owner or supervisor. Pins no company version; only
--    advances the private draft lineage for that stable code.
-- ---------------------------------------------------------------------------

create function public.work_propose_activity_draft(
  p_command_id uuid, p_code text, p_expected_revision bigint, p_scope text,
  p_label_en text, p_label_es text, p_machine_selection boolean, p_typed_fields jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb;
  v_cur_rev bigint; v_cur_latest uuid; v_new_rev bigint; v_new_id uuid; v_body jsonb; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if public.is_test_profile(v_actor) or not public._work_config_is_supervisor(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner or supervisor may draft company configuration.';
  end if;
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,79}$' then
    raise exception using errcode = '23514', message = 'Invalid activity code.';
  end if;
  if p_scope is null or p_scope not in ('general', 'specific') then
    raise exception using errcode = '23514', message = 'Invalid activity scope.';
  end if;
  if p_label_en is null or p_label_es is null or length(btrim(p_label_en)) not between 1 and 120 or length(btrim(p_label_es)) not between 1 and 120 then
    raise exception using errcode = '23514', message = 'Invalid activity label.';
  end if;
  if p_machine_selection is null then
    raise exception using errcode = '23514', message = 'Machine selection must be a boolean.';
  end if;
  perform public._work_config_validate_typed_fields(p_typed_fields);
  if p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '23514', message = 'A valid expected draft revision is required.';
  end if;
  v_payload := jsonb_build_object('code', p_code, 'expectedRevision', p_expected_revision, 'scope', p_scope,
    'labelEn', p_label_en, 'labelEs', p_label_es, 'machineSelection', p_machine_selection, 'typedFields', p_typed_fields);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'propose_activity_draft', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  select revision, latest_draft_id into v_cur_rev, v_cur_latest
    from public.work_configuration_draft_pointers
   where kind = 'activity' and code = p_code for update;
  if not found then v_cur_rev := 0; v_cur_latest := null; end if;
  if v_cur_rev <> p_expected_revision then
    raise exception using errcode = '23514', message = 'Draft revision changed; reload and retry.';
  end if;
  v_new_rev := v_cur_rev + 1;
  v_body := jsonb_build_object('scope', p_scope, 'labelEn', p_label_en, 'labelEs', p_label_es,
    'machineSelection', p_machine_selection, 'typedFields', p_typed_fields);
  insert into public.work_configuration_draft_revisions(kind, code, revision, body, proposed_by, predecessor_id)
    values ('activity', p_code, v_new_rev, v_body, v_actor, v_cur_latest) returning id into v_new_id;
  insert into public.work_configuration_draft_pointers(kind, code, revision, latest_draft_id)
    values ('activity', p_code, v_new_rev, v_new_id)
    on conflict (kind, code) do update set revision = v_new_rev, latest_draft_id = v_new_id, updated_at = now();
  v_result := jsonb_build_object('protocolVersion', 1, 'kind', 'activity', 'code', p_code,
    'revision', v_new_rev, 'draftId', v_new_id);
  perform public._work_config_store_receipt(p_command_id, v_actor, 'propose_activity_draft', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_propose_activity_draft(uuid, text, bigint, text, text, text, boolean, jsonb)
  from public, anon;
grant execute on function public.work_propose_activity_draft(uuid, text, bigint, text, text, text, boolean, jsonb)
  to authenticated;

create function public.work_propose_menu_draft(
  p_command_id uuid, p_code text, p_expected_revision bigint, p_label_en text, p_label_es text, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb;
  v_cur_rev bigint; v_cur_latest uuid; v_new_rev bigint; v_new_id uuid; v_body jsonb; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if public.is_test_profile(v_actor) or not public._work_config_is_supervisor(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner or supervisor may draft company configuration.';
  end if;
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,79}$' then
    raise exception using errcode = '23514', message = 'Invalid menu code.';
  end if;
  if p_label_en is null or p_label_es is null or length(btrim(p_label_en)) not between 1 and 120 or length(btrim(p_label_es)) not between 1 and 120 then
    raise exception using errcode = '23514', message = 'Invalid menu label.';
  end if;
  perform public._work_config_validate_menu_draft_items(p_items);
  if p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '23514', message = 'A valid expected draft revision is required.';
  end if;
  v_payload := jsonb_build_object('code', p_code, 'expectedRevision', p_expected_revision,
    'labelEn', p_label_en, 'labelEs', p_label_es, 'items', p_items);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'propose_menu_draft', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  select revision, latest_draft_id into v_cur_rev, v_cur_latest
    from public.work_configuration_draft_pointers
   where kind = 'menu' and code = p_code for update;
  if not found then v_cur_rev := 0; v_cur_latest := null; end if;
  if v_cur_rev <> p_expected_revision then
    raise exception using errcode = '23514', message = 'Draft revision changed; reload and retry.';
  end if;
  v_new_rev := v_cur_rev + 1;
  v_body := jsonb_build_object('labelEn', p_label_en, 'labelEs', p_label_es, 'items', p_items);
  insert into public.work_configuration_draft_revisions(kind, code, revision, body, proposed_by, predecessor_id)
    values ('menu', p_code, v_new_rev, v_body, v_actor, v_cur_latest) returning id into v_new_id;
  insert into public.work_configuration_draft_pointers(kind, code, revision, latest_draft_id)
    values ('menu', p_code, v_new_rev, v_new_id)
    on conflict (kind, code) do update set revision = v_new_rev, latest_draft_id = v_new_id, updated_at = now();
  v_result := jsonb_build_object('protocolVersion', 1, 'kind', 'menu', 'code', p_code,
    'revision', v_new_rev, 'draftId', v_new_id);
  perform public._work_config_store_receipt(p_command_id, v_actor, 'propose_menu_draft', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_propose_menu_draft(uuid, text, bigint, text, text, jsonb) from public, anon;
grant execute on function public.work_propose_menu_draft(uuid, text, bigint, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Publish -- owner only. Rename/reorder/enabled-flag changes always
--    create a new version; nothing here ever updates an old version row.
-- ---------------------------------------------------------------------------

create function public.work_publish_activity_version(
  p_command_id uuid, p_code text, p_expected_latest_version integer, p_scope text,
  p_label_en text, p_label_es text, p_machine_selection boolean, p_typed_fields jsonb,
  p_effective_from timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb;
  v_published_at timestamptz; v_effective_from timestamptz;
  v_def_id uuid; v_max_ver integer; v_new_ver integer; v_version_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if public.is_test_profile(v_actor) or not public._work_config_is_owner(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner may publish company configuration.';
  end if;
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,79}$' then
    raise exception using errcode = '23514', message = 'Invalid activity code.';
  end if;
  if p_scope is null or p_scope not in ('general', 'specific') then
    raise exception using errcode = '23514', message = 'Invalid activity scope.';
  end if;
  if p_label_en is null or p_label_es is null or length(btrim(p_label_en)) not between 1 and 120 or length(btrim(p_label_es)) not between 1 and 120 then
    raise exception using errcode = '23514', message = 'Invalid activity label.';
  end if;
  if p_machine_selection is null then
    raise exception using errcode = '23514', message = 'Machine selection must be a boolean.';
  end if;
  perform public._work_config_validate_typed_fields(p_typed_fields);
  if p_expected_latest_version is null or p_expected_latest_version not between 0 and 2147483646 then
    raise exception using errcode = '23514', message = 'A valid expected published version is required.';
  end if;
  v_payload := jsonb_build_object('code', p_code, 'expectedLatestVersion', p_expected_latest_version, 'scope', p_scope,
    'labelEn', p_label_en, 'labelEs', p_label_es, 'machineSelection', p_machine_selection, 'typedFields', p_typed_fields, 'effectiveFrom', p_effective_from);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'publish_activity_version', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  v_published_at := clock_timestamp();
  v_effective_from := coalesce(p_effective_from, v_published_at);
  if not isfinite(v_effective_from) or v_effective_from < v_published_at then
    raise exception using errcode = '23514', message = 'Effective time must be finite and no earlier than publication.';
  end if;
  if exists(select 1 from public.work_activity_definitions where code = p_code and retired_at is not null) then
    raise exception using errcode = '23514', message = 'A retired activity cannot be republished.';
  end if;
  select d.id, (select max(v.version) from public.work_activity_definition_versions v where v.definition_id = d.id)
    into v_def_id, v_max_ver
    from public.work_activity_definitions d where d.code = p_code for update;
  if not found then
    if p_expected_latest_version <> 0 then
      raise exception using errcode = '23514', message = 'Activity definition does not exist yet.';
    end if;
    insert into public.work_activity_definitions(code, created_by) values (p_code, v_actor) returning id into v_def_id;
    v_max_ver := 0;
  else
    if coalesce(v_max_ver, 0) <> p_expected_latest_version then
      raise exception using errcode = '23514', message = 'Activity version changed; reload and retry.';
    end if;
  end if;
  v_new_ver := coalesce(v_max_ver, 0) + 1;
  insert into public.work_activity_definition_versions(
    definition_id, version, scope, label_en, label_es, machine_selection, typed_fields, published_by, published_at, effective_from)
    values (v_def_id, v_new_ver, p_scope, p_label_en, p_label_es, p_machine_selection, p_typed_fields, v_actor, v_published_at, v_effective_from)
    returning id into v_version_id;
  v_result := jsonb_build_object('protocolVersion', 1, 'code', p_code, 'version', v_new_ver, 'versionId', v_version_id,
    'publishedAt', v_published_at, 'effectiveFrom', v_effective_from);
  perform public._work_config_store_receipt(p_command_id, v_actor, 'publish_activity_version', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_publish_activity_version(uuid, text, integer, text, text, text, boolean, jsonb, timestamptz)
  from public, anon;
grant execute on function public.work_publish_activity_version(uuid, text, integer, text, text, text, boolean, jsonb, timestamptz)
  to authenticated;

create function public.work_publish_menu_version(
  p_command_id uuid, p_code text, p_expected_latest_version integer, p_label_en text, p_label_es text, p_items jsonb, p_effective_from timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb;
  v_published_at timestamptz; v_effective_from timestamptz;
  v_menu_id uuid; v_max_ver integer; v_new_ver integer; v_version_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if public.is_test_profile(v_actor) or not public._work_config_is_owner(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner may publish company configuration.';
  end if;
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,79}$' then
    raise exception using errcode = '23514', message = 'Invalid menu code.';
  end if;
  if p_label_en is null or p_label_es is null or length(btrim(p_label_en)) not between 1 and 120 or length(btrim(p_label_es)) not between 1 and 120 then
    raise exception using errcode = '23514', message = 'Invalid menu label.';
  end if;
  if p_expected_latest_version is null or p_expected_latest_version not between 0 and 2147483646 then
    raise exception using errcode = '23514', message = 'A valid expected published version is required.';
  end if;
  v_payload := jsonb_build_object('code', p_code, 'expectedLatestVersion', p_expected_latest_version,
    'labelEn', p_label_en, 'labelEs', p_label_es, 'items', p_items, 'effectiveFrom', p_effective_from);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'publish_menu_version', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  if p_items is null then
    raise exception using errcode = '23514', message = 'Menu items are required.';
  end if;
  v_published_at := clock_timestamp();
  v_effective_from := coalesce(p_effective_from, v_published_at);
  if not isfinite(v_effective_from) or v_effective_from < v_published_at then
    raise exception using errcode = '23514', message = 'Effective time must be finite and no earlier than publication.';
  end if;
  if exists(select 1 from public.work_capture_menus where code = p_code and retired_at is not null) then
    raise exception using errcode = '23514', message = 'A retired menu cannot be republished.';
  end if;
  select m.id, (select max(v.version) from public.work_capture_menu_versions v where v.menu_id = m.id)
    into v_menu_id, v_max_ver
    from public.work_capture_menus m where m.code = p_code for update;
  if not found then
    if p_expected_latest_version <> 0 then
      raise exception using errcode = '23514', message = 'Menu does not exist yet.';
    end if;
    insert into public.work_capture_menus(code, created_by) values (p_code, v_actor) returning id into v_menu_id;
    v_max_ver := 0;
  else
    if coalesce(v_max_ver, 0) <> p_expected_latest_version then
      raise exception using errcode = '23514', message = 'Menu version changed; reload and retry.';
    end if;
  end if;
  v_new_ver := coalesce(v_max_ver, 0) + 1;
  -- work_capture_validate_menu (20261107020000) fires on this insert and
  -- re-validates every item against real published activity definition
  -- versions; this RPC never re-implements that check.
  insert into public.work_capture_menu_versions(menu_id, version, label_en, label_es, items, published_by, published_at, effective_from)
    values (v_menu_id, v_new_ver, p_label_en, p_label_es, p_items, v_actor, v_published_at, v_effective_from)
    returning id into v_version_id;
  v_result := jsonb_build_object('protocolVersion', 1, 'code', p_code, 'version', v_new_ver, 'versionId', v_version_id,
    'publishedAt', v_published_at, 'effectiveFrom', v_effective_from);
  perform public._work_config_store_receipt(p_command_id, v_actor, 'publish_menu_version', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_publish_menu_version(uuid, text, integer, text, text, jsonb, timestamptz) from public, anon;
grant execute on function public.work_publish_menu_version(uuid, text, integer, text, text, jsonb, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Retire -- owner only. Historical versions remain readable under
--    current authority; retirement never deletes or hides a prior version.
-- ---------------------------------------------------------------------------

create function public.work_retire_activity(p_command_id uuid, p_code text, p_expected_latest_version integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb; v_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if public.is_test_profile(v_actor) or not public._work_config_is_owner(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner may retire company configuration.';
  end if;
  if p_code is null or p_expected_latest_version is null or p_expected_latest_version < 1 then
    raise exception using errcode = '23514', message = 'A code and expected version are required.';
  end if;
  v_payload := jsonb_build_object('code', p_code, 'expectedLatestVersion', p_expected_latest_version);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'retire_activity', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  if p_expected_latest_version is distinct from (
    select max(v.version) from public.work_activity_definition_versions v
    join public.work_activity_definitions d on d.id = v.definition_id where d.code = p_code) then
    raise exception using errcode = '23514', message = 'Published version changed; reload and retry.';
  end if;
  update public.work_activity_definitions set retired_at = now()
   where code = p_code and retired_at is null returning id into v_id;
  if v_id is null then
    raise exception using errcode = '23514', message = 'Activity is unknown or already retired.';
  end if;
  v_result := jsonb_build_object('protocolVersion', 1, 'code', p_code, 'retiredAt', now());
  perform public._work_config_store_receipt(p_command_id, v_actor, 'retire_activity', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_retire_activity(uuid, text, integer) from public, anon;
grant execute on function public.work_retire_activity(uuid, text, integer) to authenticated;

create function public.work_retire_menu(p_command_id uuid, p_code text, p_expected_latest_version integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb; v_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if public.is_test_profile(v_actor) or not public._work_config_is_owner(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner may retire company configuration.';
  end if;
  if p_code is null or p_expected_latest_version is null or p_expected_latest_version < 1 then
    raise exception using errcode = '23514', message = 'A code and expected version are required.';
  end if;
  v_payload := jsonb_build_object('code', p_code, 'expectedLatestVersion', p_expected_latest_version);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'retire_menu', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  if p_expected_latest_version is distinct from (
    select max(v.version) from public.work_capture_menu_versions v
    join public.work_capture_menus d on d.id = v.menu_id where d.code = p_code) then
    raise exception using errcode = '23514', message = 'Published version changed; reload and retry.';
  end if;
  update public.work_capture_menus set retired_at = now()
   where code = p_code and retired_at is null returning id into v_id;
  if v_id is null then
    raise exception using errcode = '23514', message = 'Menu is unknown or already retired.';
  end if;
  v_result := jsonb_build_object('protocolVersion', 1, 'code', p_code, 'retiredAt', now());
  perform public._work_config_store_receipt(p_command_id, v_actor, 'retire_menu', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_retire_menu(uuid, text, integer) from public, anon;
grant execute on function public.work_retire_menu(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Job menu selection -- owner/supervisor on a currently visible job, or
--    a foreman with an explicit active menu_select grant on that exact
--    job. The selected snapshot must be a published, currently active menu
--    whose every referenced activity definition is currently active too.
-- ---------------------------------------------------------------------------

create function public.work_select_job_menu(
  p_command_id uuid, p_project_id uuid, p_menu_version_id uuid, p_expected_current_revision bigint
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb;
  v_menu_retired timestamptz; v_menu_effective timestamptz; v_frozen jsonb; v_cur_rev bigint; v_predecessor_id uuid;
  v_new_rev bigint; v_selection_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if not public._work_config_can_manage_menu(p_project_id, v_actor) then
    raise exception using errcode = '42501', message = 'That job is unavailable or you may not select its menu.';
  end if;
  if p_menu_version_id is null or p_expected_current_revision is null
      or p_expected_current_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '23514', message = 'A menu version and expected selection revision are required.';
  end if;
  v_payload := jsonb_build_object('projectId', p_project_id, 'menuVersionId', p_menu_version_id,
    'expectedCurrentRevision', p_expected_current_revision);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'select_job_menu', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  select m.retired_at, coalesce(mv.effective_from, mv.published_at), mv.items
    into v_menu_retired, v_menu_effective, v_frozen
    from public.work_capture_menu_versions mv join public.work_capture_menus m on m.id = mv.menu_id
   where mv.id = p_menu_version_id;
  if not found or v_menu_retired is not null or v_menu_effective > clock_timestamp() then
    raise exception using errcode = '23514', message = 'That menu version is unknown or retired.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_frozen) it
    join public.work_activity_definition_versions v on v.id = (it->>'versionId')::uuid
    join public.work_activity_definitions d on d.id = v.definition_id
    where (it->>'enabled')::boolean and (d.retired_at is not null
      or coalesce(v.effective_from, v.published_at) > clock_timestamp())
  ) then
    raise exception using errcode = '23514', message = 'That menu includes an ineligible activity.';
  end if;
  select max(revision) into v_cur_rev from public.work_job_menu_selections where project_id = p_project_id;
  v_cur_rev := coalesce(v_cur_rev, 0);
  if v_cur_rev <> p_expected_current_revision then
    raise exception using errcode = '23514', message = 'Job menu selection changed; reload and retry.';
  end if;
  if v_cur_rev > 0 then
    select id into v_predecessor_id from public.work_job_menu_selections
     where project_id = p_project_id and revision = v_cur_rev;
  end if;
  v_new_rev := v_cur_rev + 1;
  insert into public.work_job_menu_selections(project_id, revision, menu_version_id, selected_by, predecessor_id)
    values (p_project_id, v_new_rev, p_menu_version_id, v_actor, v_predecessor_id)
    returning id into v_selection_id;
  v_result := jsonb_build_object('protocolVersion', 1, 'projectId', p_project_id, 'revision', v_new_rev,
    'menuVersionId', p_menu_version_id, 'selectionId', v_selection_id,
    'frozenDefinitionVersionIds', (select coalesce(jsonb_agg(it->>'versionId'), '[]'::jsonb)
      from jsonb_array_elements(v_frozen) it));
  perform public._work_config_store_receipt(p_command_id, v_actor, 'select_job_menu', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_select_job_menu(uuid, uuid, uuid, bigint) from public, anon;
grant execute on function public.work_select_job_menu(uuid, uuid, uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Job management capability grants -- owner/supervisor only, targeting
--    an active internal foreman on a currently visible job. A capability
--    can never be granted to yourself (no self-authority by naming
--    yourself), and revoking requires the same currently-visible,
--    nondeleted project as granting. Rows already written stay as private
--    audit evidence even after a later project purge (20261107020000).
-- ---------------------------------------------------------------------------

create function public.work_grant_job_capability(
  p_command_id uuid, p_project_id uuid, p_profile_id uuid, p_capability text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb;
  v_granted_at timestamptz; v_grant_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if not public._work_config_is_supervisor(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner or supervisor may grant job capabilities.';
  end if;
  if p_capability is null or p_capability not in ('menu_select', 'dimensions_edit', 'final_qc') then
    raise exception using errcode = '23514', message = 'Invalid capability.';
  end if;
  if p_profile_id = v_actor then
    raise exception using errcode = '42501', message = 'A capability cannot be granted to yourself.';
  end if;
  if not public._ai_job_visible(p_project_id, v_actor) then
    raise exception using errcode = '23514', message = 'That job is unavailable.';
  end if;
  if not public._work_config_is_foreman(p_profile_id)
      or not public._ai_job_visible(p_project_id, p_profile_id) then
    raise exception using errcode = '23514', message = 'Only an active foreman may receive this grant.';
  end if;
  v_payload := jsonb_build_object('projectId', p_project_id, 'profileId', p_profile_id, 'capability', p_capability);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'grant_job_capability', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  insert into public.work_job_management_grants(project_id, profile_id, capability, granted_by)
    values (p_project_id, p_profile_id, p_capability, v_actor)
    returning granted_at, id into v_granted_at, v_grant_id;
  v_result := jsonb_build_object('protocolVersion', 1, 'projectId', p_project_id, 'profileId', p_profile_id,
    'capability', p_capability, 'grantedAt', v_granted_at, 'grantId', v_grant_id);
  perform public._work_config_store_receipt(p_command_id, v_actor, 'grant_job_capability', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_grant_job_capability(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.work_grant_job_capability(uuid, uuid, uuid, text) to authenticated;

create function public.work_revoke_job_capability(
  p_command_id uuid, p_project_id uuid, p_profile_id uuid, p_capability text, p_expected_grant_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); v_payload jsonb; v_hash text; v_existing jsonb; v_id uuid; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'Sign-in required.'; end if;
  perform pg_advisory_xact_lock(7710, 0);
  if p_command_id is null then
    raise exception using errcode = '23514', message = 'A command id is required.';
  end if;
  if not public._work_config_is_supervisor(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner or supervisor may revoke job capabilities.';
  end if;
  if p_capability is null or p_capability not in ('menu_select', 'dimensions_edit', 'final_qc') then
    raise exception using errcode = '23514', message = 'Invalid capability.';
  end if;
  if not public._ai_job_visible(p_project_id, v_actor) then
    raise exception using errcode = '23514', message = 'That job is unavailable.';
  end if;
  if p_expected_grant_id is null then
    raise exception using errcode = '23514', message = 'An expected grant id is required.';
  end if;
  v_payload := jsonb_build_object('projectId', p_project_id, 'profileId', p_profile_id, 'capability', p_capability, 'expectedGrantId', p_expected_grant_id);
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  v_existing := public._work_config_replay(p_command_id, v_actor, 'revoke_job_capability', v_hash, v_payload);
  if v_existing is not null then return v_existing; end if;
  update public.work_job_management_grants set revoked_at = now(), revoked_by = v_actor
   where id = p_expected_grant_id and project_id = p_project_id and profile_id = p_profile_id and capability = p_capability and revoked_at is null
   returning id into v_id;
  if v_id is null then
    raise exception using errcode = '23514', message = 'No active grant to revoke.';
  end if;
  v_result := jsonb_build_object('protocolVersion', 1, 'projectId', p_project_id, 'profileId', p_profile_id,
    'capability', p_capability, 'revokedAt', now());
  perform public._work_config_store_receipt(p_command_id, v_actor, 'revoke_job_capability', v_payload, v_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.work_revoke_job_capability(uuid, uuid, uuid, text, uuid) from public, anon;
grant execute on function public.work_revoke_job_capability(uuid, uuid, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Reads -- strictly versioned, bounded size. Owner/supervisor read the
--     company draft/published catalog (and, if a visible job is named,
--     that job's current selection). Ordinary crew get ONLY their visible
--     job's frozen menu choice; no raw commands, no other drafts, no
--     cross-job identifiers or counts.
-- ---------------------------------------------------------------------------

create function public.work_job_capability_grants(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not public._work_config_is_supervisor(v_actor) then
    raise exception using errcode = '42501', message = 'Only an owner or supervisor may read job grants.';
  end if;
  if not public._ai_job_visible(p_project_id, v_actor) then
    raise exception using errcode = '23514', message = 'That job is unavailable.';
  end if;
  if (select count(*) from public.work_job_management_grants where project_id = p_project_id) > 200 then
    raise exception using errcode = '54000', message = 'Grant history exceeds the snapshot limit.';
  end if;
  return jsonb_build_object('protocolVersion', 1, 'projectId', p_project_id, 'grants', coalesce((
    select jsonb_agg(jsonb_build_object(
      'grantId', id, 'profileId', profile_id, 'capability', capability, 'grantedAt', granted_at, 'revokedAt', revoked_at)
      order by granted_at desc)
    from (select * from public.work_job_management_grants
           where project_id = p_project_id order by granted_at desc limit 200) g
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.work_job_capability_grants(uuid) from public, anon;
grant execute on function public.work_job_capability_grants(uuid) to authenticated;

create function public.work_configuration_snapshot(p_project_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_result jsonb; v_selection record; v_items jsonb;
begin
  if v_actor is null or not public._work_config_internal(v_actor) then
    raise exception using errcode = '42501', message = 'Sign-in required.';
  end if;
  if p_project_id is not null and not public._ai_job_visible(p_project_id, v_actor) then
    raise exception using errcode = '23514', message = 'That job is unavailable.';
  end if;
  if public._work_config_is_supervisor(v_actor) and not public.is_test_profile(v_actor) then
    if (select count(*) from public.work_activity_definitions) > 500
        or (select count(*) from public.work_capture_menus) > 500
        or (select count(*) from public.work_configuration_draft_pointers) > 500
        or (select count(*) from public.work_activity_definition_versions) > 10000
        or (select count(*) from public.work_capture_menu_versions) > 10000 then
      raise exception using errcode = '54000', message = 'Configuration catalog exceeds the snapshot limit.';
    end if;
    v_result := jsonb_build_object(
      'protocolVersion', 1, 'role', 'company',
      'activities', coalesce((
        select jsonb_agg(jsonb_build_object(
          'code', d.code, 'definitionId', d.id, 'retiredAt', d.retired_at,
          'versions', (select coalesce(jsonb_agg(jsonb_build_object(
              'versionId', v.id, 'version', v.version, 'scope', v.scope,
              'labelEn', v.label_en, 'labelEs', v.label_es,
              'machineSelection', v.machine_selection, 'typedFields', v.typed_fields,
              'publishedAt', v.published_at, 'effectiveFrom', coalesce(v.effective_from, v.published_at),
              'eligibleNow', d.retired_at is null and coalesce(v.effective_from, v.published_at) <= statement_timestamp())
            order by v.version desc), '[]'::jsonb)
            from public.work_activity_definition_versions v where v.definition_id = d.id))
          order by d.code)
        from (select * from public.work_activity_definitions order by code limit 500) d
      ), '[]'::jsonb),
      'menus', coalesce((
        select jsonb_agg(jsonb_build_object(
          'code', m.code, 'menuId', m.id, 'retiredAt', m.retired_at,
          'versions', (select coalesce(jsonb_agg(jsonb_build_object(
              'versionId', mv.id, 'version', mv.version, 'labelEn', mv.label_en, 'labelEs', mv.label_es,
              'items', mv.items, 'publishedAt', mv.published_at,
              'effectiveFrom', coalesce(mv.effective_from, mv.published_at),
              'eligibleNow', m.retired_at is null and coalesce(mv.effective_from, mv.published_at) <= statement_timestamp()
                and not exists (
                  select 1 from jsonb_array_elements(mv.items) mi
                  join public.work_activity_definition_versions av on av.id = (mi->>'versionId')::uuid
                  join public.work_activity_definitions ad on ad.id = av.definition_id
                  where (mi->>'enabled')::boolean and (ad.retired_at is not null
                    or coalesce(av.effective_from, av.published_at) > statement_timestamp())))
            order by mv.version desc), '[]'::jsonb)
            from public.work_capture_menu_versions mv where mv.menu_id = m.id))
          order by m.code)
        from (select * from public.work_capture_menus order by code limit 500) m
      ), '[]'::jsonb),
      'drafts', coalesce((
        select jsonb_agg(jsonb_build_object('kind', p.kind, 'code', p.code, 'revision', p.revision, 'draftId', latest_draft_id,
          'body', r.body, 'proposedBy', r.proposed_by, 'createdAt', r.proposed_at)
          order by p.kind, p.code)
        from public.work_configuration_draft_pointers p
        join public.work_configuration_draft_revisions r on r.id = p.latest_draft_id
      ), '[]'::jsonb));
    if p_project_id is not null and public._ai_job_visible(p_project_id, v_actor) then
      select s.revision, s.menu_version_id into v_selection
        from public.work_job_menu_selections s
       where s.project_id = p_project_id order by s.revision desc limit 1;
      if found then
        v_result := v_result || jsonb_build_object('projectId', p_project_id,
          'currentSelection', jsonb_build_object('revision', v_selection.revision, 'menuVersionId', v_selection.menu_version_id));
      end if;
    end if;
    if octet_length(v_result::text) > 1000000 then
      raise exception using errcode = '54000', message = 'Configuration snapshot exceeds the response limit.';
    end if;
    return v_result;
  end if;
  if p_project_id is null or not public._ai_job_visible(p_project_id, v_actor) then
    raise exception using errcode = '23514', message = 'That job is unavailable.';
  end if;
  select s.revision, s.menu_version_id into v_selection
    from public.work_job_menu_selections s
   where s.project_id = p_project_id order by s.revision desc limit 1;
  if not found then
    return jsonb_build_object('protocolVersion', 1, 'role', 'crew', 'projectId', p_project_id, 'menu', null);
  end if;
  select mv.items into v_items from public.work_capture_menu_versions mv where mv.id = v_selection.menu_version_id;
  v_result := jsonb_build_object('protocolVersion', 1, 'role', 'crew', 'projectId', p_project_id,
    'menu', jsonb_build_object('revision', v_selection.revision, 'menuVersionId', v_selection.menu_version_id,
      'activities', coalesce((
        select jsonb_agg(jsonb_build_object(
          'definitionId', it->>'definitionId', 'versionId', it->>'versionId',
          'position', it->'position', 'enabled', it->'enabled',
          'scope', v.scope, 'labelEn', v.label_en, 'labelEs', v.label_es,
          'machineSelection', v.machine_selection, 'typedFields', v.typed_fields,
          'publishedAt', v.published_at, 'effectiveFrom', coalesce(v.effective_from, v.published_at),
          'retiredAt', d.retired_at,
          'eligibleNow', (it->>'enabled')::boolean and d.retired_at is null
            and coalesce(v.effective_from, v.published_at) <= statement_timestamp()
            and m.retired_at is null and coalesce(mv.effective_from, mv.published_at) <= statement_timestamp())
          order by (it->>'position')::int)
        from jsonb_array_elements(v_items) it
        join public.work_activity_definition_versions v on v.id = (it->>'versionId')::uuid
        join public.work_activity_definitions d on d.id = v.definition_id
        cross join public.work_capture_menu_versions mv
        join public.work_capture_menus m on m.id = mv.menu_id
        where mv.id = v_selection.menu_version_id
      ), '[]'::jsonb)));
  if octet_length(v_result::text) > 1000000 then
    raise exception using errcode = '54000', message = 'Configuration snapshot exceeds the response limit.';
  end if;
  return v_result;
end;
$$;
revoke all on function public.work_configuration_snapshot(uuid) from public, anon;
grant execute on function public.work_configuration_snapshot(uuid) to authenticated;

commit;
