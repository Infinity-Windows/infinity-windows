-- Wave T, T8: pay-period sign-off, layered on top of per-punch approval
-- (Q5, settled): "worker signs their two-Monday-week card, supervisor
-- countersigns; worker sign locks worker-side changes only; supervisors
-- bypass locks." This migration builds the sign-off itself. "Worker sign
-- locks worker-side changes only" needs no enforcement here: workers have
-- no write path onto their own time_shifts rows at all (clock_in/clock_out
-- touch only the live open shift; every other change already goes through
-- edit_shift/void_shift, both supervisor+ per Q3) — so there is no
-- worker-side lock to build, only the one already-decided fact to note.
--
-- period_start is whatever timestamptz the client sends — the app's
-- existing two-Monday-week grid (lib/timeclock.ts's timecardRange("pay",
-- ...)) is anchored to LOCAL midnight in the crew member's own timezone,
-- which the server has no way to reconstruct or re-validate independently.
-- Nothing server-side has ever needed to recompute that grid (overtime,
-- the timecard views — all client-only); this keeps that same division of
-- labor rather than inventing a second, potentially-disagreeing copy of the
-- period math in SQL.

create table if not exists timecard_periods (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  period_start timestamptz not null,
  employee_signed_at timestamptz,
  supervisor_signed_at timestamptz,
  supervisor_signed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists timecard_periods_profile_period
  on timecard_periods (profile_id, period_start);

alter table timecard_periods enable row level security;

do $$
begin
  -- Read: the crew member their own periods, foreman+ everyone's (mirrors
  -- who can already see a person's shifts on the timecard pages).
  if not exists (
    select 1 from pg_policies
    where tablename = 'timecard_periods' and policyname = 'own or lead read'
  ) then
    create policy "own or lead read" on timecard_periods
      for select to authenticated
      using (profile_id = auth.uid() or _is_lead(auth.uid()));
  end if;
end;
$$;
-- No insert/update/delete policy: sign_my_timecard and countersign_timecard
-- (both security definer) are the only writers.

-- ---------------------------------------------------------- sign_my_timecard
-- Self-service, no note required — this is an attestation about your own
-- hours, not a payroll decision about someone else's.

create or replace function sign_my_timecard(p_period_start timestamptz)
returns timecard_periods
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row timecard_periods;
begin
  if p_period_start is null then
    raise exception 'a period start is required';
  end if;
  -- The card that offers this only shows once the period has ended, but a
  -- server-side guard means the RPC itself can never be talked into
  -- attesting to a period still in progress, from any client.
  if p_period_start + interval '14 days' > now() then
    raise exception 'this pay period has not ended yet';
  end if;

  insert into timecard_periods (profile_id, period_start, employee_signed_at)
  values (v_uid, p_period_start, now())
  on conflict (profile_id, period_start)
    do update set employee_signed_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function sign_my_timecard(timestamptz) from public;
grant execute on function sign_my_timecard(timestamptz) to authenticated;

-- ------------------------------------------------------ countersign_timecard
-- Supervisor+ (same tier as edit/void, Q3's spirit — this is the office
-- half of a payroll attestation). Requires the crew member to have signed
-- first (Q5: "worker signs ... supervisor countersigns" — that order).

create or replace function countersign_timecard(p_profile_id uuid, p_period_start timestamptz)
returns timecard_periods
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row timecard_periods;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can countersign a timecard';
  end if;

  select * into v_row from timecard_periods
    where profile_id = p_profile_id and period_start = p_period_start
    for update;
  if v_row is null or v_row.employee_signed_at is null then
    raise exception 'the crew member has not signed this period yet';
  end if;

  update timecard_periods
     set supervisor_signed_at = now(),
         supervisor_signed_by = auth.uid()
   where id = v_row.id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'countersign did not apply — no row was updated';
  end if;

  return v_row;
end;
$$;

revoke all on function countersign_timecard(uuid, timestamptz) from public;
grant execute on function countersign_timecard(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------- edit_shift, redefined
-- "No lock plumbing beyond: a signed period shows 'signed' and edits by
-- supervisors note 'edited after signing' on the row." edited_after_signing
-- is a one-way flag: once an edit lands on an already-signed period it
-- stays true, even if the shift is edited again later — the fact that it
-- happened once is the honest permanent record, not a status to clear.
-- Identical to T2's edit_shift, plus this one check; see that migration
-- for the rest of the reasoning (Q3 gate, Q4 self-reapprove).

alter table time_shifts add column if not exists edited_after_signing boolean not null default false;

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
  v_could_approve boolean;
  v_signed boolean;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can edit crew time';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'an edit needs a reason note';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;

  v_could_approve := _is_lead(auth.uid());
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
                           when v_old.status = 'approved' and v_could_approve
                             then 'approved'
                           when v_old.status = 'approved'
                             then 'submitted'
                           when p_clock_out_at is not null
                                and v_old.status in ('open', 'needs_finish')
                             then 'submitted'
                           else v_old.status
                         end,
         approved_by   = case
                           when v_old.status = 'approved' and v_could_approve
                             then auth.uid()
                           when v_old.status = 'approved'
                             then null
                           else approved_by
                         end,
         approved_at   = case
                           when v_old.status = 'approved' and v_could_approve
                             then now()
                           when v_old.status = 'approved'
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
