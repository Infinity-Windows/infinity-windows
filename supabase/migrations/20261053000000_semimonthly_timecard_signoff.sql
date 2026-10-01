-- Owner correction, 2026-10-01: Forge pay periods are not the old two-Monday
-- 14-day grid — they are local calendar 1st-to-15th and 16th-to-end-of-month.
-- timecard_periods / sign_my_timecard / countersign_timecard (T8,
-- 20260947000000) stay exactly as they are: every existing signature on that
-- table is an attestation about a real 14-day card someone actually signed,
-- and nothing here touches it. This migration adds a SEPARATE table and pair
-- of RPCs for the semimonthly card, mirroring T8's shape (same columns,
-- same security-definer self-sign/countersign split, same employee-signs-
-- first rule) with the one structural difference the new period needs: the
-- period's own end is stored, because unlike the old fixed 14-day span, a
-- semimonthly period's length varies with the month with the calendar.
--
-- period_start is the timestamptz the client sends
-- (same division of labor as T8's note: the app owns the calendar grid), but
-- "local calendar 1st/16th" is a claim the server CAN and does check here,
-- because the client also sends the timezone it means by "local" —
-- Intl.DateTimeFormat().resolvedOptions().timeZone. The guard converts
-- p_period_start into that zone's wall-clock time and requires it to land on
-- local midnight of the 1st or the 16th; the matching period_end (the 16th,
-- or the 1st of the next month, same zone) is derived server-side, not
-- trusted from the client, so there's no way to hand-pick a short or
-- overlapping end. "Never sign a running period" compares against that
-- derived end, not the client's.

create table if not exists semimonthly_timecard_periods (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  timezone text not null,
  employee_signed_at timestamptz,
  supervisor_signed_at timestamptz,
  supervisor_signed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists semimonthly_timecard_periods_profile_period
  on semimonthly_timecard_periods (profile_id, period_start);

alter table semimonthly_timecard_periods enable row level security;

do $$
begin
  -- Read: the crew member their own periods, foreman+ everyone's — same
  -- rule as timecard_periods' "own or lead read".
  if not exists (
    select 1 from pg_policies
    where tablename = 'semimonthly_timecard_periods' and policyname = 'own or lead read'
  ) then
    create policy "own or lead read" on semimonthly_timecard_periods
      for select to authenticated
      using (profile_id = auth.uid() or _is_lead(auth.uid()));
  end if;
end;
$$;
-- No insert/update/delete policy: sign_my_semimonthly_timecard and
-- countersign_semimonthly_timecard (both security definer) are the only
-- writers.

-- ----------------------------------------------- sign_my_semimonthly_timecard
-- Self-service, no note required — same attestation T8's sign_my_timecard
-- makes, just about the semimonthly card.

create or replace function sign_my_semimonthly_timecard(p_period_start timestamptz, p_timezone text)
returns semimonthly_timecard_periods
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_local timestamp;
  v_day int;
  v_period_end timestamptz;
  v_row semimonthly_timecard_periods;
begin
  if p_period_start is null then
    raise exception 'a period start is required';
  end if;
  if p_timezone is null or btrim(p_timezone) = '' then
    raise exception 'a timezone is required';
  end if;

  -- Raises on its own ("time zone ... not recognized") for a malformed zone.
  v_local := p_period_start at time zone p_timezone;
  v_day := extract(day from v_local)::int;

  if v_day not in (1, 16) or v_local::time <> time '00:00:00' then
    raise exception 'the period start must be local midnight on the 1st or the 16th';
  end if;

  v_period_end := case
    when v_day = 1
      then make_timestamp(extract(year from v_local)::int, extract(month from v_local)::int, 16, 0, 0, 0)
    else (date_trunc('month', v_local) + interval '1 month')::timestamp
  end at time zone p_timezone;

  -- Never sign a running period, from any client — including a first-half
  -- card checked on the 15th or a long second half checked on the 30th.
  if v_period_end > now() then
    raise exception 'this pay period has not ended yet';
  end if;

  insert into semimonthly_timecard_periods
    (profile_id, period_start, period_end, timezone, employee_signed_at)
  values (v_uid, p_period_start, v_period_end, p_timezone, now())
  on conflict (profile_id, period_start)
    do update set employee_signed_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function sign_my_semimonthly_timecard(timestamptz, text) from public;
grant execute on function sign_my_semimonthly_timecard(timestamptz, text) to authenticated;

-- ----------------------------------------------- countersign_semimonthly_timecard
-- Supervisor+ (same tier as T8's countersign_timecard). Requires the crew
-- member to have signed first.

create or replace function countersign_semimonthly_timecard(p_profile_id uuid, p_period_start timestamptz)
returns semimonthly_timecard_periods
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row semimonthly_timecard_periods;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can countersign a timecard';
  end if;

  select * into v_row from semimonthly_timecard_periods
    where profile_id = p_profile_id and period_start = p_period_start
    for update;
  if v_row is null or v_row.employee_signed_at is null then
    raise exception 'the crew member has not signed this period yet';
  end if;

  update semimonthly_timecard_periods
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

revoke all on function countersign_semimonthly_timecard(uuid, timestamptz) from public;
grant execute on function countersign_semimonthly_timecard(uuid, timestamptz) to authenticated;

-- Count the new signatures before deciding whether a login can be removed.
-- Preserve every existing history count from 20261030000000.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'hex_learning_reviews.author_id', (select count(*) from hex_learning_reviews where author_id = p_id),
    'hex_learning_reviews.reviewer_id', (select count(*) from hex_learning_reviews where reviewer_id = p_id),
    'hex_learning_reviews.decided_by', (select count(*) from hex_learning_reviews where decided_by = p_id),
    'hex_learning_review_events.actor_id', (select count(*) from hex_learning_review_events where actor_id = p_id),
    'hex_learning_reviews.withdrawn_by', (select count(*) from hex_learning_reviews where withdrawn_by = p_id),
    'hex_learning_deliveries.last_caller', (select count(*) from hex_learning_deliveries where last_caller = p_id),
    'hex_learning_withdrawals.last_caller', (select count(*) from hex_learning_withdrawals where last_caller = p_id),
    'ai_field_requests.profile_id', (select count(*) from ai_field_requests where profile_id = p_id),
    'ai_field_actions.profile_id', (select count(*) from ai_field_actions where profile_id = p_id),
    'daily_log_contributions.actor_id', (select count(*) from daily_log_contributions where actor_id = p_id),
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_clock_actions.profile_id',
      (select count(*) from time_clock_actions where profile_id = p_id),
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'semimonthly_timecard_periods.profile_id',
      (select count(*) from semimonthly_timecard_periods where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
