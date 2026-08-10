-- Team timecards: the audit trail, edit-vs-approval honesty, and overtime.
--
-- Three decisions behind this file (owner, 2026-08-10):
--   1. Foremen KEEP full timecard view + edit — the trade is that every edit
--      now leaves a permanent, per-field audit row with a required reason.
--      The old edited_by/edited_at/edited_note stamp survives as the quick
--      "adjusted" badge, but it is overwritten by each edit; the log is not.
--   2. Editing an APPROVED shift drops it back to 'submitted' and clears the
--      approval. Edited time must never ride through payroll on an approval
--      that was given to different numbers. (Same instinct as the shift
--      guard: never let a stale statement stand as a current one.)
--   3. Overtime is configurable, not hardcoded, and computed at the
--      reporting layer from these rules. Company default seeded at the
--      federal/Utah baseline: over 40h/week at 1.5x. Daily and double-time
--      thresholds exist in the shape but stay unset until someone sets them.
--
-- Deliberately NOT here: no new time-storage tables. time_shifts stays the
-- payroll truth; task_sessions stays the on/off/break interval log. The
-- installer's own "is your time correct?" answer already has a column
-- (time_shifts.time_confirmed) — the client just starts asking for real.

-- 1) Supervisor+ check, mirroring _is_lead / travel_is_supervisor -----------

create or replace function _is_supervisor(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select role in ('supervisor','owner','admin','big_boss')
       from profiles where id = p_uid),
    false
  );
$$;

revoke all on function _is_supervisor(uuid) from public;
grant execute on function _is_supervisor(uuid) to authenticated;

-- 2) Append-only edit log ---------------------------------------------------
-- One row per changed field per edit, written only by lead_edit_shift
-- (security definer), so there is no client write path to forge or trim it.

create table if not exists time_shift_edits (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references time_shifts(id) on delete cascade,
  edited_by uuid not null references profiles(id),
  field text not null,
  old_value text,
  new_value text,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists time_shift_edits_shift_idx
  on time_shift_edits (shift_id, created_at);

alter table time_shift_edits enable row level security;

-- Readable by supervisor+ only; no insert/update/delete policy at all —
-- the security-definer RPC is the single writer, and nothing ever rewrites
-- history.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'time_shift_edits' and policyname = 'supervisor read'
  ) then
    create policy "supervisor read" on time_shift_edits
      for select to authenticated using (_is_supervisor(auth.uid()));
  end if;
end;
$$;

-- 3) lead_edit_shift: required reason, per-field log, approval honesty ------
-- Same signature as 20260730230000 so every existing caller keeps working;
-- what changes is that p_note stops being optional in practice.

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
set search_path = public, pg_temp
as $$
declare
  v_old time_shifts;
  v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can edit crew time';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'an edit needs a reason note';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;

  update time_shifts
     set project_id    = coalesce(p_project_id, project_id),
         cost_code_id  = coalesce(p_cost_code_id, cost_code_id),
         clock_in_at   = coalesce(p_clock_in_at, clock_in_at),
         clock_out_at  = coalesce(p_clock_out_at, clock_out_at),
         break_seconds = coalesce(p_break_seconds, break_seconds),
         edited_note   = p_note,
         edited_by     = auth.uid(),
         edited_at     = now(),
         status        = case
                           -- An edit to an approved shift un-approves it: the
                           -- approval was given to the old numbers.
                           when status = 'approved' then 'submitted'
                           when p_clock_out_at is not null
                                and status in ('open', 'needs_finish')
                             then 'submitted'
                           else status
                         end,
         approved_by   = case when status = 'approved' then null else approved_by end,
         approved_at   = case when status = 'approved' then null else approved_at end
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

revoke all on function lead_edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text) from public;
grant execute on function lead_edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text) to authenticated;

-- 4) Overtime rules ---------------------------------------------------------
-- One company-wide row plus optional per-person overrides. The math lives in
-- the client's reporting layer (lib/overtime.ts) and the export — nothing is
-- stored per-shift, so changing a rule re-prices history honestly.

create table if not exists overtime_rules (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('company','person')),
  profile_id uuid references profiles(id) on delete cascade,
  weekly_threshold_hours numeric check (weekly_threshold_hours > 0),
  weekly_ot_multiplier numeric not null default 1.5,
  daily_threshold_hours numeric check (daily_threshold_hours > 0),
  daily_ot_multiplier numeric not null default 1.5,
  double_time_threshold_hours numeric check (double_time_threshold_hours > 0),
  double_time_multiplier numeric not null default 2.0,
  created_at timestamptz not null default now(),
  constraint overtime_scope_target check (
    (scope = 'company' and profile_id is null) or
    (scope = 'person' and profile_id is not null)
  )
);

-- Exactly one company default; at most one override per person.
create unique index if not exists overtime_rules_company_one
  on overtime_rules ((true)) where scope = 'company';
create unique index if not exists overtime_rules_person_one
  on overtime_rules (profile_id) where scope = 'person';

alter table overtime_rules enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'overtime_rules' and policyname = 'crew read'
  ) then
    create policy "crew read" on overtime_rules
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'overtime_rules' and policyname = 'supervisor write'
  ) then
    create policy "supervisor write" on overtime_rules
      for all to authenticated
      using (_is_supervisor(auth.uid()))
      with check (_is_supervisor(auth.uid()));
  end if;
end;
$$;

insert into overtime_rules (scope, weekly_threshold_hours, weekly_ot_multiplier)
select 'company', 40, 1.5
where not exists (select 1 from overtime_rules where scope = 'company');
