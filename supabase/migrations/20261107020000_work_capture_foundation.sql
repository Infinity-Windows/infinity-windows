-- Inert private substrate. No payroll callbacks, source writes, capture RPC,
-- table read grants, or capture enablement. Compatibility cutover is separate.
begin;

create table public.work_activity_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  check (retired_at is null or retired_at >= created_at)
);
create table public.work_activity_definition_versions (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references public.work_activity_definitions(id),
  version integer not null check (version > 0),
  scope text not null check (scope in ('general','specific')),
  label_en text not null check (length(btrim(label_en)) between 1 and 120),
  label_es text not null check (length(btrim(label_es)) between 1 and 120),
  -- Self capture is distinct from company publishing, job selection and final QC.
  machine_selection boolean not null default false,
  typed_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(typed_fields) = 'array' and jsonb_array_length(typed_fields) <= 40
      and octet_length(typed_fields::text) <= 20000),
  published_by uuid not null,
  published_at timestamptz not null default now(),
  unique (definition_id,version),
  unique (definition_id,id)
);
create table public.work_capture_menus (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create table public.work_capture_menu_versions (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.work_capture_menus(id),
  version integer not null check (version > 0),
  label_en text not null check (length(btrim(label_en)) between 1 and 120),
  label_es text not null check (length(btrim(label_es)) between 1 and 120),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 200
    and octet_length(items::text) <= 40000),
  published_by uuid not null,
  published_at timestamptz not null default now(),
  unique (menu_id,version)
);
-- The entire menu membership is one immutable snapshot. A child-row list
-- would allow later INSERTs to silently alter an already published version.
create function public.work_capture_validate_menu() returns trigger
language plpgsql set search_path = public,pg_temp as $$
declare item jsonb; definition uuid; version_id uuid; position integer;
  seen_definitions uuid[] := '{}'; seen_positions integer[] := '{}';
begin
  if jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) > 200 then
    raise exception using errcode='23514', message='Invalid menu snapshot.';
  end if;
  for item in select value from jsonb_array_elements(new.items) loop
    if jsonb_typeof(item) <> 'object' or
        not (item ?& array['definitionId','versionId','position','enabled']) or
        exists(select 1 from jsonb_object_keys(item) k
          where k not in ('definitionId','versionId','position','enabled')) or
        jsonb_typeof(item->'definitionId') <> 'string' or
        jsonb_typeof(item->'versionId') <> 'string' or
        jsonb_typeof(item->'position') <> 'number' or
        jsonb_typeof(item->'enabled') <> 'boolean' then
      raise exception using errcode='23514', message='Invalid menu item.';
    end if;
    definition := (item->>'definitionId')::uuid;
    version_id := (item->>'versionId')::uuid;
    if (item->>'position')::numeric <> trunc((item->>'position')::numeric) then
      raise exception using errcode='23514', message='Menu position must be an integer.';
    end if;
    position := (item->>'position')::integer;
    if position not between 0 and 199 or definition=any(seen_definitions)
        or position=any(seen_positions) or not exists (
          select 1 from public.work_activity_definition_versions v
          where v.id=version_id and v.definition_id=definition) then
      raise exception using errcode='23514', message='Menu membership is invalid or duplicated.';
    end if;
    seen_definitions := array_append(seen_definitions,definition);
    seen_positions := array_append(seen_positions,position);
  end loop;
  return new;
end;
$$;
revoke all on function public.work_capture_validate_menu() from public,anon,authenticated;
create trigger work_capture_menu_snapshot before insert on public.work_capture_menu_versions
  for each row execute function public.work_capture_validate_menu();
-- Job IDs remain original identity evidence even if a project is later purged.
-- Future owner/supervisor RPCs must resolve/authorize current sources before use.
create table public.work_job_menu_selections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  menu_version_id uuid not null references public.work_capture_menu_versions(id),
  selected_by uuid not null,
  selected_at timestamptz not null default now(),
  predecessor_id uuid references public.work_job_menu_selections(id),
  unique (project_id,revision),
  check (predecessor_id is null or predecessor_id <> id)
);
create table public.work_job_management_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  profile_id uuid not null,
  capability text not null check (capability in ('menu_select','dimensions_edit','final_qc')),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  check ((revoked_at is null) = (revoked_by is null)),
  check (revoked_at is null or revoked_at >= granted_at)
);
create unique index work_job_management_active
  on public.work_job_management_grants(project_id,profile_id,capability)
  where revoked_at is null;

create table public.personal_activity_state (
  profile_id uuid primary key,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  shift_id uuid,
  active_source_kind text check (active_source_kind in ('custom','unit','task','service','phase')),
  active_source_id uuid,
  active_definition_version_id uuid references public.work_activity_definition_versions(id),
  effective_since timestamptz,
  last_transition_id uuid,
  resume_token uuid,
  resume_source_kind text check (resume_source_kind in ('custom','unit','task','service','phase')),
  resume_source_id uuid,
  resume_definition_version_id uuid references public.work_activity_definition_versions(id),
  resume_shift_id uuid,
  resume_from_revision bigint check (resume_from_revision between 0 and 9007199254740991),
  resume_after_break_transition_id uuid,
  integrity_state text not null default 'review' check (integrity_state in ('clean','legacy_conflict','review')),
  updated_at timestamptz not null default now(),
  check ((active_source_kind is null and active_source_id is null and effective_since is null
            and active_definition_version_id is null)
      or (active_source_kind is not null and active_source_id is not null
            and effective_since is not null and shift_id is not null)),
  check ((resume_token is null and resume_source_kind is null and resume_source_id is null
            and resume_definition_version_id is null and resume_shift_id is null
            and resume_from_revision is null and resume_after_break_transition_id is null)
      or (resume_token is not null and resume_source_kind is not null and resume_source_id is not null
            and resume_shift_id is not null and resume_from_revision is not null
            and resume_after_break_transition_id is not null)),
  check (active_definition_version_id is null or active_source_kind = 'custom'),
  check (resume_definition_version_id is null or resume_source_kind = 'custom'),
  check (active_source_id is null or resume_token is null)
);
create table public.personal_activity_commands (
  command_id uuid primary key,
  actor_id uuid not null,
  subject_profile_id uuid not null,
  protocol_version integer not null check (protocol_version = 1),
  normalized_payload jsonb not null
    check (jsonb_typeof(normalized_payload) = 'object' and octet_length(normalized_payload::text) <= 20000),
  -- Not sufficient for identity by itself: replay must compare typed payload too.
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  device_id uuid not null,
  client_generation uuid not null,
  client_sequence bigint not null check (client_sequence between 0 and 9007199254740991),
  predecessor_command_id uuid,
  expected_revision bigint not null check (expected_revision between 0 and 9007199254740991),
  status text not null check (status in ('applied','noop','conflict','refused')),
  reason_code text check (length(reason_code) between 1 and 80),
  before_revision bigint not null check (before_revision between 0 and 9007199254740991),
  after_revision bigint not null check (after_revision between 0 and 9007199254740991),
  transition_id uuid,
  effective_at timestamptz,
  result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 20000),
  unique (actor_id,device_id,client_generation,client_sequence),
  check (predecessor_command_id is null or predecessor_command_id <> command_id),
  check ((status = 'applied' and after_revision = before_revision + 1
            and transition_id is not null and effective_at is not null)
      or (status <> 'applied' and after_revision = before_revision
            and transition_id is null and effective_at is null)),
  check (status in ('applied','noop') or reason_code is not null)
);
create table public.personal_activity_transitions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  revision_before bigint not null check (revision_before between 0 and 9007199254740990),
  revision_after bigint not null check (revision_after = revision_before + 1),
  command_id uuid,
  legacy_source_route text check (length(legacy_source_route) between 1 and 120),
  source_request_id uuid,
  actor_id uuid,
  cause text not null check (cause in ('switch','stop','pause','break_start','break_end','clock_out',
    'clock_in','correction','void','restore','import','legacy_transition')),
  received_at timestamptz not null default now(),
  original_tapped_at timestamptz,
  selected_effective_at timestamptz not null,
  time_selection_reason text not null check (length(time_selection_reason) between 1 and 120),
  source_shift_id uuid,
  -- Typed before/after lifecycle evidence is bounded and private. No backfill is
  -- inferred from old aggregate breaks; validation belongs to the later writer.
  before_evidence jsonb not null check (jsonb_typeof(before_evidence) = 'object' and octet_length(before_evidence::text) <= 20000),
  after_evidence jsonb not null check (jsonb_typeof(after_evidence) = 'object' and octet_length(after_evidence::text) <= 20000),
  resume_outcome text check (resume_outcome in ('none','saved','resumed','unavailable','cleared')),
  review_reason text check (length(review_reason) between 1 and 120),
  supersedes_transition_id uuid references public.personal_activity_transitions(id),
  protocol_version integer not null check (protocol_version = 1),
  unique (profile_id,revision_after),
  check (command_id is null or legacy_source_route is null),
  check (supersedes_transition_id is null or supersedes_transition_id <> id)
);
create index personal_activity_commands_subject on public.personal_activity_commands(subject_profile_id,received_at);
create index personal_activity_transitions_shift on public.personal_activity_transitions(source_shift_id,selected_effective_at);

-- Capture metadata points at one existing timed source: never a second timer.
-- No cascading FK to operational sessions that could erase immutable evidence.
create table public.work_session_capture_metadata (
  session_id uuid primary key,
  profile_id uuid not null,
  project_id uuid not null,
  definition_version_id uuid not null references public.work_activity_definition_versions(id),
  menu_version_id uuid not null references public.work_capture_menu_versions(id),
  scope text not null check (scope in ('general','specific')),
  unit_id uuid,
  fact_revision bigint check (fact_revision between 1 and 9007199254740991),
  unit_facts jsonb check (unit_facts is null or (jsonb_typeof(unit_facts) = 'object' and octet_length(unit_facts::text) <= 20000)),
  machine_kind text check (machine_kind in ('forklift','tele_handler','scissor_lift','spider_suction')),
  recorded_at timestamptz not null default now(),
  check ((scope = 'general' and unit_id is null and fact_revision is null and unit_facts is null)
      or (scope = 'specific' and unit_id is not null and fact_revision is not null and unit_facts is not null)),
  check (scope = 'specific' or machine_kind is null or machine_kind in ('forklift','tele_handler'))
);

create function public.work_capture_immutable_record() returns trigger
language plpgsql set search_path = public,pg_temp as $$
begin
  raise exception using errcode='23514', message='Recorded capture evidence is immutable; create a new revision.';
end;
$$;
revoke all on function public.work_capture_immutable_record() from public,anon,authenticated;

-- All access remains revoked. A future caller-bound API will authorize reads,
-- publishing and job actions separately; no broad raw ledger SELECT is added.
alter table public.work_activity_definitions enable row level security;
revoke all on table public.work_activity_definitions from public,anon,authenticated;
alter table public.work_activity_definition_versions enable row level security;
revoke all on table public.work_activity_definition_versions from public,anon,authenticated;
alter table public.work_capture_menus enable row level security;
revoke all on table public.work_capture_menus from public,anon,authenticated;
alter table public.work_capture_menu_versions enable row level security;
revoke all on table public.work_capture_menu_versions from public,anon,authenticated;
alter table public.work_job_menu_selections enable row level security;
revoke all on table public.work_job_menu_selections from public,anon,authenticated;
alter table public.work_job_management_grants enable row level security;
revoke all on table public.work_job_management_grants from public,anon,authenticated;
alter table public.personal_activity_state enable row level security;
revoke all on table public.personal_activity_state from public,anon,authenticated;
alter table public.personal_activity_commands enable row level security;
revoke all on table public.personal_activity_commands from public,anon,authenticated;
alter table public.personal_activity_transitions enable row level security;
revoke all on table public.personal_activity_transitions from public,anon,authenticated;
alter table public.work_session_capture_metadata enable row level security;
revoke all on table public.work_session_capture_metadata from public,anon,authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'work_activity_definition_versions','work_capture_menu_versions',
    'work_job_menu_selections','personal_activity_commands','personal_activity_transitions',
    'work_session_capture_metadata'
  ] loop
    execute format('create trigger work_capture_record_immutable before update or delete on public.%I '
      || 'for each row execute function public.work_capture_immutable_record()',table_name);
  end loop;
end;
$$;

comment on table public.personal_activity_state is
  'Inactive private coordinator substrate. No current source seeding or capture writer is enabled by this migration.';
comment on table public.personal_activity_transitions is
  'Forward immutable lifecycle evidence. Historical aggregate breaks are not backfilled. Current payroll remains unchanged.';
comment on table public.work_job_management_grants is
  'Private inactive capability registry. No foreman grants inferred from visibility; future grant ownership is separately authorized.';
-- Private privileges do not replace the standard test-login sandbox fence.
select public.attach_sandbox_guards();
commit;
