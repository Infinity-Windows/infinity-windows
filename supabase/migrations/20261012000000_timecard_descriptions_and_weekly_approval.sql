-- Owner request, 2026-09-16: optional day/job descriptions, foreman editing
-- of self + installers, and one weekly approval per person. Foremen approve
-- self/installers/other foremen; supervisors approve everyone on the crew.
-- Descriptions reuse time_shifts.note; edited_note stays the correction reason.
-- Actual time/job changes reopen approval, while a description alone does not.
-- No production rows are rewritten by this migration.

create or replace function public.can_edit_timecard(p_profile_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select auth.uid() is not null and not public.is_partner_user() and exists (
    select 1 from profiles target where target.id=p_profile_id
    and target.role in ('installer','foreman','lead','supervisor','owner','admin','big_boss')
    and (_is_supervisor(auth.uid()) or (_is_lead(auth.uid())
      and (p_profile_id=auth.uid() or target.role='installer')))
  );
$$;
create or replace function public.can_approve_timecard(p_profile_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select auth.uid() is not null and not public.is_partner_user() and exists (
    select 1 from profiles target where target.id=p_profile_id
    and target.role in ('installer','foreman','lead','supervisor','owner','admin','big_boss')
    and (_is_supervisor(auth.uid()) or (_is_lead(auth.uid())
      and target.role in ('installer','foreman','lead')))
  );
$$;
revoke all on function public.can_edit_timecard(uuid) from public, anon;
revoke all on function public.can_approve_timecard(uuid) from public, anon;
grant execute on function public.can_edit_timecard(uuid) to authenticated;
grant execute on function public.can_approve_timecard(uuid) to authenticated;

create or replace function edit_shift(
  p_shift_id uuid,
  p_project_id uuid default null,
  p_cost_code_id uuid default null,
  p_clock_in_at timestamptz default null,
  p_clock_out_at timestamptz default null,
  p_break_seconds int default null,
  p_note text default null
)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old time_shifts;
  v_shift time_shifts;
  v_signed boolean;
  v_changed boolean;
begin
  if auth.uid() is null or public.is_partner_user() then
    raise exception 'A crew login is required.';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'an edit needs a reason note';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;

  if not public.can_edit_timecard(v_old.profile_id) then
    raise exception 'Foremen may edit their own time and installers; supervisor time requires a supervisor.';
  end if;
  if v_old.status = 'voided' then
    raise exception 'Restore this removed punch before editing it.';
  end if;
  v_changed := (coalesce(p_project_id,v_old.project_id) is distinct from v_old.project_id)
    or (coalesce(p_cost_code_id,v_old.cost_code_id) is distinct from v_old.cost_code_id)
    or (coalesce(p_clock_in_at,v_old.clock_in_at) is distinct from v_old.clock_in_at)
    or (coalesce(p_clock_out_at,v_old.clock_out_at) is distinct from v_old.clock_out_at)
    or (coalesce(p_break_seconds,v_old.break_seconds) is distinct from v_old.break_seconds);
  v_signed := exists (
    select 1 from timecard_periods
    where profile_id = v_old.profile_id
      and employee_signed_at is not null
      and period_start <= v_old.clock_in_at
      and v_old.clock_in_at < period_start + interval '14 days'
  );

  update time_shifts
     set project_id    = coalesce(p_project_id, project_id),
         cost_code_id  = coalesce(p_cost_code_id, cost_code_id),
         clock_in_at   = coalesce(p_clock_in_at, clock_in_at),
         clock_out_at  = coalesce(p_clock_out_at, clock_out_at),
         break_seconds = coalesce(p_break_seconds, break_seconds),
         edited_note   = p_note,
         edited_by     = auth.uid(),
         edited_at     = now(),
         edited_after_signing = edited_after_signing or v_signed,
         status        = case
                           when v_old.status = 'approved' and v_changed
                             then 'submitted'
                           when v_old.status = 'rejected'
                             then 'submitted'
                           when p_clock_out_at is not null
                                and v_old.status in ('open', 'needs_finish')
                             then 'submitted'
                           else v_old.status
                         end,
         approved_by   = case
                           when v_old.status = 'approved' and v_changed
                             then null
                           else approved_by
                         end,
         approved_at   = case
                           when v_old.status = 'approved' and v_changed
                             then null
                           else approved_at
                         end
   where id = p_shift_id
   returning * into v_shift;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  select p_shift_id, auth.uid(), d.field, d.old_value, d.new_value, btrim(p_note)
  from (values
    ('project_id',    v_old.project_id::text,    v_shift.project_id::text),
    ('cost_code_id',  v_old.cost_code_id::text,  v_shift.cost_code_id::text),
    ('clock_in_at',   v_old.clock_in_at::text,   v_shift.clock_in_at::text),
    ('clock_out_at',  v_old.clock_out_at::text,  v_shift.clock_out_at::text),
    ('break_seconds', v_old.break_seconds::text, v_shift.break_seconds::text),
    ('status',        v_old.status,              v_shift.status)
  ) as d(field, old_value, new_value)
  where d.old_value is distinct from d.new_value;

  return v_shift;
end;
$$;

revoke all on function edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text) from public;
grant execute on function edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text) to authenticated;

-- Keep the old entry point, but do not leave a foreman-to-supervisor bypass.
create or replace function public.lead_edit_shift(
  p_shift_id uuid, p_project_id uuid default null, p_cost_code_id uuid default null,
  p_clock_in_at timestamptz default null, p_clock_out_at timestamptz default null,
  p_break_seconds int default null, p_note text default null
) returns time_shifts language sql security definer
set search_path = public, pg_temp as $$
  select public.edit_shift(p_shift_id,p_project_id,p_cost_code_id,p_clock_in_at,p_clock_out_at,p_break_seconds,p_note);
$$;
revoke all on function public.lead_edit_shift(uuid,uuid,uuid,timestamptz,timestamptz,int,text) from public, anon;
grant execute on function public.lead_edit_shift(uuid,uuid,uuid,timestamptz,timestamptz,int,text) to authenticated;

-- A separate name keeps old installed clients working without ambiguous
-- PostgREST overloads. Both edits commit together or neither does.
create or replace function public.edit_shift_with_description(
  p_shift_id uuid, p_project_id uuid default null, p_cost_code_id uuid default null,
  p_clock_in_at timestamptz default null, p_clock_out_at timestamptz default null,
  p_break_seconds int default null, p_note text default null,
  p_description text default null
) returns time_shifts language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_shift time_shifts; v_old_note text; v_description text := nullif(btrim(p_description),'');
begin
  if length(v_description)>4000 then raise exception 'Keep the description under 4,000 characters.'; end if;
  v_shift := public.edit_shift(p_shift_id,p_project_id,p_cost_code_id,p_clock_in_at,p_clock_out_at,p_break_seconds,p_note);
  v_old_note := v_shift.note;
  if v_old_note is distinct from v_description then
    update time_shifts set note=v_description where id=p_shift_id returning * into v_shift;
    insert into time_shift_edits(shift_id,edited_by,field,old_value,new_value,reason)
      values(p_shift_id,auth.uid(),'note',v_old_note,v_description,btrim(p_note));
  end if;
  return v_shift;
end;
$$;
revoke all on function public.edit_shift_with_description(uuid,uuid,uuid,timestamptz,timestamptz,int,text,text) from public, anon;
grant execute on function public.edit_shift_with_description(uuid,uuid,uuid,timestamptz,timestamptz,int,text,text) to authenticated;

-- One transaction for the entire visible week. A repeat tap never rewrites an
-- existing approval, and a stale screen cannot approve numbers it never showed.
-- Calendar boundaries are supplied by the client's existing local-Monday grid,
-- as with timecard_periods. Allow the hour gained/lost at daylight-saving time.
create or replace function public.approve_timecard_week(
  p_profile_id uuid, p_start timestamptz, p_end timestamptz, p_expected jsonb
) returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_count int; v_rows jsonb;
begin
  if not public.can_approve_timecard(p_profile_id) then
    raise exception 'Foremen may approve installer and foreman time; supervisor time requires a supervisor.';
  end if;
  if p_start is null or p_end is null or p_end-p_start not between interval '167 hours' and interval '169 hours' then
    raise exception 'Select one full week to approve.';
  end if;
  if p_expected is null or jsonb_typeof(p_expected)<>'array' then
    raise exception 'Refresh this timecard before approving.';
  end if;
  -- Serialize concurrent approvals, then snapshot locked rows. New punches
  -- arriving later remain submitted and show that another review is needed.
  perform 1 from profiles where id=p_profile_id for no key update;
  perform 1 from time_shifts where profile_id=p_profile_id and clock_in_at>=p_start
    and clock_in_at<p_end order by id for update;
  select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into v_rows from time_shifts s
    where profile_id=p_profile_id and clock_in_at>=p_start and clock_in_at<p_end and status<>'voided';
  if jsonb_array_length(v_rows)=0 then raise exception 'There are no entries in this week.'; end if;
  if exists (select 1 from jsonb_to_recordset(v_rows) as s(status text,clock_out_at timestamptz)
    where status not in ('submitted','approved') or clock_out_at is null) then
    raise exception 'Finish or correct the open, unfinished, or rejected entries before approving this week.';
  end if;
  if jsonb_array_length(p_expected)<>jsonb_array_length(v_rows)
    or (select count(distinct id) from jsonb_to_recordset(p_expected) as e(id uuid))<>jsonb_array_length(v_rows)
    or exists (
      select 1
      from jsonb_to_recordset(v_rows) as s(id uuid,project_id uuid,cost_code_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_seconds int,note text,edited_at timestamptz)
      full join jsonb_to_recordset(p_expected) as e(id uuid,project_id uuid,cost_code_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_seconds int,note text,edited_at timestamptz) on e.id=s.id
      where s.id is null or e.id is null or row(s.project_id,s.cost_code_id,s.clock_in_at,s.clock_out_at,s.break_seconds,s.note,s.edited_at)
        is distinct from row(e.project_id,e.cost_code_id,e.clock_in_at,e.clock_out_at,e.break_seconds,e.note,e.edited_at)
    ) then raise exception 'This timecard changed. Refresh it and review the week again.';
  end if;
  update time_shifts set status='approved',approved_by=auth.uid(),approved_at=now()
    where profile_id=p_profile_id and status='submitted'
      and id in (select (entry->>'id')::uuid from jsonb_array_elements(v_rows) as entry);
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;
revoke all on function public.approve_timecard_week(uuid,timestamptz,timestamptz,jsonb) from public, anon;
grant execute on function public.approve_timecard_week(uuid,timestamptz,timestamptz,jsonb) to authenticated;

-- Old clients cannot skip the new weekly review with one-punch approvals.
create or replace function public.approve_shift(p_shift_id uuid)
returns time_shifts language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  raise exception 'Open Team timecards and approve the full week for this person.';
end;
$$;
revoke all on function public.approve_shift(uuid) from public, anon;
grant execute on function public.approve_shift(uuid) to authenticated;

-- Enforce the same target-role boundary below every legacy RPC and direct
-- REST write. In particular, finish_shift_at/lead_add_shift must not let a
-- foreman change supervisor time through a different door. System jobs with
-- no user keep their existing access. This adds no new table or row grants.
create or replace function public.guard_timecard_role_boundary()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare v_target uuid; v_approval_only boolean;
begin
  if auth.uid() is null then
    if current_user in ('authenticated','anon') then raise exception 'Sign in to change time.'; end if;
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if public.is_partner_user() then raise exception 'A crew login is required.'; end if;
  if tg_op='DELETE' then
    if not _is_supervisor(auth.uid()) then raise exception 'Only supervisors may remove time.'; end if;
    return old;
  end if;
  v_target := new.profile_id;
  if tg_op='UPDATE' then
    if new.profile_id is distinct from old.profile_id then raise exception 'A punch cannot be moved to another person.'; end if;
    if (new.status='voided' or old.status='voided') and not _is_supervisor(auth.uid()) then
      raise exception 'Only supervisors may remove or restore time.';
    end if;
    v_approval_only := (to_jsonb(new)-array['status','approved_by','approved_at','rejected_by','rejected_at','reject_reason'])
      is not distinct from (to_jsonb(old)-array['status','approved_by','approved_at','rejected_by','rejected_at','reject_reason']);
    if v_approval_only and new.status in ('approved','rejected') then
      if current_user in ('authenticated','anon') or not public.can_approve_timecard(v_target) then
        raise exception 'Use weekly review to approve time.';
      end if;
      return new;
    end if;
    -- A direct REST edit cannot keep an old approval on changed hours or
    -- forge an approver. The reviewed RPCs own approval transitions.
    if current_user in ('authenticated','anon') and
      (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
        or new.status='approved') then raise exception 'Use the timecard editor to change approved time.'; end if;
  elsif new.status='approved' and current_user in ('authenticated','anon') then
    raise exception 'Use weekly review to approve time.';
  end if;
  if v_target<>auth.uid() and not public.can_edit_timecard(v_target) then
    raise exception 'Foremen may edit their own time and installers; supervisor time requires a supervisor.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_timecard_role_boundary() from public, anon, authenticated;
drop trigger if exists timecard_role_boundary on public.time_shifts;
create trigger timecard_role_boundary before insert or update or delete on public.time_shifts
for each row execute function public.guard_timecard_role_boundary();
