-- Team timecard: rejection, lead adjustments, and an edit audit trail on
-- time_shifts. Foreman+ (lead-level) can approve, reject, add, and edit crew
-- punches; installers still only touch their own via clock_in / clock_out.
-- Everything here is idempotent — safe to run more than once.

-- Who last touched a punch (lead adjustment) and who bounced it back.
alter table time_shifts
  add column if not exists edited_by uuid references profiles(id) on delete set null,
  add column if not exists edited_at timestamptz,
  add column if not exists rejected_by uuid references profiles(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text;

-- Allow a 'rejected' state so a lead can send a bad punch back to the crew
-- member to redo. (Original constraint only allowed open/submitted/approved.)
alter table time_shifts drop constraint if exists time_shifts_status_check;
alter table time_shifts
  add constraint time_shifts_status_check
  check (status in ('open', 'submitted', 'approved', 'rejected'));

-- Lead-level = anyone above a plain installer. Mirrors roleRank() in the app so
-- the server guard and the client nav agree on who can manage crew time. Legacy
-- role names (lead/admin/big_boss) are treated the same as their modern names.
create or replace function _is_lead(p_uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from profiles
    where id = p_uid
      and role in ('foreman', 'supervisor', 'owner', 'lead', 'admin', 'big_boss')
  );
$$;

-- Reject a submitted timecard back to the crew member with an optional reason.
create or replace function reject_shift(p_shift_id uuid, p_reason text default null)
returns time_shifts
language plpgsql
security definer
as $$
declare v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can reject time';
  end if;
  update time_shifts
     set status = 'rejected',
         rejected_by = auth.uid(),
         rejected_at = now(),
         reject_reason = p_reason,
         approved_by = null,
         approved_at = null
   where id = p_shift_id
   returning * into v_shift;
  if v_shift is null then raise exception 'no shift %', p_shift_id; end if;
  return v_shift;
end;
$$;

-- Lead adds a punch for a crew member (e.g. fixing a missed clock-in/out).
create or replace function lead_add_shift(
  p_profile_id uuid,
  p_project_id uuid,
  p_cost_code_id uuid,
  p_clock_in_at timestamptz,
  p_clock_out_at timestamptz default null,
  p_break_seconds int default 0,
  p_note text default null
)
returns time_shifts
language plpgsql
security definer
as $$
declare v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can add crew time';
  end if;
  insert into time_shifts
    (profile_id, project_id, cost_code_id, clock_in_at, clock_out_at,
     break_seconds, status, edited_by, edited_at, edited_note, signed_at)
  values
    (p_profile_id, p_project_id, p_cost_code_id, p_clock_in_at, p_clock_out_at,
     coalesce(p_break_seconds, 0),
     case when p_clock_out_at is null then 'open' else 'submitted' end,
     auth.uid(), now(), p_note,
     case when p_clock_out_at is null then null else now() end)
  returning * into v_shift;
  return v_shift;
end;
$$;

-- Lead edits / adjusts an existing punch for any crew member. Null args keep the
-- current value, so callers only send the fields they are changing.
create or replace function lead_edit_shift(
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
as $$
declare v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can edit crew time';
  end if;
  update time_shifts
     set project_id    = coalesce(p_project_id, project_id),
         cost_code_id  = coalesce(p_cost_code_id, cost_code_id),
         clock_in_at   = coalesce(p_clock_in_at, clock_in_at),
         clock_out_at  = coalesce(p_clock_out_at, clock_out_at),
         break_seconds = coalesce(p_break_seconds, break_seconds),
         edited_note   = coalesce(p_note, edited_note),
         edited_by     = auth.uid(),
         edited_at     = now(),
         status        = case
                           when p_clock_out_at is not null and status = 'open'
                             then 'submitted'
                           else status
                         end
   where id = p_shift_id
   returning * into v_shift;
  if v_shift is null then raise exception 'no shift %', p_shift_id; end if;
  return v_shift;
end;
$$;
