-- Inactive activity-engine substrate. No legacy function bodies, source triggers,
-- public RPCs, source seeding or capture activation. Gate 7712,0 is reserved;
-- private callers acquire it first. The future complete 08410000 cutover is
-- required before these helpers may be reached from an application route.
begin;

-- Setup is a distinct allocation of the existing shift, never another payroll.
alter table public.personal_activity_state drop constraint personal_activity_state_active_source_kind_check;
alter table public.personal_activity_state add constraint personal_activity_state_active_source_kind_check
  check (active_source_kind in ('custom','unit','task','service','phase','setup'));
alter table public.personal_activity_state drop constraint personal_activity_state_resume_source_kind_check;
alter table public.personal_activity_state add constraint personal_activity_state_resume_source_kind_check
  check (resume_source_kind in ('custom','unit','task','service','phase','setup'));

create table public.work_activity_observations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  device_id uuid not null,
  revision bigint not null check (revision between 0 and 9007199254740991),
  last_transition_id uuid,
  shift_id uuid,
  shift_clock_in_at timestamptz,
  current_generation uuid,
  current_head_command_id uuid,
  issued_at timestamptz not null check (isfinite(issued_at)),
  expires_at timestamptz not null check (isfinite(expires_at) and expires_at > issued_at and expires_at <= issued_at + interval '16 hours'),
  protocol_version integer not null default 1 check (protocol_version = 1),
  check ((shift_id is null) = (shift_clock_in_at is null)),
  check (shift_clock_in_at is null or isfinite(shift_clock_in_at)),
  check ((current_generation is null) = (current_head_command_id is null))
);
create index work_activity_observations_actor_device on public.work_activity_observations(actor_id,device_id,issued_at);

create table public.work_activity_streams (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  device_id uuid not null,
  client_generation uuid not null,
  head_sequence bigint not null check (head_sequence between 0 and 9007199254740991),
  head_command_id uuid not null references public.personal_activity_commands(command_id),
  anchor_observation_id uuid not null references public.work_activity_observations(id),
  status text not null check (status in ('active','blocked','retired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  unique(actor_id,device_id,client_generation),
  check (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at),
  check ((status='retired' and retired_at is not null and isfinite(retired_at) and retired_at >= created_at)
    or (status<>'retired' and retired_at is null))
);
create unique index work_activity_streams_one_current on public.work_activity_streams(actor_id,device_id) where status in ('active','blocked');

-- Ephemeral context: identity comes from the backend, not a GUC/depth/request.
-- Deferred closure check below makes it impossible to commit an open frame.
create table public.work_activity_transaction_context (
  id uuid primary key default gen_random_uuid(),
  top_xid xid8 not null,
  backend_pid integer not null check (backend_pid > 0),
  parent_id uuid references public.work_activity_transaction_context(id),
  actor_id uuid not null,
  subject_profile_id uuid not null,
  route text not null check (route ~ '^[a-z][a-z0-9_]{0,119}$'),
  cause text not null check (cause in ('switch','stop','pause','break_start','break_end','clock_out','clock_in','correction','void','restore','import','legacy_transition')),
  selected_effective_at timestamptz not null check (isfinite(selected_effective_at)),
  opened_at timestamptz not null default clock_timestamp(),
  check (parent_id is distinct from id),
  -- This slice exposes only a self-context factory. Crew/admin factories need
  -- their exact existing target authority in the later complete cutover.
  check (actor_id=subject_profile_id)
);
create index work_activity_context_transaction on public.work_activity_transaction_context(top_xid,backend_pid);
create unique index work_activity_context_one_root on public.work_activity_transaction_context(top_xid,backend_pid) where parent_id is null;
create unique index work_activity_context_one_child on public.work_activity_transaction_context(parent_id) where parent_id is not null;

create table public.work_activity_expected_mutations (
  id uuid primary key default gen_random_uuid(),
  frame_id uuid not null references public.work_activity_transaction_context(id),
  table_oid oid not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  subject_profile_id uuid not null,
  source_id uuid not null,
  subject_column name not null,
  allowed_columns text[] not null check (cardinality(allowed_columns) between 1 and 64 and array_position(allowed_columns,null) is null),
  expected_before jsonb,
  expected_after jsonb,
  consumed boolean not null default false,
  check (expected_before is null or (jsonb_typeof(expected_before)='object' and octet_length(expected_before::text)<=8192)),
  check (expected_after is null or (jsonb_typeof(expected_after)='object' and octet_length(expected_after::text)<=8192)),
  check ((operation='INSERT' and expected_before is null and expected_after is not null)
    or (operation='UPDATE' and expected_before is not null and expected_after is not null)
    or (operation='DELETE' and expected_before is not null and expected_after is null))
);
create unique index work_activity_mutation_pending on public.work_activity_expected_mutations(frame_id,table_oid,operation,source_id) where not consumed;

-- Plain operational UUIDs retain original identities after source deletion.
-- Only the private immutable ledger graph has FKs, never cascading deletion.
create table public.work_setup_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  shift_id uuid not null,
  clock_client_id uuid not null,
  resumed_from_id uuid references public.work_setup_sessions(id),
  started_at timestamptz not null check (isfinite(started_at)),
  ended_at timestamptz,
  selected_end_at timestamptz,
  end_reason text check (end_reason in ('setup_complete','switch','break','clock_out','correction','void','legacy_transition')),
  start_transition_id uuid not null references public.personal_activity_transitions(id) deferrable initially deferred,
  end_transition_id uuid references public.personal_activity_transitions(id) deferrable initially deferred,
  created_at timestamptz not null default clock_timestamp(),
  check ((ended_at is null and selected_end_at is null and end_reason is null and end_transition_id is null)
    or (ended_at is not null and isfinite(ended_at) and ended_at>=started_at and selected_end_at is not null and isfinite(selected_end_at) and end_reason is not null and end_transition_id is not null)),
  check (resumed_from_id is distinct from id)
);
create unique index work_setup_sessions_one_open on public.work_setup_sessions(profile_id) where ended_at is null;
create unique index work_setup_sessions_one_initial on public.work_setup_sessions(profile_id,clock_client_id) where resumed_from_id is null;
create unique index work_setup_sessions_one_resume on public.work_setup_sessions(resumed_from_id) where resumed_from_id is not null;

create table public.personal_activity_transition_sources (
  id uuid primary key default gen_random_uuid(),
  transition_id uuid not null references public.personal_activity_transitions(id),
  profile_id uuid not null,
  source_kind text not null check(source_kind in ('custom','unit','task','service','phase','setup')),
  source_id uuid not null,
  relation text not null check(relation in ('effective','companion','conflict','phase_participation')),
  source_shift_id uuid,
  selected_effective_at timestamptz check(selected_effective_at is null or isfinite(selected_effective_at)),
  cause text check(cause in ('clock_in','clock_out','break_start','break_end','switch','stop','correction','void','legacy_transition')),
  check (not (source_kind='setup' and relation='effective') or (source_shift_id is not null and selected_effective_at is not null and cause is not null)),
  before_revision bigint check(before_revision between 0 and 9007199254740991),
  after_revision bigint check(after_revision between 0 and 9007199254740991),
  before_evidence jsonb not null check(jsonb_typeof(before_evidence)='object' and octet_length(before_evidence::text)<=8192),
  after_evidence jsonb not null check(jsonb_typeof(after_evidence)='object' and octet_length(after_evidence::text)<=8192),
  unique(transition_id,source_kind,source_id,relation)
);

alter table public.work_activity_observations enable row level security;
revoke all on table public.work_activity_observations from public,anon,authenticated;
alter table public.work_activity_streams enable row level security;
revoke all on table public.work_activity_streams from public,anon,authenticated;
alter table public.work_activity_transaction_context enable row level security;
revoke all on table public.work_activity_transaction_context from public,anon,authenticated;
alter table public.work_activity_expected_mutations enable row level security;
revoke all on table public.work_activity_expected_mutations from public,anon,authenticated;
alter table public.work_setup_sessions enable row level security;
revoke all on table public.work_setup_sessions from public,anon,authenticated;
alter table public.personal_activity_transition_sources enable row level security;
revoke all on table public.personal_activity_transition_sources from public,anon,authenticated;

create trigger work_activity_observation_immutable before update or delete on public.work_activity_observations
 for each row execute function public.work_capture_immutable_record();
create trigger work_activity_transition_source_immutable before update or delete on public.personal_activity_transition_sources
 for each row execute function public.work_capture_immutable_record();

create function public._work_activity_gate() returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode='25000',message='Activity coordination requires READ COMMITTED.';
  end if;
  perform pg_advisory_xact_lock(7712,0);
end; $$;
revoke all on function public._work_activity_gate() from public,anon,authenticated;

create function public._work_activity_actor() returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_actor uuid;
begin
  perform public._work_activity_gate();
  v_actor:=auth.uid();
  if not public._work_config_internal(v_actor) then
    raise exception using errcode='42501',message='An eligible Forge account is required.';
  end if;
  return v_actor;
end; $$;
revoke all on function public._work_activity_actor() from public,anon,authenticated;

create function public._work_activity_ensure_state() returns public.personal_activity_state
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_state public.personal_activity_state;
begin
  v_actor:=public._work_activity_actor();
  insert into public.personal_activity_state(profile_id) values(v_actor) on conflict(profile_id) do nothing;
  select * into strict v_state from public.personal_activity_state where profile_id=v_actor for update;
  -- No source is selected and no historical overlap is repaired here.
  return v_state;
end; $$;
revoke all on function public._work_activity_ensure_state() from public,anon,authenticated;

create function public._work_activity_observe(p_device_id uuid) returns public.work_activity_observations
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_state public.personal_activity_state; v_stream public.work_activity_streams;
 v_result public.work_activity_observations; v_clock_in timestamptz; v_now timestamptz; v_expiry timestamptz;
begin
  v_state:=public._work_activity_ensure_state();
  if p_device_id is null then raise exception using errcode='23514',message='A device identity is required.'; end if;
  v_now:=clock_timestamp(); v_expiry:=v_now+interval '16 hours';
  if v_state.shift_id is not null then
    select clock_in_at into v_clock_in from public.time_shifts where id=v_state.shift_id and profile_id=v_state.profile_id;
    if not found or v_clock_in is null or not isfinite(v_clock_in) then
      raise exception using errcode='23514',message='Activity state needs reconciliation.';
    end if;
    v_expiry:=least(v_expiry,v_clock_in+make_interval(hours=>public.shift_cap_hours()));
    if v_expiry<=v_now then raise exception using errcode='23514',message='Activity state needs reconciliation.'; end if;
  end if;
  select * into v_stream from public.work_activity_streams
   where actor_id=v_state.profile_id and device_id=p_device_id and status in ('active','blocked');
  insert into public.work_activity_observations(actor_id,device_id,revision,last_transition_id,shift_id,shift_clock_in_at,
    current_generation,current_head_command_id,issued_at,expires_at)
  values(v_state.profile_id,p_device_id,v_state.revision,v_state.last_transition_id,v_state.shift_id,v_clock_in,
    v_stream.client_generation,v_stream.head_command_id,v_now,v_expiry) returning * into v_result;
  return v_result;
end; $$;
revoke all on function public._work_activity_observe(uuid) from public,anon,authenticated;

-- Stream pointers may refer only to an actual immutable receipt for this exact
-- owner/device/generation/sequence. Retired generations can never reactivate.
create function public._work_activity_stream_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_command public.personal_activity_commands; v_observation public.work_activity_observations;
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='Activity stream identity is retained.'; end if;
  if tg_op='UPDATE' then
    if old.status='retired' or new.id is distinct from old.id or new.actor_id is distinct from old.actor_id
      or new.device_id is distinct from old.device_id or new.client_generation is distinct from old.client_generation
      or new.created_at is distinct from old.created_at or new.anchor_observation_id is distinct from old.anchor_observation_id then
      raise exception using errcode='23514',message='Activity stream identity is immutable.';
    end if;
    if new.head_command_id is distinct from old.head_command_id then
      if old.status<>'active' or new.head_sequence<>old.head_sequence+1 or new.status='retired' then
        raise exception using errcode='23514',message='Activity stream sequence is not the next command.';
      end if;
    elsif new.head_sequence is distinct from old.head_sequence or new.status<>'retired' then
      raise exception using errcode='23514',message='Only a new command or explicit retirement may change a stream.';
    end if;
    new.updated_at:=clock_timestamp();
  elsif new.head_sequence<>0 or new.status<>'active' then
    raise exception using errcode='23514',message='A stream begins with an accepted establishment.';
  end if;
  select * into v_command from public.personal_activity_commands where command_id=new.head_command_id;
  select * into v_observation from public.work_activity_observations where id=new.anchor_observation_id;
  if v_command.command_id is null or v_command.actor_id is distinct from new.actor_id
    or v_command.subject_profile_id is distinct from new.actor_id or v_command.device_id is distinct from new.device_id
    or v_command.client_generation is distinct from new.client_generation or v_command.client_sequence is distinct from new.head_sequence
    or v_command.normalized_payload->'deviceId' is distinct from to_jsonb(new.device_id)
    or v_command.normalized_payload->'clientGeneration' is distinct from to_jsonb(new.client_generation)
    or v_command.normalized_payload->'clientSequence' is distinct from to_jsonb(new.head_sequence)
    or v_command.normalized_payload->'expectedRevision' is distinct from to_jsonb(v_command.expected_revision)
    or v_command.normalized_payload->'predecessorCommandId' is distinct from coalesce(to_jsonb(v_command.predecessor_command_id),'null'::jsonb)
    or v_command.result is distinct from jsonb_build_object('protocolVersion',v_command.protocol_version,'commandId',v_command.command_id,
      'status',v_command.status,'reasonCode',v_command.reason_code,'beforeRevision',v_command.before_revision,'afterRevision',v_command.after_revision,
      'transitionId',v_command.transition_id,'effectiveAt',case when v_command.effective_at is not null then to_char(v_command.effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end)
    or v_command.payload_hash is distinct from encode(sha256(convert_to(v_command.normalized_payload::text,'UTF8')),'hex')
    or v_observation.actor_id is distinct from new.actor_id or v_observation.device_id is distinct from new.device_id then
    raise exception using errcode='23514',message='Activity stream does not match its receipt and observation.';
  end if;
  if tg_op='INSERT' and (v_command.status<>'noop' or v_command.normalized_payload#>>'{intent,kind}' is distinct from 'establish_stream'
    or v_command.predecessor_command_id is not null
    or v_command.normalized_payload#>>'{basis,observationId}' is distinct from new.anchor_observation_id::text) then
    raise exception using errcode='23514',message='Activity stream lacks its establishment receipt.';
  end if;
  if tg_op='UPDATE' and new.head_command_id is distinct from old.head_command_id
    and v_command.predecessor_command_id is distinct from old.head_command_id then
    raise exception using errcode='23514',message='Activity stream predecessor changed.';
  end if;
  if v_command.status='applied' and not exists(select 1 from public.personal_activity_transitions t
    where t.id=v_command.transition_id and t.command_id=v_command.command_id and t.profile_id=v_command.subject_profile_id
      and t.revision_before=v_command.before_revision and t.revision_after=v_command.after_revision and t.selected_effective_at=v_command.effective_at) then
    raise exception using errcode='23514',message='Applied activity head lacks its actual lifecycle transition.';
  end if;
  if (new.status='active' and v_command.status not in ('applied','noop'))
    or (new.status='blocked' and v_command.status not in ('conflict','refused')) then
    raise exception using errcode='23514',message='Activity stream status disagrees with its receipt.';
  end if;
  return new;
end; $$;
revoke all on function public._work_activity_stream_guard() from public,anon,authenticated;
create trigger work_activity_stream_guard before insert or update or delete on public.work_activity_streams
 for each row execute function public._work_activity_stream_guard();

-- Only the metadata-only establish_stream DTO is executable in this substrate.
-- New work/stop/setup command DTOs and public RPCs belong to the cutover.
create function public._work_activity_establish_payload(p_data jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare v_key text; v_result jsonb; v_tap timestamptz; v_checked timestamptz;
 v_device uuid; v_generation uuid; v_observation uuid; v_previous uuid; v_head uuid; v_shift uuid;
 v_revision numeric; v_skew numeric;
begin
  if p_data is null or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>20000 then
    raise exception using errcode='23514',message='Invalid activity stream request.';
  end if;
  if not (p_data ?& array['deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent'])
    or exists(select 1 from jsonb_object_keys(p_data) k where k<>all(array['deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent'])) then
    raise exception using errcode='23514',message='Invalid activity stream fields.';
  end if;
  if jsonb_typeof(p_data->'basis') is distinct from 'object' or not(p_data->'basis' ? 'observationId')
    or (select count(*) from jsonb_object_keys(p_data->'basis'))<>1
    or jsonb_typeof(p_data->'intent') is distinct from 'object'
    or not(p_data->'intent' ?& array['kind','previousGeneration','previousHeadCommandId'])
    or (select count(*) from jsonb_object_keys(p_data->'intent'))<>3
    or p_data#>>'{intent,kind}' is distinct from 'establish_stream' then
    raise exception using errcode='23514',message='Invalid stream establishment intent.';
  end if;
  foreach v_key in array array['deviceId','clientGeneration'] loop
    if jsonb_typeof(p_data->v_key) is distinct from 'string' or (p_data->>v_key) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode='23514',message='Invalid activity identity.';
    end if;
  end loop;
  if jsonb_typeof(p_data#>'{basis,observationId}') is distinct from 'string'
    or (p_data#>>'{basis,observationId}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_data->'clientSequence') is distinct from 'number' or (p_data->>'clientSequence')::numeric<>0
    or p_data->'predecessorCommandId' is distinct from 'null'::jsonb
    or jsonb_typeof(p_data->'expectedRevision') is distinct from 'number' then
    raise exception using errcode='23514',message='Invalid activity sequence or observation.';
  end if;
  v_revision:=(p_data->>'expectedRevision')::numeric;
  if v_revision<0 or v_revision>9007199254740991 or trunc(v_revision)<>v_revision then
    raise exception using errcode='23514',message='Invalid activity revision.';
  end if;
  foreach v_key in array array['previousGeneration','previousHeadCommandId'] loop
    if p_data->'intent'->v_key is distinct from 'null'::jsonb and
      (jsonb_typeof(p_data->'intent'->v_key) is distinct from 'string' or (p_data->'intent'->>v_key) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception using errcode='23514',message='Invalid prior activity stream identity.';
    end if;
  end loop;
  v_previous:=(p_data#>>'{intent,previousGeneration}')::uuid; v_head:=(p_data#>>'{intent,previousHeadCommandId}')::uuid;
  if (v_previous is null)<>(v_head is null) then raise exception using errcode='23514',message='Incomplete prior stream identity.'; end if;
  if p_data->'shiftRef' is distinct from 'null'::jsonb then
    if jsonb_typeof(p_data->'shiftRef') is distinct from 'object' or (select count(*) from jsonb_object_keys(p_data->'shiftRef'))<>2
      or p_data#>>'{shiftRef,kind}' is distinct from 'shift' or jsonb_typeof(p_data#>'{shiftRef,id}') is distinct from 'string'
      or (p_data#>>'{shiftRef,id}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode='23514',message='Invalid observed shift reference.';
    end if;
    v_shift:=(p_data#>>'{shiftRef,id}')::uuid;
  end if;
  foreach v_key in array array['tappedAt','clockCheckedAt'] loop
    if v_key='clockCheckedAt' and p_data->v_key='null'::jsonb then continue; end if;
    if jsonb_typeof(p_data->v_key) is distinct from 'string' or (p_data->>v_key) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
      raise exception using errcode='23514',message='Invalid activity timestamp.';
    end if;
  end loop;
  begin
    v_tap:=(p_data->>'tappedAt')::timestamptz; v_checked:=(p_data->>'clockCheckedAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='23514',message='Invalid activity timestamp.';
  end;
  if p_data->'clockSkewMs' is distinct from 'null'::jsonb then
    if jsonb_typeof(p_data->'clockSkewMs') is distinct from 'number' then raise exception using errcode='23514',message='Invalid clock skew.'; end if;
    v_skew:=(p_data->>'clockSkewMs')::numeric;
    if v_skew not between -120000 and 120000 or trunc(v_skew)<>v_skew then raise exception using errcode='23514',message='Invalid clock skew.'; end if;
  end if;
  v_device:=(p_data->>'deviceId')::uuid; v_generation:=(p_data->>'clientGeneration')::uuid; v_observation:=(p_data#>>'{basis,observationId}')::uuid;
  v_result:=jsonb_build_object('deviceId',v_device,'clientGeneration',v_generation,'clientSequence',0,'predecessorCommandId',null,
    'expectedRevision',v_revision::bigint,'basis',jsonb_build_object('observationId',v_observation),
    'shiftRef',case when v_shift is not null then jsonb_build_object('kind','shift','id',v_shift) else 'null'::jsonb end,
    'tappedAt',to_char(v_tap at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'clockCheckedAt',case when v_checked is not null then to_char(v_checked at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'clockSkewMs',v_skew::integer,'intent',jsonb_build_object('kind','establish_stream','previousGeneration',v_previous,'previousHeadCommandId',v_head));
  if octet_length(v_result::text)>20000 then raise exception using errcode='23514',message='Activity request is too large.'; end if;
  return v_result;
end; $$;
revoke all on function public._work_activity_establish_payload(jsonb) from public,anon,authenticated;

create function public._work_activity_establish_stream(p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_payload jsonb; v_hash text; v_prior public.personal_activity_commands;
 v_state public.personal_activity_state; v_observation public.work_activity_observations; v_stream public.work_activity_streams;
 v_device uuid; v_generation uuid; v_previous uuid; v_head uuid; v_observation_id uuid; v_expected bigint;
 v_status text:='noop'; v_reason text; v_result jsonb;
begin
  v_actor:=public._work_activity_actor();
  if p_command_id is null then raise exception using errcode='23514',message='A command identity is required.'; end if;
  v_payload:=public._work_activity_establish_payload(p_data);
  v_hash:=encode(sha256(convert_to(v_payload::text,'UTF8')),'hex');
  -- Replay precedes observation expiry/state reads. No source detail is returned.
  select * into v_prior from public.personal_activity_commands where command_id=p_command_id;
  if found then
    if v_prior.actor_id is distinct from v_actor or v_prior.protocol_version<>1 or v_prior.payload_hash is distinct from v_hash
      or v_prior.normalized_payload is distinct from v_payload then
      raise exception using errcode='23514',message='Activity command identity is unavailable.';
    end if;
    return v_prior.result;
  end if;
  v_device:=(v_payload->>'deviceId')::uuid; v_generation:=(v_payload->>'clientGeneration')::uuid;
  v_previous:=(v_payload#>>'{intent,previousGeneration}')::uuid; v_head:=(v_payload#>>'{intent,previousHeadCommandId}')::uuid;
  v_observation_id:=(v_payload#>>'{basis,observationId}')::uuid; v_expected:=(v_payload->>'expectedRevision')::bigint;
  if exists(select 1 from public.personal_activity_commands where actor_id=v_actor and device_id=v_device and client_generation=v_generation and client_sequence=0) then
    raise exception using errcode='23514',message='Activity command identity is unavailable.';
  end if;
  v_state:=public._work_activity_ensure_state();
  select * into v_observation from public.work_activity_observations where id=v_observation_id and actor_id=v_actor and device_id=v_device;
  select * into v_stream from public.work_activity_streams where actor_id=v_actor and device_id=v_device and status in ('active','blocked') for update;
  if v_observation.id is null then v_status:='refused'; v_reason:='observation_unavailable';
  elsif v_observation.expires_at<=clock_timestamp() then v_status:='refused'; v_reason:='observation_expired';
  elsif v_observation.revision<>v_expected or v_state.revision<>v_expected
    or v_observation.last_transition_id is distinct from v_state.last_transition_id
    or v_observation.shift_id is distinct from v_state.shift_id
    or v_observation.shift_id is distinct from (v_payload#>>'{shiftRef,id}')::uuid then
    v_status:='conflict'; v_reason:='state_changed';
  elsif v_stream.client_generation is distinct from v_previous or v_stream.head_command_id is distinct from v_head
    or v_observation.current_generation is distinct from v_previous or v_observation.current_head_command_id is distinct from v_head
    or exists(select 1 from public.work_activity_streams where actor_id=v_actor and device_id=v_device and client_generation=v_generation) then
    v_status:='conflict'; v_reason:='stream_changed';
  end if;
  v_result:=jsonb_build_object('protocolVersion',1,'commandId',p_command_id,'status',v_status,'reasonCode',v_reason,
    'beforeRevision',v_state.revision,'afterRevision',v_state.revision,'transitionId',null,'effectiveAt',null);
  insert into public.personal_activity_commands(command_id,actor_id,subject_profile_id,protocol_version,normalized_payload,payload_hash,
    device_id,client_generation,client_sequence,predecessor_command_id,expected_revision,status,reason_code,before_revision,after_revision,result)
  values(p_command_id,v_actor,v_actor,1,v_payload,v_hash,v_device,v_generation,0,null,v_expected,v_status,v_reason,v_state.revision,v_state.revision,v_result);
  if v_status='noop' then
    if v_stream.id is not null then update public.work_activity_streams set status='retired',retired_at=clock_timestamp() where id=v_stream.id; end if;
    insert into public.work_activity_streams(actor_id,device_id,client_generation,head_sequence,head_command_id,anchor_observation_id,status)
    values(v_actor,v_device,v_generation,0,p_command_id,v_observation_id,'active');
  end if;
  return v_result;
end; $$;
revoke all on function public._work_activity_establish_stream(uuid,jsonb) from public,anon,authenticated;

create function public._work_activity_context_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' then raise exception using errcode='23514',message='Activity frame identity cannot change.'; end if;
  if tg_op='INSERT' and (new.top_xid is distinct from pg_current_xact_id() or new.backend_pid is distinct from pg_backend_pid()
    or new.actor_id is distinct from auth.uid()) then
    raise exception using errcode='42501',message='Activity frame is not this actor transaction.';
  end if;
  if tg_op='INSERT' and not exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid()
    and classid=7712 and objid=0 and objsubid=2 and mode='ExclusiveLock' and granted) then
    raise exception using errcode='23514',message='Activity frame requires the first gate.';
  end if;
  return new;
end; $$;
revoke all on function public._work_activity_context_guard() from public,anon,authenticated;
create trigger work_activity_context_guard before insert or update on public.work_activity_transaction_context
 for each row execute function public._work_activity_context_guard();

create function public._work_activity_context_commit_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.work_activity_transaction_context where id=new.id) then
    raise exception using errcode='23514',message='An unfinished activity frame cannot commit.';
  end if;
  return null;
end; $$;
revoke all on function public._work_activity_context_commit_guard() from public,anon,authenticated;
create constraint trigger work_activity_context_closed after insert on public.work_activity_transaction_context
 deferrable initially deferred for each row execute function public._work_activity_context_commit_guard();

create function public._work_activity_context_assert(p_frame_id uuid) returns public.work_activity_transaction_context
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_frame public.work_activity_transaction_context;
begin
  select * into v_frame from public.work_activity_transaction_context where id=p_frame_id
    and top_xid=pg_current_xact_id() and backend_pid=pg_backend_pid() and actor_id=auth.uid();
  if v_frame.id is null then raise exception using errcode='42501',message='Activity frame is unavailable.'; end if;
  if exists(select 1 from public.work_activity_transaction_context where parent_id=v_frame.id) then
    raise exception using errcode='23514',message='Finish the nested activity frame first.';
  end if;
  return v_frame;
end; $$;
revoke all on function public._work_activity_context_assert(uuid) from public,anon,authenticated;

create function public._work_activity_context_open(p_route text,p_cause text,p_selected_at timestamptz,p_parent_id uuid default null) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_parent public.work_activity_transaction_context; v_id uuid;
begin
  perform public._work_activity_gate();
  v_actor:=auth.uid();
  -- Identity primitive, not a public authorization route. Existing payroll
  -- callers must retain THEIR authority; new-start eligibility must not block
  -- an otherwise permitted close. New capture uses _work_activity_actor().
  if v_actor is null or not exists(select 1 from public.profiles where id=v_actor) then
    raise exception using errcode='42501',message='An existing signed-in actor is required.';
  end if;
  if (select count(*) from public.work_activity_transaction_context where top_xid=pg_current_xact_id() and backend_pid=pg_backend_pid())>=16 then
    raise exception using errcode='54000',message='Activity context nesting is too deep.';
  end if;
  if p_route is null or p_route !~ '^[a-z][a-z0-9_]{0,119}$' or p_selected_at is null or not isfinite(p_selected_at) then
    raise exception using errcode='23514',message='Invalid activity frame.';
  end if;
  if p_parent_id is not null then v_parent:=public._work_activity_context_assert(p_parent_id); end if;
  insert into public.work_activity_transaction_context(top_xid,backend_pid,parent_id,actor_id,subject_profile_id,route,cause,selected_effective_at)
  values(pg_current_xact_id(),pg_backend_pid(),p_parent_id,v_actor,v_actor,p_route,p_cause,p_selected_at) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public._work_activity_context_open(text,text,timestamptz,uuid) from public,anon,authenticated;

create function public._work_activity_expect(p_frame_id uuid,p_table regclass,p_operation text,p_source_id uuid,p_columns text[],p_before jsonb,p_after jsonb) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_frame public.work_activity_transaction_context; v_subject name; v_id uuid; v_name text;
begin
  v_frame:=public._work_activity_context_assert(p_frame_id);
  select c.relname into v_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=p_table and n.nspname='public';
  if v_name is null or v_name<>all(array['time_shifts','custom_work_sessions','unit_sessions','task_sessions','service_time_sessions','opening_phases','work_setup_sessions']) then
    raise exception using errcode='23514',message='Unsupported activity mutation source.';
  end if;
  v_subject:=case when v_name='opening_phases' then 'started_by' else 'profile_id' end;
  if p_source_id is null or p_columns is null or cardinality(p_columns) not between 1 and 64
    or array_position(p_columns,null) is not null or cardinality(p_columns)<>(select count(distinct c) from unnest(p_columns) c)
    or exists(select 1 from unnest(p_columns) c where not exists(select 1 from pg_attribute where attrelid=p_table and attname=c and attnum>0 and not attisdropped)) then
    raise exception using errcode='23514',message='Invalid activity column allowance.';
  end if;
  if (p_before is not null and (jsonb_typeof(p_before)<>'object' or p_before->>'id' is distinct from p_source_id::text or p_before->>v_subject is distinct from v_frame.subject_profile_id::text))
    or (p_after is not null and (jsonb_typeof(p_after)<>'object' or p_after->>'id' is distinct from p_source_id::text or p_after->>v_subject is distinct from v_frame.subject_profile_id::text)) then
    raise exception using errcode='23514',message='Activity mutation identity does not match the frame.';
  end if;
  if p_operation='UPDATE' and (not(p_before ?& p_columns) or not(p_after ?& p_columns)) then
    raise exception using errcode='23514',message='Every allowed update column needs before and after evidence.';
  end if;
  insert into public.work_activity_expected_mutations(frame_id,table_oid,operation,subject_profile_id,source_id,subject_column,allowed_columns,expected_before,expected_after)
  values(p_frame_id,p_table,p_operation,v_frame.subject_profile_id,p_source_id,v_subject,p_columns,p_before,p_after) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public._work_activity_expect(uuid,regclass,text,uuid,text[],jsonb,jsonb) from public,anon,authenticated;

create function public._work_activity_consume(p_expectation_id uuid,p_table regclass,p_operation text,p_before jsonb,p_after jsonb) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_expected public.work_activity_expected_mutations; v_frame public.work_activity_transaction_context;
begin
  select * into v_expected from public.work_activity_expected_mutations where id=p_expectation_id;
  if v_expected.id is null then raise exception using errcode='42501',message='Activity mutation allowance is unavailable.'; end if;
  v_frame:=public._work_activity_context_assert(v_expected.frame_id);
  if v_expected.consumed or v_expected.table_oid is distinct from p_table::oid or v_expected.operation is distinct from p_operation
    or (p_before is null) is distinct from (v_expected.expected_before is null)
    or (p_after is null) is distinct from (v_expected.expected_after is null)
    or (p_before is not null and (jsonb_typeof(p_before)<>'object' or exists(select 1 from jsonb_each(v_expected.expected_before) e where p_before->e.key is distinct from e.value)))
    or (p_after is not null and (jsonb_typeof(p_after)<>'object' or exists(select 1 from jsonb_each(v_expected.expected_after) e where p_after->e.key is distinct from e.value))) then
    raise exception using errcode='23514',message='Activity mutation does not match its exact allowance.';
  end if;
  if p_operation='UPDATE' and exists(
    select 1 from (select jsonb_object_keys(p_before) k union select jsonb_object_keys(p_after)) keys
    where p_before->k is distinct from p_after->k and k<>all(v_expected.allowed_columns)) then
    raise exception using errcode='23514',message='Activity mutation changes an unapproved column.';
  end if;
  update public.work_activity_expected_mutations set consumed=true where id=p_expectation_id;
end; $$;
revoke all on function public._work_activity_consume(uuid,regclass,text,jsonb,jsonb) from public,anon,authenticated;

create function public._work_activity_context_close(p_frame_id uuid) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_frame public.work_activity_transaction_context;
begin
  v_frame:=public._work_activity_context_assert(p_frame_id);
  if exists(select 1 from public.work_activity_expected_mutations where frame_id=p_frame_id and not consumed) then
    raise exception using errcode='23514',message='Activity frame has unapplied expected mutations.';
  end if;
  delete from public.work_activity_expected_mutations where frame_id=p_frame_id;
  delete from public.work_activity_transaction_context where id=p_frame_id;
end; $$;
revoke all on function public._work_activity_context_close(uuid) from public,anon,authenticated;

-- Allowance identities cannot be retargeted after creation, reset after
-- consumption, or discarded unconsumed to make an unfinished frame look done.
create function public._work_activity_expected_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_frame public.work_activity_transaction_context;
begin
  v_frame:=public._work_activity_context_assert(case when tg_op='INSERT' then new.frame_id else old.frame_id end);
  if tg_op='INSERT' then
    if new.consumed or new.subject_profile_id is distinct from v_frame.subject_profile_id
      or (new.expected_before is not null and (new.expected_before->>'id' is distinct from new.source_id::text or new.expected_before->>new.subject_column is distinct from v_frame.subject_profile_id::text))
      or (new.expected_after is not null and (new.expected_after->>'id' is distinct from new.source_id::text or new.expected_after->>new.subject_column is distinct from v_frame.subject_profile_id::text)) then
      raise exception using errcode='23514',message='Activity allowance identity does not match its live frame.';
    end if;
  elsif tg_op='UPDATE' then
    if old.consumed or not new.consumed or (to_jsonb(new)-'consumed') is distinct from (to_jsonb(old)-'consumed') then
      raise exception using errcode='23514',message='An activity allowance can only be consumed once.';
    end if;
  elsif not old.consumed then
    raise exception using errcode='23514',message='An unapplied activity allowance cannot be discarded.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
revoke all on function public._work_activity_expected_guard() from public,anon,authenticated;
create trigger work_activity_expected_guard before insert or update or delete on public.work_activity_expected_mutations
 for each row execute function public._work_activity_expected_guard();

-- Only the NEW private setup source is guarded here. No existing source gets a
-- timing trigger until the complete entry/callback closure lands together.
create function public._work_activity_setup_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_expected uuid; v_cause text; v_boundary timestamptz;
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='Setup evidence is retained.'; end if;
  if tg_op='INSERT' and not public._work_config_internal(new.profile_id) then
    raise exception using errcode='42501',message='An eligible Forge account is required for new setup.';
  end if;
  if tg_op='INSERT' and (new.ended_at is not null or new.selected_end_at is not null or new.end_reason is not null or new.end_transition_id is not null) then
    raise exception using errcode='23514',message='A setup segment must begin open.';
  end if;
  if tg_op='UPDATE' and (old.ended_at is not null or new.ended_at is null
    or (to_jsonb(new)-array['ended_at','selected_end_at','end_reason','end_transition_id']) is distinct from (to_jsonb(old)-array['ended_at','selected_end_at','end_reason','end_transition_id'])) then
    raise exception using errcode='23514',message='Only an open setup interval can close once.';
  end if;
  select m.id,c.cause,c.selected_effective_at into v_expected,v_cause,v_boundary from public.work_activity_expected_mutations m
    join public.work_activity_transaction_context c on c.id=m.frame_id
    where c.top_xid=pg_current_xact_id() and c.backend_pid=pg_backend_pid() and c.actor_id=auth.uid()
      and m.table_oid=tg_relid and m.operation=tg_op and m.source_id=new.id and m.subject_profile_id=new.profile_id and not m.consumed;
  if v_expected is null then raise exception using errcode='42501',message='Setup requires an exact private activity frame.'; end if;
  if (tg_op='INSERT' and (new.started_at is distinct from v_boundary or v_cause<>(case when new.resumed_from_id is null then 'clock_in' else 'break_end' end)))
    or (tg_op='UPDATE' and (new.selected_end_at is distinct from v_boundary or new.ended_at is distinct from greatest(new.started_at,v_boundary)
      or v_cause<>(case new.end_reason when 'setup_complete' then 'stop' when 'switch' then 'switch' when 'break' then 'break_start' when 'clock_out' then 'clock_out' when 'correction' then 'correction' when 'void' then 'void' else 'legacy_transition' end))) then
    raise exception using errcode='23514',message='Setup mutation does not match the frame boundary and cause.';
  end if;
  perform public._work_activity_consume(v_expected,tg_relid::regclass,tg_op,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
  return new;
end; $$;
revoke all on function public._work_activity_setup_guard() from public,anon,authenticated;
create trigger work_activity_setup_guard before insert or update or delete on public.work_setup_sessions
 for each row execute function public._work_activity_setup_guard();

create function public._work_activity_setup_ledger_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.work_setup_sessions; t public.personal_activity_transitions; prior public.work_setup_sessions;
begin
  select * into strict v from public.work_setup_sessions where id=new.id;
  select * into t from public.personal_activity_transitions where id=v.start_transition_id;
  if t.id is null or t.profile_id is distinct from v.profile_id or t.source_shift_id is distinct from v.shift_id
    or t.selected_effective_at is distinct from v.started_at or t.cause<>(case when v.resumed_from_id is null then 'clock_in' else 'break_end' end)
    or (v.resumed_from_id is null and (t.source_request_id is distinct from v.clock_client_id or t.actor_id is distinct from v.profile_id))
    or (tg_op='INSERT' and v.resumed_from_id is null and not exists(select 1 from public.time_shifts ts where ts.id=v.shift_id and ts.profile_id=v.profile_id and ts.clock_in_at=v.started_at))
    or (tg_op='INSERT' and not exists(select 1 from public.time_clock_actions where client_id=v.clock_client_id and profile_id=v.profile_id and shift_id=v.shift_id and action='clock_in')) then
    raise exception using errcode='23514',message='Setup lacks its actual clock and lifecycle identity.';
  end if;
  if v.resumed_from_id is not null then
    select * into prior from public.work_setup_sessions where id=v.resumed_from_id;
    if prior.profile_id is distinct from v.profile_id or prior.shift_id is distinct from v.shift_id or prior.clock_client_id is distinct from v.clock_client_id
      or prior.end_reason is distinct from 'break' or prior.ended_at is null or prior.ended_at>v.started_at then
      raise exception using errcode='23514',message='Setup resume does not match its prior segment.';
    end if;
  end if;
  if v.ended_at is not null then
    select * into t from public.personal_activity_transitions where id=v.end_transition_id;
    -- A single root clock-in can close an OLD shift and start a NEW one.
    -- Preserve that one revision; its typed child event owns the old source's
    -- exact shift/cause/boundary, which need not equal the root transition.
    if t.id is null or t.profile_id is distinct from v.profile_id
      or v.ended_at is distinct from greatest(v.started_at,v.selected_end_at)
      or not exists(select 1 from public.personal_activity_transition_sources e
        where e.transition_id=v.end_transition_id and e.profile_id=v.profile_id
          and e.source_kind='setup' and e.source_id=v.id and e.relation='effective'
          and e.source_shift_id=v.shift_id and e.selected_effective_at=v.selected_end_at
          and e.cause=(case v.end_reason when 'setup_complete' then 'stop' when 'switch' then 'switch' when 'break' then 'break_start'
            when 'clock_out' then 'clock_out' when 'correction' then 'correction' when 'void' then 'void' else 'legacy_transition' end)) then
      raise exception using errcode='23514',message='Setup end lacks its exact per-source lifecycle boundary.';
    end if;
  end if;
  return null;
end; $$;
revoke all on function public._work_activity_setup_ledger_guard() from public,anon,authenticated;
create constraint trigger work_activity_setup_ledger after insert or update on public.work_setup_sessions
 deferrable initially deferred for each row execute function public._work_activity_setup_ledger_guard();

create function public._work_activity_transition_source_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.personal_activity_transitions where id=new.transition_id and profile_id=new.profile_id) then
    raise exception using errcode='23514',message='Source evidence must belong to its actual lifecycle subject.';
  end if;
  return new;
end; $$;
revoke all on function public._work_activity_transition_source_guard() from public,anon,authenticated;
create trigger work_activity_transition_source_guard before insert on public.personal_activity_transition_sources
 for each row execute function public._work_activity_transition_source_guard();

comment on table public.work_activity_observations is 'Private immutable server-issued revision/stream observations; no operational source writes. No public issuer exists in this slice.';
comment on table public.work_activity_streams is 'Private retained actor/device/generation identities; one current active or blocked generation. No dispatcher or public capture RPC exists.';
comment on table public.work_activity_transaction_context is 'Ephemeral backend/top-transaction frames. Deferred guard rejects commit unless every frame is closed. Never copy/merge as retained evidence.';
comment on table public.work_activity_expected_mutations is 'Ephemeral exact single-use source allowances, removed with completed frames. No GUC or trigger-depth bypass.';
comment on table public.work_setup_sessions is 'Inactive private setup allocation of the actual keyed clock shift. No operational parent cascade; no payroll writer.';
comment on table public.personal_activity_transition_sources is 'Immutable bounded source identities linked to their actual personal lifecycle transition; no operational parent cascade.';
commit;
