-- Probe for 20261055000000_semimonthly_timecard_signoff.sql: the new
-- sign_my_semimonthly_timecard / countersign_semimonthly_timecard RPCs,
-- called on the real database as the QA installer and a real supervisor on
-- the practice job, and rolled back.
--
-- Scenarios:
--   * an ended first-half period (Aug 1-16, local midnight both ends)
--     signs for the installer;
--   * an ended 16-day second half (Aug 16-Sep 1) is left UNSIGNED, to prove
--     countersign refuses before the employee signs;
--   * the CURRENT first half (Oct 1-16) is refused as still running —
--     "today" is inside it, same as checking on day 15;
--   * the CURRENT long second half (Oct 16-Nov 1, 16 days because October
--     has 31) is refused as still running too — the day-30 case;
--   * null period start, a malformed timezone, a mid-period start (Sep 5)
--     and a non-midnight start (Sep 1 08:00) are all refused;
--   * countersign: supervisor-only (installer refused), employee-first
--     (unsigned period refused), then the real countersign succeeds;
--   * RLS: the installer cannot read the supervisor's own signed row, the
--     supervisor (lead) can read the installer's;
--   * the legacy timecard_periods table and sign_my_timecard are untouched
--     by any of this.
-- Run: gh workflow run db-dry-run.yml -f ref=codex/semimonthly-pay-periods \
--        -f migrations="supabase/migrations/20261055000000_semimonthly_timecard_signoff.sql" \
--        -f probe=scripts/dry-run-probes/semimonthly-timecard-signoff.sql
do $$
declare
  v_installer uuid;
  v_supervisor uuid;
  v_tz text := 'America/Denver';
  v_ended_first timestamptz;   -- Aug 1 2026, local midnight: fully ended
  v_ended_second timestamptz;  -- Aug 16 2026, local midnight: fully ended, left unsigned
  v_running_first timestamptz; -- Oct 1 2026: today is inside this period
  v_running_long_second timestamptz; -- Oct 16 2026: 16-day second half, still running
  v_mid_period timestamptz;    -- Sep 5 2026: not the 1st or the 16th
  v_non_midnight timestamptz;  -- Sep 1 2026 08:00 local
  v_row public.semimonthly_timecard_periods;
  v_sup_row public.semimonthly_timecard_periods;
  v_n int;
  v_legacy_before int;
  v_legacy_after int;
begin
  -- ---- setup, as the system -------------------------------------------------
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  -- Production has an owner and no supervisor-role profile. The owner
  -- exercises the same supervisor-plus permission tier, inside rollback.
  v_supervisor := pg_temp.dry_run_pick('owner');

  v_ended_first          := '2026-08-01 00:00:00'::timestamp at time zone v_tz;
  v_ended_second         := '2026-08-16 00:00:00'::timestamp at time zone v_tz;
  v_running_first        := '2026-10-01 00:00:00'::timestamp at time zone v_tz;
  v_running_long_second  := '2026-10-16 00:00:00'::timestamp at time zone v_tz;
  v_mid_period           := '2026-09-05 00:00:00'::timestamp at time zone v_tz;
  v_non_midnight         := '2026-09-01 08:00:00'::timestamp at time zone v_tz;

  select count(*) into v_legacy_before from public.timecard_periods;

  -- ---- sign: ended periods succeed -------------------------------------
  perform pg_temp.dry_run_act_as(v_installer);

  v_row := public.sign_my_semimonthly_timecard(v_ended_first, v_tz);
  perform pg_temp.dry_run_check('ended first half (Aug 1-16): signs',
    v_row.employee_signed_at is not null
      and v_row.period_end = ('2026-08-16 00:00:00'::timestamp at time zone v_tz)
      and v_row.timezone = v_tz,
    'period_end ' || v_row.period_end::text);

  -- ---- sign: refused cases -----------------------------------------------
  perform pg_temp.dry_run_expect_error('null period start is refused',
    'select public.sign_my_semimonthly_timecard(null, ''America/Denver'')',
    'period start is required');

  perform pg_temp.dry_run_expect_error('malformed timezone is refused',
    format('select public.sign_my_semimonthly_timecard(%L::timestamptz, %L)', v_ended_first, 'Not/AZone'),
    '');

  perform pg_temp.dry_run_expect_error('mid-period start (Sep 5) is refused',
    format('select public.sign_my_semimonthly_timecard(%L::timestamptz, %L)', v_mid_period, v_tz),
    '1st or the 16th');

  perform pg_temp.dry_run_expect_error('non-midnight start (Sep 1 08:00) is refused',
    format('select public.sign_my_semimonthly_timecard(%L::timestamptz, %L)', v_non_midnight, v_tz),
    '1st or the 16th');

  perform pg_temp.dry_run_expect_error('running first half (Oct 1-16, today inside it) is refused',
    format('select public.sign_my_semimonthly_timecard(%L::timestamptz, %L)', v_running_first, v_tz),
    'has not ended yet');

  perform pg_temp.dry_run_expect_error('running long second half (Oct 16-Nov 1) is refused',
    format('select public.sign_my_semimonthly_timecard(%L::timestamptz, %L)', v_running_long_second, v_tz),
    'has not ended yet');

  -- ---- countersign: supervisor-only --------------------------------------
  perform pg_temp.dry_run_expect_error('installer cannot countersign',
    format('select public.countersign_semimonthly_timecard(%L::uuid, %L::timestamptz)', v_installer, v_ended_first),
    'supervisor');

  -- ---- countersign: employee-first ---------------------------------------
  perform pg_temp.dry_run_act_as(v_supervisor);

  perform pg_temp.dry_run_expect_error('countersign refused before the employee signs',
    format('select public.countersign_semimonthly_timecard(%L::uuid, %L::timestamptz)', v_installer, v_ended_second),
    'has not signed');

  -- Every month-length branch, including leap February and DST, derives
  -- the next month's boundary instead of adding a fixed number of days.
  perform pg_temp.dry_run_act_as(v_installer);
  v_row := public.sign_my_semimonthly_timecard(v_ended_second, v_tz);
  perform pg_temp.dry_run_check('ended long second half derives September 1',
    v_row.period_end = ('2026-09-01 00:00:00'::timestamp at time zone v_tz), v_row.period_end::text);
  v_row := public.sign_my_semimonthly_timecard('2024-02-16 00:00:00'::timestamp at time zone v_tz, v_tz);
  perform pg_temp.dry_run_check('leap February second half ends March 1',
    v_row.period_end = ('2024-03-01 00:00:00'::timestamp at time zone v_tz), v_row.period_end::text);
  v_row := public.sign_my_semimonthly_timecard('2026-02-16 00:00:00'::timestamp at time zone v_tz, v_tz);
  perform pg_temp.dry_run_check('ordinary February second half ends March 1',
    v_row.period_end = ('2026-03-01 00:00:00'::timestamp at time zone v_tz), v_row.period_end::text);
  v_row := public.sign_my_semimonthly_timecard('2026-03-01 00:00:00'::timestamp at time zone v_tz, v_tz);
  perform pg_temp.dry_run_check('DST first half still ends at local midnight March 16',
    v_row.period_end = ('2026-03-16 00:00:00'::timestamp at time zone v_tz), v_row.period_end::text);
  perform pg_temp.dry_run_act_as(v_supervisor);

  -- ---- countersign: the real one succeeds --------------------------------
  v_row := public.countersign_semimonthly_timecard(v_installer, v_ended_first);
  perform pg_temp.dry_run_check('supervisor countersigns the signed period',
    v_row.supervisor_signed_at is not null and v_row.supervisor_signed_by = v_supervisor,
    'supervisor_signed_by ' || coalesce(v_row.supervisor_signed_by::text, 'null'));

  -- ---- RLS: self-only, foreman+ sees everyone's --------------------------
  v_sup_row := public.sign_my_semimonthly_timecard(v_ended_first, v_tz);

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.semimonthly_timecard_periods
    where profile_id = v_supervisor and period_start = v_ended_first;
  perform pg_temp.dry_run_check('installer cannot read the supervisor''s own row',
    v_n = 0, v_n || ' row(s)');

  perform pg_temp.dry_run_act_as(v_supervisor);
  select count(*) into v_n from public.semimonthly_timecard_periods
    where profile_id = v_installer and period_start = v_ended_first;
  perform pg_temp.dry_run_check('supervisor (lead) can read the installer''s row',
    v_n = 1, v_n || ' row(s)');

  perform pg_temp.dry_run_expect_error('direct table inserts cannot bypass self-signing',
    format('insert into public.semimonthly_timecard_periods(profile_id, period_start, period_end, timezone) values (%L::uuid, %L::timestamptz, %L::timestamptz, %L)',
      v_installer, v_ended_first, v_ended_second, v_tz), 'permission denied');

  -- Temporarily turn the QA login into a partner inside this rollback-only
  -- probe, to prove even a self row and the SECURITY DEFINER RPC stay fenced.
  perform pg_temp.dry_run_as_system();
  update public.profiles set is_partner = true where id = v_installer;
  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.semimonthly_timecard_periods where profile_id = v_installer;
  perform pg_temp.dry_run_check('partner cannot read their own internal timecard signature', v_n = 0, v_n || ' rows');
  perform pg_temp.dry_run_expect_error('partner cannot self-sign an internal timecard',
    format('select public.sign_my_semimonthly_timecard(%L::timestamptz, %L)', v_ended_first, v_tz), 'active crew login');
  perform pg_temp.dry_run_as_system();
  update public.profiles set is_partner = false where id = v_installer;

  -- ---- the legacy table and its RPC are untouched ------------------------
  perform pg_temp.dry_run_as_system();
  select count(*) into v_legacy_after from public.timecard_periods;
  perform pg_temp.dry_run_check('legacy timecard_periods row count is unchanged',
    v_legacy_after = v_legacy_before,
    v_legacy_before || ' before, ' || v_legacy_after || ' after');

  perform pg_temp.dry_run_check('account removal counts the new signed timecard',
    (public.person_record_counts(v_installer)->>'semimonthly_timecard_periods.profile_id')::int > 0,
    'signature included in work history');
  perform pg_temp.dry_run_check('sign_my_timecard still exists',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'sign_my_timecard'
    ),
    'present');
end $$;
