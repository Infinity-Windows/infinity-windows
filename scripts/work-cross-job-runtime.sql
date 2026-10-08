-- New private implementation. Generation2 remains unreachable while held.
alter table public.personal_activity_commands drop constraint personal_activity_commands_protocol_version_check;
alter table public.personal_activity_commands add constraint personal_activity_commands_protocol_version_check check(protocol_version in(1,2));
alter table public.personal_activity_transitions drop constraint personal_activity_transitions_protocol_version_check;
alter table public.personal_activity_transitions add constraint personal_activity_transitions_protocol_version_check check(protocol_version in(1,2));
create index work_cross_job_source_history_operation on public.work_activity_source_history(source_kind,source_id,operation_id);
create table public.work_cross_job_write_frames (
 operation_id uuid not null, source_kind text not null, source_id uuid not null, profile_id uuid not null, shift_id uuid not null,
 allocation_id uuid, effective_at timestamptz not null, primary key(operation_id,source_kind,source_id)
);
revoke all on table public.work_cross_job_write_frames from public,anon,authenticated,service_role;
alter table public.work_cross_job_write_frames enable row level security;
create trigger work_cross_job_shifts_immutable before update or delete on public.work_cross_job_shifts for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_allocations_immutable before update or delete on public.work_cross_job_allocations for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_bindings_immutable before update or delete on public.work_cross_job_bindings for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_shifts_no_truncate before truncate on public.work_cross_job_shifts for each statement execute function public.work_capture_immutable_record();
create trigger work_cross_job_allocations_no_truncate before truncate on public.work_cross_job_allocations for each statement execute function public.work_capture_immutable_record();
create trigger work_cross_job_bindings_no_truncate before truncate on public.work_cross_job_bindings for each statement execute function public.work_capture_immutable_record();

create function public._work_cross_job_table(p_kind text) returns text language sql immutable set search_path=public,pg_temp as $$
 select case p_kind when 'custom' then 'custom_work_sessions' when 'service' then 'service_time_sessions' when 'unit' then 'unit_sessions' when 'task' then 'task_sessions' when 'phase' then 'opening_phases' when 'setup' then 'work_setup_sessions' when 'shift' then 'time_shifts' end
$$;
-- Indexed current history head; no ordering by time/UUID, no full proof walk.
create function public._work_cross_job_history(p_kind text,p_id uuid) returns public.work_activity_source_history
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.work_activity_source_history; n integer; current_operation uuid;
begin
 current_operation:=(public._work_activity_operation()).id;
 if current_operation is null then return null;end if;
 select count(*) into n from public.work_activity_source_history h where h.source_kind=public._work_cross_job_table(p_kind) and h.source_id=p_id::text and h.operation_id=current_operation
 and not exists(select 1 from public.work_activity_source_history x where x.predecessor_id=h.id);
 if n<>1 then return null;end if;
 select h.* into r from public.work_activity_source_history h where h.source_kind=public._work_cross_job_table(p_kind) and h.source_id=p_id::text and h.operation_id=current_operation
 and not exists(select 1 from public.work_activity_source_history x where x.predecessor_id=h.id);
 if r.legacy_baseline then return null;end if;return r;
end$$;
create function public._work_cross_job_scope(p_shift uuid,p_actor uuid,p_full boolean default true) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s public.work_cross_job_shifts; h public.time_shifts; b public.work_activity_source_history; source_row record; view_state public.personal_activity_state;
begin
 select * into s from public.work_cross_job_shifts where shift_id=p_shift;
 select * into h from public.time_shifts where id=p_shift;
 select * into b from public.work_activity_source_history where id=s.birth_history_id;
 if s.shift_id is null or h.id is null or s.profile_id is distinct from p_actor or h.profile_id is distinct from p_actor
 or h.clock_in_at is distinct from s.clock_in_at or h.project_id is distinct from s.original_project_id or h.cost_code_id is distinct from s.original_cost_code_id
 or b.before_value<>'{}'::jsonb or b.after_value->>'id' is distinct from h.id::text or b.legacy_baseline
 or not public._work_config_internal(p_actor) then return false;end if;
 if exists(select 1 from public.work_activity_source_history x where x.source_kind='time_shifts' and x.source_id=p_shift::text and (x.after_value='{}'::jsonb or (x.before_value='{}'::jsonb and x.id<>s.birth_history_id))) then return false;end if;
 if not public._work_cross_job_head_valid(p_shift) then return false;end if;
 if s.original_project_id is not null and not public._ai_job_visible(s.original_project_id,p_actor) then return false;end if;
 -- All retained original job dependencies must be visible before any receipt.
 if p_full then
  if exists(select 1 from public.work_cross_job_allocations a where a.shift_id=p_shift and not public._ai_job_visible(a.project_id,p_actor)) then return false;end if;
  select * into view_state from public.personal_activity_state where profile_id=p_actor;
  for source_row in select source_kind,source_id,source_effective_at from public.work_cross_job_bindings where shift_id=p_shift loop
   view_state.active_source_kind:=source_row.source_kind;view_state.active_source_id:=source_row.source_id;view_state.effective_since:=source_row.source_effective_at;
   if public._work_activity_source_view(view_state)->>'visibility' is distinct from 'available' then return false;end if;
  end loop;
 end if;
 return true;
end$$;
create function public._work_cross_job_register(p_shift public.time_shifts,p_request uuid) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations; person public.work_activity_operation_people; birth public.work_activity_source_history;
begin
 o:=public._work_activity_operation();person:=public._work_activity_touch(p_shift.profile_id);birth:=public._work_cross_job_history('shift',p_shift.id);
 if not public._work_cross_job_enabled() or o.route<>'clock_in_setup' or o.arguments->>'setupVersion'<>'2' or o.request_id is distinct from p_request
 or o.actor_id is distinct from p_shift.profile_id or birth.operation_id is distinct from o.id or birth.before_value<>'{}'::jsonb
 or birth.after_value->>'id' is distinct from p_shift.id::text or birth.legacy_baseline then raise exception using errcode='23514',message='Unsupported cross-job physical origin.';end if;
 insert into public.work_cross_job_shifts(shift_id,profile_id,clock_in_at,birth_history_id,birth_transition_id,clock_request_id,original_project_id,original_cost_code_id,generation)
 values(p_shift.id,p_shift.profile_id,p_shift.clock_in_at,birth.id,person.transition_id,p_request,p_shift.project_id,p_shift.cost_code_id,2);
end$$;
-- No source is admitted merely because another source on this shift is v2.
create function public._work_cross_job_birth_guard(p_kind text,p_before jsonb,p_after jsonb) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare who uuid; sh uuid; o public.work_activity_operations; starts boolean; open_count integer;
begin
 if p_kind not in('custom','service','unit','task','phase','setup') then return;end if;
 who:=(p_after->>case when p_kind='phase' then 'started_by' else 'profile_id' end)::uuid;
 starts:=case when p_kind='phase' then p_after->>'status'='active' and p_after->>'paused_at' is null and (p_before is null or p_before->>'paused_at' is not null or p_before->>'status' is distinct from 'active')
 else p_after->>'ended_at' is null and (p_before is null or p_before->>'ended_at' is not null) and (p_kind<>'task' or p_after->>'state'='on_task') end;
 if starts is distinct from true then return;end if;
 if not exists(select 1 from public.work_cross_job_shifts s join public.time_shifts h on h.id=s.shift_id where s.profile_id=who and h.status='open' and h.clock_out_at is null) then return;end if;
 select count(*) into open_count from public.time_shifts h where h.profile_id=who and h.status='open' and h.clock_out_at is null;
 if open_count<>1 then raise exception using errcode='23514',message='Choose work on one unambiguous paid shift.';end if;
 select s.shift_id into sh from public.work_cross_job_shifts s join public.time_shifts h on h.id=s.shift_id where s.profile_id=who and h.status='open' and h.clock_out_at is null;
 o:=public._work_activity_operation();
 if p_kind='setup' and o.actor_id=who and o.route in('clock_in_setup','end_break') then return;end if;
 if not exists(select 1 from public.work_cross_job_write_frames f where f.operation_id=o.id and f.profile_id=who and f.shift_id=sh
 and f.source_kind=p_kind and f.source_id=(p_after->>'id')::uuid) then
 raise exception using errcode='23514',message='Choose work using the current capture version.';end if;
end$$;
create function public._work_cross_job_bind(p_kind text,p_id uuid,p_shift uuid,p_allocation uuid,p_started timestamptz,p_prior uuid default null) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations; person public.work_activity_operation_people; h public.work_activity_source_history; a public.work_cross_job_allocations; s public.work_cross_job_shifts;
begin
 o:=public._work_activity_operation();select * into s from public.work_cross_job_shifts where shift_id=p_shift;
 person:=public._work_activity_touch(s.profile_id);h:=public._work_cross_job_history(p_kind,p_id);
 select * into a from public.work_cross_job_allocations where id=p_allocation;
 if h.id is null or h.operation_id is distinct from o.id or h.after_value->>'id' is distinct from p_id::text
 or (p_kind<>'setup' and (a.shift_id is distinct from p_shift or a.profile_id is distinct from s.profile_id or a.effective_at>p_started)) then
 raise exception using errcode='23514',message='Source birth does not match allocation.';end if;
 insert into public.work_cross_job_bindings(source_kind,source_id,birth_history_id,source_effective_at,profile_id,shift_id,allocation_id,project_id,command_id,transition_id,resumed_from_history_id,generation)
 values(p_kind,p_id,h.id,p_started,s.profile_id,p_shift,p_allocation,a.project_id,o.command_id,person.transition_id,p_prior,2);
end$$;
create function public._work_cross_job_local_valid(p_kind text,p_row jsonb,p_shift public.time_shifts) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare b public.work_cross_job_bindings; a public.work_cross_job_allocations; s public.work_cross_job_shifts; n integer; birth public.work_activity_source_history;
begin
 select count(*) into n from public.work_cross_job_bindings where source_kind=p_kind and source_id=(p_row->>'id')::uuid;
 if n<>1 then return false;end if;
 select * into b from public.work_cross_job_bindings where source_kind=p_kind and source_id=(p_row->>'id')::uuid;
 select * into s from public.work_cross_job_shifts where shift_id=b.shift_id;
 select * into a from public.work_cross_job_allocations where id=b.allocation_id;
 select * into birth from public.work_activity_source_history where id=b.birth_history_id;
 return coalesce(b.shift_id=p_shift.id and b.profile_id=p_shift.profile_id and p_row->>'profile_id'=b.profile_id::text
 and p_row->>'shift_id'=b.shift_id::text and p_row->>'project_id'=b.project_id::text and a.project_id=b.project_id and a.shift_id=b.shift_id
 and (p_row->>'started_at')::timestamptz=b.source_effective_at and a.effective_at<=b.source_effective_at
 and not exists(select 1 from public.work_activity_source_history x where x.source_kind=public._work_cross_job_table(p_kind) and x.source_id=b.source_id::text and (x.after_value='{}'::jsonb or (x.before_value='{}'::jsonb and x.id<>b.birth_history_id)))
 and birth.before_value='{}'::jsonb and birth.after_value->>'id'=b.source_id::text and not birth.legacy_baseline
 and s.clock_in_at=p_shift.clock_in_at and s.original_project_id is not distinct from p_shift.project_id
 and s.original_cost_code_id is not distinct from p_shift.cost_code_id and p_shift.status not in('needs_finish','rejected','voided')
 and b.source_effective_at>=p_shift.clock_in_at
 -- Callbacks run before lifecycle closure. A live source is valid only when
 -- its actual/effective start is already within the paid boundary; a closed
 -- source must also end within it. Equality is a valid zero-length interval.
 and (p_shift.clock_out_at is null or (b.source_effective_at<=p_shift.clock_out_at
  and (p_row->>'ended_at' is null or (p_row->>'ended_at')::timestamptz<=p_shift.clock_out_at))),false);
end$$;

-- General and Specific direct/resumed births share this exact writer.
create function public._work_cross_job_custom(p_profile uuid,p_shift public.time_shifts,p_allocation uuid,p_intent jsonb,p_at timestamptz,p_cause text,p_prior uuid default null) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.work_cross_job_allocations; d public.work_activity_definition_versions; data jsonb; new_id uuid:=gen_random_uuid(); frame uuid; columns text[]; o public.work_activity_operations; basis jsonb;
begin
 o:=public._work_activity_operation();select * into a from public.work_cross_job_allocations where id=p_allocation;
 if o.actor_id is distinct from p_profile or p_shift.profile_id is distinct from p_profile or a.shift_id is distinct from p_shift.id
 or a.project_id is distinct from (p_intent->>'projectId')::uuid or not public._work_cross_job_scope(p_shift.id,p_profile,false)
 or public._work_activity_validate_switch(p_intent,p_profile) is not null or p_shift.break_started_at is not null or p_shift.clock_out_at is not null
 or p_shift.status<>'open' or p_at<a.effective_at or exists(select 1 from public._work_activity_live_sources(p_profile)) then
 raise exception using errcode='23514',message='Cross-job source is unavailable.';end if;
 if p_intent->>'scope'='specific' then perform public._unit_work_gate(p_profile);else perform public._prep_time_gate(p_profile);end if;
 select * into d from public.work_activity_definition_versions where id=(p_intent->>'definitionVersionId')::uuid;
 data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'shift_id',p_shift.id,'project_id',a.project_id,'unit_id',p_intent#>'{unit,id}',
 'kind',case when p_intent->>'scope'='specific' then 'unit' else 'idle' end,'participation','install','stage',left(d.label_en,100),'description',d.label_en,'started_at',p_at,'shift_status',p_shift.status,'review_required',false);
 insert into public.work_cross_job_write_frames values(o.id,'custom',new_id,p_profile,p_shift.id,a.id,p_at);
 select array_agg(key order by key) into columns from jsonb_object_keys(data)key;frame:=public._work_activity_context_for(p_profile,p_cause,p_at);
 perform public._work_activity_expect(frame,'public.custom_work_sessions'::regclass,'INSERT',new_id,columns,null,public._work_activity_evidence('custom_work_sessions',data));
 insert into public.custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,participation,stage,description,started_at,shift_status,review_required)
 select r.id,r.profile_id,r.shift_id,r.project_id,r.unit_id,r.kind,r.participation,r.stage,r.description,r.started_at,r.shift_status,r.review_required from jsonb_populate_record(null::public.custom_work_sessions,data)r;
 perform public._work_activity_context_close(frame);
 if p_intent->>'scope'='specific' then basis:=public._work_activity_command_basis(public._work_activity_unit_basis((p_intent#>>'{unit,id}')::uuid,p_profile));end if;
 insert into public.work_session_capture_metadata(session_id,profile_id,project_id,definition_version_id,menu_version_id,scope,unit_id,fact_revision,unit_facts,machine_kind,selection_id,selection_revision,answers,unit_basis,continuation_unit_basis)
 values(new_id,p_profile,a.project_id,d.id,(p_intent->>'menuVersionId')::uuid,p_intent->>'scope',(p_intent#>>'{unit,id}')::uuid,(p_intent#>>'{unit,factRevision}')::bigint,
 case when p_intent->>'scope'='specific' then public._work_activity_fact_snapshot((p_intent#>>'{unit,id}')::uuid) end,p_intent->>'machineKind',(p_intent->>'selectionId')::uuid,(p_intent->>'selectionRevision')::bigint,p_intent->'values',nullif(p_intent->'unit','null'::jsonb),basis);
 perform public._work_cross_job_bind('custom',new_id,p_shift.id,p_allocation,p_at,p_prior);
 delete from public.work_cross_job_write_frames where operation_id=o.id and source_kind='custom' and source_id=new_id;
 return new_id;
end$$;

-- Exact eligibility is checked after close and again independently at resume.
create function public._work_cross_job_save(p_state public.personal_activity_state,p_shift uuid,p_break timestamptz,p_transition uuid) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare h public.work_activity_source_history; r jsonb; b public.work_cross_job_bindings; a uuid; n integer; o public.work_activity_operations;
begin
 delete from public.work_cross_job_resume where profile_id=p_state.profile_id;
 begin
 if p_state.active_source_id is null or p_state.effective_since is null or p_state.effective_since>p_break then return false;end if;
 o:=public._work_activity_operation();h:=public._work_cross_job_history(p_state.active_source_kind,p_state.active_source_id);r:=h.after_value;
 if h.id is null or h.operation_id is distinct from o.id or not(p_transition=any(h.transition_ids))
 or (case when p_state.active_source_kind='phase' then (r->>'paused_at')::timestamptz else (r->>'ended_at')::timestamptz end) is distinct from p_break
 or coalesce((r->>'review_required')::boolean,false) or (p_state.active_source_kind in('custom','unit','service','setup') and r->>'end_reason' is distinct from 'break') then return false;end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift) then
   select count(*) into n from public.work_cross_job_bindings where source_kind=p_state.active_source_kind and source_id=p_state.active_source_id and source_effective_at=p_state.effective_since;
   if n<>1 then return false;end if;
   select * into b from public.work_cross_job_bindings where source_kind=p_state.active_source_kind and source_id=p_state.active_source_id and source_effective_at=p_state.effective_since;
   select allocation_id into a from public.work_cross_job_heads where shift_id=p_shift;
   if b.allocation_id is distinct from a or b.shift_id is distinct from p_shift or b.profile_id is distinct from p_state.profile_id
   or exists(select 1 from public.work_cross_job_allocations where id=a and effective_at>p_break) then return false;end if;
 end if;
 insert into public.work_cross_job_resume(profile_id,shift_id,source_kind,source_id,closure_history_id,birth_history_id,break_transition_id,break_started_at,effective_started_at,allocation_id,authority_revision,source_value)
 values(p_state.profile_id,p_shift,p_state.active_source_kind,p_state.active_source_id,h.id,coalesce(b.birth_history_id,h.id),p_transition,p_break,p_state.effective_since,a,public._work_activity_authority_revision(),r);
 return true;
exception when raise_exception or check_violation or foreign_key_violation or unique_violation or insufficient_privilege or numeric_value_out_of_range then return false;
 end;
end$$;
create function public._work_cross_job_resume_basis(p_state public.personal_activity_state,p_shift public.time_shifts,p_at timestamptz) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare b public.work_cross_job_resume; h public.work_activity_source_history; paid public.work_activity_source_history; o public.work_activity_operations; a uuid; t public.personal_activity_transitions; binding public.work_cross_job_bindings;
begin
 o:=public._work_activity_operation();select * into b from public.work_cross_job_resume where profile_id=p_state.profile_id;
 if b.profile_id is null or b.source_id is distinct from p_state.resume_source_id or b.source_kind is distinct from p_state.resume_source_kind
 or b.shift_id is distinct from p_shift.id or b.break_transition_id is distinct from p_state.resume_after_break_transition_id
 or b.effective_started_at>b.break_started_at or b.break_started_at>p_at or b.authority_revision is distinct from public._work_activity_authority_revision()
 or o.route<>'end_break' or o.actor_id is distinct from p_state.profile_id then return false;end if;
 select * into h from public.work_activity_source_history where id=b.closure_history_id and source_kind=public._work_cross_job_table(b.source_kind) and source_id=b.source_id::text;
 if exists(select 1 from public.work_activity_source_history where predecessor_id=h.id) then return false;end if;
 select * into paid from public.work_activity_source_history where operation_id=o.id and source_kind='time_shifts' and source_id=p_shift.id::text and before_value->>'break_started_at' is not null and after_value->>'break_started_at' is null;
 if not found then return false;end if;
 select * into t from public.personal_activity_transitions where id=b.break_transition_id;
 if t.id is null or t.profile_id is distinct from p_state.profile_id or t.source_shift_id is distinct from p_shift.id or t.cause<>'break_start'
 or t.selected_effective_at is distinct from b.break_started_at or not(b.break_transition_id=any(h.transition_ids))
 or t.before_evidence#>>'{state,active_source_kind}' is distinct from b.source_kind
 or t.before_evidence#>>'{state,active_source_id}' is distinct from b.source_id::text
 or (t.before_evidence#>>'{state,effective_since}')::timestamptz is distinct from b.effective_started_at then return false;end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id) then
  select * into binding from public.work_cross_job_bindings where source_kind=b.source_kind and source_id=b.source_id and birth_history_id=b.birth_history_id;
  if binding.source_id is null or binding.source_effective_at is distinct from b.effective_started_at or binding.source_effective_at>b.break_started_at
   or binding.allocation_id is distinct from b.allocation_id or binding.shift_id is distinct from p_shift.id or binding.profile_id is distinct from p_state.profile_id
   or exists(select 1 from public.work_cross_job_allocations where id=binding.allocation_id and effective_at>b.break_started_at) then return false;end if;
 end if;
 if h.id is distinct from b.closure_history_id or h.after_value is distinct from b.source_value or h.legacy_baseline
 or paid.operation_id is distinct from o.id or (paid.before_value->>'break_started_at')::timestamptz is distinct from b.break_started_at
 or paid.after_value->>'break_started_at' is not null or (paid.after_value->>'last_punch_at')::timestamptz is distinct from p_at
 or (case when b.source_kind='phase' then (h.after_value->>'paused_at')::timestamptz else (h.after_value->>'ended_at')::timestamptz end) is distinct from b.break_started_at
 or coalesce((h.after_value->>'review_required')::boolean,false) then return false;end if;
 select allocation_id into a from public.work_cross_job_heads where shift_id=p_shift.id;
 if a is distinct from b.allocation_id or not public._work_cross_job_head_valid(p_shift.id) then return false;end if;
 if exists(select 1 from public.work_cross_job_shifts where shift_id=p_shift.id) and not public._work_cross_job_scope(p_shift.id,p_state.profile_id,false) then return false;end if;
 return true;
end$$;
create or replace function public.custom_work_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Unregistered sources retain the exact legacy callback behavior.
 update public.custom_work_sessions s set shift_status=new.status,
 review_required=review_required or new.status in('needs_finish','rejected','voided') or project_id is distinct from new.project_id
 or started_at<new.clock_in_at or (ended_at is not null and new.clock_out_at is not null and ended_at>new.clock_out_at)
 where shift_id=new.id and not exists(select 1 from public.work_cross_job_shifts x where x.shift_id=s.shift_id);
 update public.custom_work_sessions s set shift_status=new.status,review_required=coalesce(s.review_required,false) or
 not public._work_cross_job_local_valid('custom',to_jsonb(s),new)
 or coalesce((new.break_started_at is not null and old.break_started_at is null and (s.started_at>new.break_started_at or s.ended_at>new.break_started_at)),false)
 where shift_id=new.id and exists(select 1 from public.work_cross_job_shifts x where x.shift_id=s.shift_id)
 and (s.shift_status is distinct from new.status or (not coalesce(s.review_required,false) and (
 not public._work_cross_job_local_valid('custom',to_jsonb(s),new)
 or coalesce((new.break_started_at is not null and old.break_started_at is null and (s.started_at>new.break_started_at or s.ended_at>new.break_started_at)),false))));
 return new;
end$$;
create or replace function public.service_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare visit_id uuid; r public.service_time_sessions; bad boolean; affected uuid[]:='{}'; registered boolean;
begin
 registered:=exists(select 1 from public.work_cross_job_shifts where shift_id=new.id);
 for r in select * from public.service_time_sessions where shift_id=new.id loop
  if not registered then
   bad:=r.review_required or new.status in('needs_finish','rejected','voided') or r.project_id is distinct from new.project_id
    or r.started_at<new.clock_in_at or (r.ended_at is not null and new.clock_out_at is not null and r.ended_at>new.clock_out_at)
    or (new.break_seconds is distinct from old.break_seconds and old.break_started_at is null);
   update public.service_time_sessions set review_required=bad where id=r.id;
   affected:=array_append(affected,r.visit_id);
  else
   bad:=not public._work_cross_job_local_valid('service',to_jsonb(r),new)
    or (new.break_seconds is distinct from old.break_seconds and old.break_started_at is null)
    or coalesce((new.break_started_at is not null and old.break_started_at is null and (r.started_at>new.break_started_at or r.ended_at>new.break_started_at)),false);
   if bad and not r.review_required then update public.service_time_sessions set review_required=true where id=r.id;end if;
   -- Original trigger runs BEFORE lifecycle closure. Include active intervals
   -- at the selected boundary; unrelated earlier visits retain their stamps.
   if bad or (r.ended_at is null and ((new.break_started_at is not null and old.break_started_at is null)
    or (new.clock_out_at is not null and old.clock_out_at is null) or new.status is distinct from old.status)) then affected:=array_append(affected,r.visit_id);end if;
  end if;
 end loop;
 for visit_id in select distinct unnest(affected) order by 1 loop
  perform public._work_activity_review_visit(visit_id,(public._work_activity_operation()).arrival_at,'correction');
 end loop;
 return new;
end$$;
-- Shared version2 start/resume writer for remaining timing kinds. Public legacy
-- entries remain row-fenced until they explicitly carry this validated context.
create function public._work_cross_job_source(p_profile uuid,p_shift public.time_shifts,p_allocation uuid,p_kind text,p_data jsonb,p_at timestamptz,p_cause text,p_prior uuid default null) returns uuid
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.work_cross_job_allocations; o public.work_activity_operations; new_id uuid; opening public.project_openings; visit public.service_visits;
 data jsonb; frame uuid; columns text[]; oldj jsonb; paused numeric; table_name text;
begin
 o:=public._work_activity_operation();select * into a from public.work_cross_job_allocations where id=p_allocation;
 if p_kind not in('unit','task','service','phase') or o.actor_id is distinct from p_profile or p_shift.profile_id is distinct from p_profile
 or a.shift_id is distinct from p_shift.id or not public._work_cross_job_scope(p_shift.id,p_profile,false) or p_shift.status<>'open'
 or p_shift.break_started_at is not null or p_shift.clock_out_at is not null or p_at<a.effective_at
 or exists(select 1 from public._work_activity_live_sources(p_profile)) then raise exception using errcode='23514',message='Cross-job source is unavailable.';end if;
 perform public._unit_work_gate(p_profile);
 perform public._work_activity_touch(p_profile);
 if p_kind in('unit','task','phase') then
  select * into opening from public.project_openings where id=(p_data->>'opening_id')::uuid;
  if opening.id is null or opening.project_id is distinct from a.project_id or opening.removed_at is not null or opening.status='installed'
  or not public._ai_job_visible(opening.project_id,p_profile) then raise exception using errcode='23514',message='Cross-job opening is unavailable.';end if;
 end if;
 new_id:=gen_random_uuid();
 if p_kind='unit' then
  if p_data->>'role' is distinct from 'install' then raise exception using errcode='23514',message='Unsupported unit participation.';end if;
  data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'opening_id',opening.id,'role','install','is_rework',public._has_open_redo(opening.id),'started_at',p_at);
 elsif p_kind='task' then
  data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'opening_id',opening.id,'project_id',a.project_id,'state','on_task','started_at',p_at);
 elsif p_kind='service' then
  select * into visit from public.service_visits where id=(p_data->>'visit_id')::uuid;
  if visit.id is null or visit.project_id is distinct from a.project_id or visit.status<>'active' or not public.service_job_access(a.project_id)
  or (p_data->>'unit_id' is not null and not exists(select 1 from public.service_visit_units where id=(p_data->>'unit_id')::uuid and visit_id=visit.id and project_id=a.project_id)) then
  raise exception using errcode='23514',message='Cross-job visit is unavailable.';end if;
  data:=jsonb_build_object('id',new_id,'profile_id',p_profile,'visit_id',visit.id,'project_id',a.project_id,'unit_id',p_data->'unit_id','shift_id',p_shift.id,
  'kind',p_data->'kind','stage',p_data->'stage','description',p_data->'description','started_at',p_at);
 elsif p_kind='phase' then
  if p_prior is not null then
   select to_jsonb(x) into oldj from public.opening_phases x where id=(p_data->>'id')::uuid for update;
   if oldj is null or oldj->>'started_by' is distinct from p_profile::text or oldj->>'opening_id' is distinct from opening.id::text or oldj->>'status'<>'active' or oldj->>'paused_at' is null then
   raise exception using errcode='23514',message='Phase continuation is unavailable.';end if;
   paused:=(oldj->>'paused_seconds')::numeric+greatest(0,round(extract(epoch from p_at-(oldj->>'paused_at')::timestamptz)));
   if paused is null or paused<0 or paused>2147483647 then raise exception using errcode='23514',message='Phase continuation is unavailable.';end if;
   new_id:=(oldj->>'id')::uuid;data:=jsonb_build_object('paused_at',null,'paused_seconds',paused::integer);
  else
   data:=jsonb_build_object('id',new_id,'started_by',p_profile,'opening_id',opening.id,'kind',p_data->'kind','status','active','started_at',p_at,'paused_seconds',0);
  end if;
 end if;
 insert into public.work_cross_job_write_frames values(o.id,p_kind,new_id,p_profile,p_shift.id,a.id,p_at);
 if p_kind<>'phase' then
  perform public._work_activity_insert_source(p_profile,p_kind,data,p_at,p_cause);
 else
  frame:=public._work_activity_context_for(p_profile,p_cause,p_at);
  if oldj is null then
   select array_agg(key order by key) into columns from jsonb_object_keys(data)key;
   perform public._work_activity_expect(frame,'public.opening_phases'::regclass,'INSERT',new_id,columns,null,public._work_activity_evidence('opening_phases',data));
   insert into public.opening_phases(id,started_by,opening_id,kind,status,started_at,paused_seconds)
   select r.id,r.started_by,r.opening_id,r.kind,r.status,r.started_at,r.paused_seconds from jsonb_populate_record(null::public.opening_phases,data)r;
  else
   columns:=array['paused_at','paused_seconds'];
   perform public._work_activity_expect(frame,'public.opening_phases'::regclass,'UPDATE',new_id,columns,
   jsonb_build_object('id',new_id,'started_by',p_profile,'paused_at',oldj->'paused_at','paused_seconds',oldj->'paused_seconds'),
   jsonb_build_object('id',new_id,'started_by',p_profile)||data);
   update public.opening_phases set paused_at=null,paused_seconds=paused::integer where id=new_id;
  end if;
  perform public._work_activity_context_close(frame);
 end if;
 perform public._work_cross_job_bind(p_kind,new_id,p_shift.id,a.id,p_at,p_prior);
 delete from public.work_cross_job_write_frames where operation_id=o.id and source_kind=p_kind and source_id=new_id;
 return new_id;
end$$;
-- A mutable head can accelerate CAS but can never turn an ancestor into a head.
create function public._work_cross_job_head_valid(p_shift uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select case when not exists(select 1 from public.work_cross_job_allocations where shift_id=p_shift)
 then not exists(select 1 from public.work_cross_job_heads where shift_id=p_shift)
 else exists(select 1 from public.work_cross_job_heads h join public.work_cross_job_allocations a on a.id=h.allocation_id
 where h.shift_id=p_shift and a.shift_id=p_shift and not exists(select 1 from public.work_cross_job_allocations n where n.predecessor_id=a.id)) end
$$;
create function public._work_cross_job_allocation_guard() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;p public.work_activity_operation_people;prior public.work_cross_job_allocations;head uuid;s public.work_cross_job_shifts;
begin
 o:=public._work_activity_operation();select * into p from public.work_activity_operation_people where operation_id=o.id and profile_id=new.profile_id;
 select * into s from public.work_cross_job_shifts where shift_id=new.shift_id;
 select allocation_id into head from public.work_cross_job_heads where shift_id=new.shift_id;
 select * into prior from public.work_cross_job_allocations where id=new.predecessor_id;
 if o.route is distinct from 'work_activity_command' or o.command_id is distinct from new.command_id or o.actor_id is distinct from new.profile_id
 or p.transition_id is distinct from new.transition_id or s.profile_id is distinct from new.profile_id or new.effective_at<s.clock_in_at
 or new.predecessor_id is distinct from head or not public._work_cross_job_head_valid(new.shift_id)
 or (new.predecessor_id is not null and (prior.shift_id is distinct from new.shift_id or prior.profile_id is distinct from new.profile_id or prior.effective_at>new.effective_at))
 or new.event_kind='amendment' then raise exception using errcode='23514',message='Allocation lacks its exact current command boundary.';end if;
 return new;
end$$;
create trigger work_cross_job_allocation_admission before insert on public.work_cross_job_allocations for each row execute function public._work_cross_job_allocation_guard();
create index work_cross_job_source_incarnations on public.work_activity_source_history(source_kind,source_id) where before_value='{}'::jsonb or after_value='{}'::jsonb;
-- Callback predicates are same-shift lookups, including historical closed visits.
create index work_cross_job_custom_shift on public.custom_work_sessions(shift_id,started_at,ended_at);
create index work_cross_job_service_shift on public.service_time_sessions(shift_id,started_at,ended_at,visit_id);
