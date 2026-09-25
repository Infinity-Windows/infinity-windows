-- Probe for PR #640 (branch claude/r0-clock-integrity): the keyed clock RPCs
-- of 20261028000000_clock_integrity.sql, called on the real database as the
-- QA installer login on the practice job, and rolled back. Each scenario is
-- one the phone will produce on one bar of signal:
--   * the same clock-in client id twice makes ONE shift;
--   * clock_out twice under one id leaves clock_out_at, break total and
--     status where the first left them, and a new id after the close is
--     refused;
--   * end_break with no running break is an outcome, not a silent success:
--     'no_break_running', review_reason on the shift, one audit line, and a
--     replay answers the same without a second line;
--   * the tap-time rule: a trusted tap pays from the tap (skew-corrected), a
--     phone 5 minutes off pays from arrival and is marked 'clock_off';
--   * the ledger is unreadable to the login that wrote it;
--   * person_record_counts still carries every key master has, plus the
--     ledger's;
--   * the timeline (Codex review of #640, 2026-09-24; second block): a
--     clock-in tapped inside an approved shift starts at arrival, marked
--     'overlaps_previous_shift', with the tap kept in the ledger; a clock-out
--     or a second break tapped before a lunch that already ended pays from
--     arrival, deducts the lunch once and is marked 'tap_out_of_order'; a
--     lunch taken through the LEGACY signatures bounds a keyed clock-out too.
-- The caller is qa.installer and nobody else: the database fences that login
-- to the sandbox jobs, so even a rollback that failed could have punched no
-- real person's clock. The run stops loudly if that login is missing or is
-- not flagged as a test profile. Job codes and qa.* logins only in the
-- output; the repository and its logs are public.
-- Run: gh workflow run db-dry-run.yml -f ref=claude/r0-clock-integrity \
--        -f migrations="supabase/migrations/20261028000000_clock_integrity.sql supabase/migrations/20261028010000_clock_integrity_note.sql" \
--        -f probe=scripts/dry-run-probes/pr-640-clock-integrity.sql
do $$
declare
  v_who uuid;
  v_job uuid;
  v_job_code text;
  v_cost_code uuid;
  v_role text;
  v_shift public.time_shifts;
  v_again public.time_shifts;
  v_out public.time_shifts;
  v_replay public.time_shifts;
  v_break_shift public.time_shifts;
  v_trusted public.time_shifts;
  v_untrusted public.time_shifts;
  v_r jsonb;
  v_n int;
  v_ledger record;
  v_id_in uuid := gen_random_uuid();
  v_id_out uuid := gen_random_uuid();
  v_id_out_new uuid := gen_random_uuid();
  v_id_in2 uuid := gen_random_uuid();
  v_id_end uuid := gen_random_uuid();
  v_id_out2 uuid := gen_random_uuid();
  v_id_in3 uuid := gen_random_uuid();
  v_id_out3 uuid := gen_random_uuid();
  v_id_in4 uuid := gen_random_uuid();
begin
  -- ---- setup, as the system -------------------------------------------------
  perform pg_temp.dry_run_as_system();
  -- The QA installer, by its login, and nobody else. Stop rather than fall
  -- back to a real person: the whole point of this caller is the fence.
  select u.id into v_who from auth.users u where u.email = 'qa.installer@crew.infinitywindows.app';
  if v_who is null then
    raise exception 'dry run: there is no qa.installer login to act as. Provision it (docs/test-account.md) and run again.';
  end if;
  if not public.is_test_profile(v_who) then
    raise exception 'dry run: the qa.installer login is not flagged as a test profile. Stopping rather than punch a clock as a real person.';
  end if;
  select p.role into v_role from public.profiles p where p.id = v_who;
  if v_role is distinct from 'installer' then
    raise exception 'dry run: the qa.installer login has the role %, not installer.', coalesce(v_role, 'none');
  end if;
  -- The practice job: on the sandbox list AND flagged as testing, so the QA
  -- login's fence and the job's own flag agree (MADMOOSE when this was written).
  select p.id, p.job_code into v_job, v_job_code
    from public.sandbox_projects s join public.projects p on p.id = s.project_id
   where p.deleted_at is null and coalesce(p.is_test, false)
   order by p.job_code
   limit 1;
  if v_job is null then
    raise exception 'dry run: no job is both flagged as testing and on the sandbox list, so the QA login has nowhere to punch. Mark a practice job as testing in the app and run again.';
  end if;
  select id into v_cost_code from public.cost_codes order by active desc, code limit 1;
  -- clock_in refuses anyone without today's toolbox talk.
  insert into public.toolbox_completions (profile_id, signed_at) values (v_who, now());
  -- A clean timeline for the run, all of it rolled back: a shift this login
  -- left open would make the first clock-in start "at arrival"
  -- (previous_shift_open), and since the timeline guard a trusted tap two
  -- hours old cannot follow a shift the same person closed today — this login
  -- is shared by every test run there is, so its recent punches are voided
  -- the way a supervisor would void a mistaken one.
  update public.time_shifts set clock_out_at = now(), status = 'submitted'
   where profile_id = v_who and status = 'open' and clock_out_at is null;
  get diagnostics v_n = row_count;
  update public.time_shifts
     set status = 'voided', voided_at = now(), voided_by = v_who,
         voided_reason = 'database practice run: cleared for a clean timeline (rolled back)'
   where profile_id = v_who and status <> 'voided'
     and greatest(clock_in_at, clock_out_at) > now() - interval '1 day';
  perform pg_temp.dry_run_check('setup: acting on the practice job as the QA installer login; its open shifts closed first',
    v_job is not null, v_job_code || ', ' || v_n || ' open shift(s) closed for the run');
  perform pg_temp.dry_run_check('schema: time_clock_actions exists, time_shifts.review_reason and time_shifts.last_punch_at exist',
    to_regclass('public.time_clock_actions') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'time_shifts' and column_name = 'review_reason')
    and exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'time_shifts' and column_name = 'last_punch_at'),
    null);

  -- ---- K0.2: the same clock-in id twice is one shift ----------------------------
  v_role := pg_temp.dry_run_act_as(v_who);
  perform pg_temp.dry_run_check('acting as an installer', v_role = 'installer' and current_user = 'authenticated', v_role);
  v_shift := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'dry run', p_mode => 'data', p_client_id => v_id_in,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('clock_in: keyed overload makes a shift on the practice job in data mode',
    v_shift.id is not null and v_shift.project_id = v_job and v_shift.job_mode = 'data' and v_shift.client_id = v_id_in,
    'shift ' || v_shift.id);
  perform pg_temp.dry_run_check('clock_in: no tap sent means arrival time and no review mark, and the clock-in is the last punch',
    v_shift.review_reason is null and v_shift.clock_in_at = now() and v_shift.last_punch_at = now(), coalesce(v_shift.review_reason, 'null'));
  v_again := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'different words, same tap', p_mode => 'data', p_client_id => v_id_in,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('clock_in: the same client id again answers with the original shift, unchanged',
    v_again.id = v_shift.id and v_again.note = 'dry run', 'shift ' || v_again.id || ' note "' || coalesce(v_again.note, '') || '"');
  perform pg_temp.dry_run_expect_error('ledger: the login that wrote it cannot read time_clock_actions',
    'select count(*) from public.time_clock_actions', 'permission denied');

  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.time_shifts where profile_id = v_who and client_id = v_id_in;
  perform pg_temp.dry_run_check('clock_in: one time_shifts row carries the id, not two', v_n = 1, v_n || ' row(s)');
  select * into v_ledger from public.time_clock_actions where client_id = v_id_in;
  perform pg_temp.dry_run_check('ledger: one clock_in row, outcome clocked_in, no tap used',
    v_ledger.action = 'clock_in' and v_ledger.outcome = 'clocked_in' and v_ledger.used_tap_time = false,
    coalesce(v_ledger.outcome, 'no row'));

  -- ---- K0.2: clock_out twice — time and status stay put ---------------------------
  perform pg_temp.dry_run_act_as(v_who);
  v_out := public.clock_out(p_shift_id => v_shift.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => 600, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => v_id_out,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('clock_out: the first close submits the shift with the break total sent',
    v_out.status = 'submitted' and v_out.clock_out_at is not null and v_out.break_seconds = 600,
    v_out.status || ' / ' || v_out.break_seconds || ' s');
  v_replay := public.clock_out(p_shift_id => v_shift.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => 9999, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => v_id_out,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('clock_out: the same id again moves nothing (clock_out_at, break total, status)',
    v_replay.clock_out_at = v_out.clock_out_at and v_replay.break_seconds = 600 and v_replay.status = 'submitted',
    v_replay.break_seconds || ' s, ' || v_replay.status);
  perform pg_temp.dry_run_expect_error('clock_out: a second close under a NEW id is refused',
    format('select public.clock_out(p_shift_id => %L::uuid, p_photo => null, p_injured => false, p_time_confirmed => true, '
           'p_break_seconds => 0, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => %L::uuid)',
           v_shift.id, v_id_out_new),
    'already clocked out');
  perform pg_temp.dry_run_expect_error('clock_out: the legacy signature refuses a second close too',
    format('select public.clock_out(%L::uuid, null, false, true, 0, null, null, null)', v_shift.id),
    'already clocked out');

  perform pg_temp.dry_run_as_system();
  select * into v_out from public.time_shifts where id = v_shift.id;
  perform pg_temp.dry_run_check('clock_out: after every resend the row still says submitted with the first total',
    v_out.status = 'submitted' and v_out.break_seconds = 600 and v_out.clock_out_at = v_replay.clock_out_at,
    v_out.status || ' / ' || v_out.break_seconds || ' s');
  select count(*) into v_n from public.time_clock_actions where client_id = v_id_out_new;
  perform pg_temp.dry_run_check('ledger: a refused close leaves no ledger row', v_n = 0, v_n || ' row(s)');

  -- ---- K0.4: a break end with no running break -------------------------------------
  perform pg_temp.dry_run_act_as(v_who);
  v_break_shift := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'dry run 2', p_mode => 'data', p_client_id => v_id_in2,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  v_r := public.end_break(p_shift_id => v_break_shift.id, p_client_id => v_id_end,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('end_break: no running break is the outcome no_break_running, with the shift marked',
    v_r->>'outcome' = 'no_break_running' and v_r->'shift'->>'review_reason' = 'break_end_without_break',
    coalesce(v_r->>'outcome', 'null') || ' / ' || coalesce(v_r->'shift'->>'review_reason', 'null'));
  v_r := public.end_break(p_shift_id => v_break_shift.id, p_client_id => v_id_end,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('end_break: a replay of the refused id answers the same way',
    v_r->>'outcome' = 'no_break_running', coalesce(v_r->>'outcome', 'null'));
  perform pg_temp.dry_run_expect_error('end_break: the legacy signature refuses out loud',
    format('select public.end_break(%L::uuid)', v_break_shift.id), 'find the start of that break');

  perform pg_temp.dry_run_as_system();
  select * into v_out from public.time_shifts where id = v_break_shift.id;
  perform pg_temp.dry_run_check('end_break: the shift stayed open, nothing added to the break total',
    v_out.status = 'open' and v_out.break_seconds = 0 and v_out.break_started_at is null and v_out.review_reason = 'break_end_without_break',
    v_out.status || ' / ' || v_out.break_seconds || ' s / ' || coalesce(v_out.review_reason, 'null'));
  select count(*) into v_n from public.time_shift_edits where shift_id = v_break_shift.id and field = 'review_reason';
  perform pg_temp.dry_run_check('end_break: exactly one audit line, even after the replay', v_n = 1, v_n || ' line(s)');
  select count(*) into v_n from public.time_clock_actions where shift_id = v_break_shift.id;
  perform pg_temp.dry_run_check('ledger: one row per client id on that shift (clock_in + break_end)', v_n = 2, v_n || ' row(s)');

  -- ---- K0.5: the tap-time rule ----------------------------------------------------------
  perform pg_temp.dry_run_act_as(v_who);
  v_out := public.clock_out(p_shift_id => v_break_shift.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => 0, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => v_id_out2,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  -- The shifts above all ended at arrival, and now() is one instant for the
  -- whole run: a trusted tap two hours old would fall inside them. Void them
  -- (rolled back) so the tap-time rule is judged on its own.
  perform pg_temp.dry_run_as_system();
  update public.time_shifts
     set status = 'voided', voided_at = now(), voided_by = v_who,
         voided_reason = 'database practice run: cleared for a clean timeline (rolled back)'
   where profile_id = v_who and status <> 'voided'
     and greatest(clock_in_at, clock_out_at) > now() - interval '1 day';
  perform pg_temp.dry_run_act_as(v_who);
  -- (a) trusted: checked an hour ago, 30 s fast, tapped two hours before arrival.
  v_trusted := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'dry run 3', p_mode => 'data', p_client_id => v_id_in3,
    p_tapped_at => now() - interval '2 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 30000);
  perform pg_temp.dry_run_check('tap time: a trusted tap pays from the tap, corrected by the measured 30 s, no mark',
    v_trusted.review_reason is null
    and abs(extract(epoch from (v_trusted.clock_in_at - (now() - interval '2 hours' - interval '30 seconds')))) < 1,
    coalesce(v_trusted.review_reason, 'no mark') || ', clock_in_at is ' || round(extract(epoch from (now() - v_trusted.clock_in_at))) || ' s before arrival');
  v_out := public.clock_out(p_shift_id => v_trusted.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => 0, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => v_id_out3,
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  -- (b) rejected: the phone was 5 minutes off at its check.
  v_untrusted := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'dry run 4', p_mode => 'data', p_client_id => v_id_in4,
    p_tapped_at => now() - interval '2 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 300000);
  perform pg_temp.dry_run_check('tap time: a phone more than 2 minutes off pays from arrival and is marked clock_off',
    v_untrusted.review_reason = 'clock_off' and v_untrusted.clock_in_at = now(),
    coalesce(v_untrusted.review_reason, 'no mark'));

  perform pg_temp.dry_run_as_system();
  select * into v_ledger from public.time_clock_actions where client_id = v_id_in3;
  perform pg_temp.dry_run_check('ledger: the trusted punch keeps the tap, the arrival and used_tap_time = true',
    v_ledger.used_tap_time = true and v_ledger.tapped_at is not null and v_ledger.arrived_at = now(),
    coalesce(v_ledger.used_tap_time::text, 'no row'));
  select * into v_ledger from public.time_clock_actions where client_id = v_id_in4;
  perform pg_temp.dry_run_check('ledger: the rejected punch says used_tap_time = false and why',
    v_ledger.used_tap_time = false and v_ledger.review_reason = 'clock_off',
    coalesce(v_ledger.review_reason, 'no row'));
  select count(*) into v_n from public.time_shift_edits
   where shift_id = v_untrusted.id and field = 'review_reason' and reason like '%more than 2 minutes off%';
  perform pg_temp.dry_run_check('tap time: the audit line explains which rule failed in plain words', v_n = 1, v_n || ' line(s)');
  select count(*) into v_n from public.time_shifts
   where profile_id = v_who and clock_out_at is not null and clock_out_at < clock_in_at;
  perform pg_temp.dry_run_check('no shift written by this run ends before it starts', v_n = 0, v_n || ' bad row(s)');

  -- ---- person_record_counts: every key master has, plus the ledger's ------------------
  v_r := public.person_record_counts(v_who);
  select count(*) into v_n from unnest(array[
    'ai_field_actions.profile_id','ai_field_requests.profile_id','ask_question_log.asker_id','capability_badges.installer_id',
    'certifications.profile_id','crew_reminders.profile_id','crew_work_record_people.profile_id','crew_work_records.filed_by',
    'custom_work_commands.profile_id','custom_work_history.actor_id','custom_work_sessions.profile_id','custom_work_units.created_by',
    'daily_logs.filed_by','education_credits.profile_id','flash_run_assignments.assigned_by','flash_run_assignments.profile_id',
    'hex_learning_deliveries.last_caller','hex_learning_review_events.actor_id','hex_learning_reviews.author_id',
    'hex_learning_reviews.decided_by','hex_learning_reviews.reviewer_id','hex_learning_reviews.withdrawn_by',
    'hex_learning_withdrawals.last_caller','hex_portal_cases.asker_id','hex_portal_guidance_receipts.actor_id',
    'hex_portal_outcomes.actor_id','install_events.credited_to','install_events.installer_id','installer_clearance.installer_id',
    'learn_progress.profile_id','learning_video_quiz_attempts.profile_id','opening_phases.started_by','opening_phases.submitted_by',
    'overtime_rules.profile_id','pay_rates.profile_id','points_ledger.profile_id','project_messages.author_id','receipts.uploaded_by',
    'safety_acks.profile_id','schedule_assignment_members.profile_id','service_audit.actor_id','service_commands.profile_id',
    'service_media.created_by','service_time_sessions.profile_id','service_visit_units.created_by','service_visits.created_by',
    'summon_declines.profile_id','summon_helpers.profile_id','summons.requested_by','task_sessions.profile_id',
    'time_off_requests.profile_id','time_shift_edits.edited_by','time_shifts.profile_id','timecard_periods.profile_id',
    'toolbox_completions.profile_id','trip_crew.profile_id','unit_redos.pressed_by','unit_sessions.profile_id',
    'vehicle_drivers.profile_id','workflow_notice_outbox.profile_id','workflow_plan_revisions.actor','workflow_plans.created_by',
    'time_clock_actions.profile_id']) k where not (v_r ? k);
  perform pg_temp.dry_run_check('person_record_counts: keeps every key master has (learning references included) plus time_clock_actions',
    v_n = 0, v_n || ' key(s) missing');
  perform pg_temp.dry_run_check('person_record_counts: counts the ledger rows this run wrote',
    (v_r->>'time_clock_actions.profile_id')::int >= 5, coalesce(v_r->>'time_clock_actions.profile_id', 'null') || ' ledger row(s)');
end $$;

-- ---- The timeline (Codex review of #640, 2026-09-24) ---------------------------------
-- now() is one instant for the whole batch, so every arrival below is the same
-- moment and every tap is an exact offset from it: the checks compare to the
-- second, not within a tolerance. Between scenarios the QA login's fresh
-- shifts are voided (rolled back with everything else) so each starts from a
-- clean timeline, the way the scenarios happen to real people on real days.
do $$
declare
  v_who uuid;
  v_job uuid;
  v_job_code text;
  v_cost_code uuid;
  v_xid text;
  v_n int;
  v_first public.time_shifts;
  v_late public.time_shifts;
  v_out public.time_shifts;
  v_s public.time_shifts;
  v_b public.time_shifts;
  v_r jsonb;
  v_ledger record;
  v_reason text;
  v_id_late uuid := gen_random_uuid();
begin
  -- ---- setup, as the system: the same login and job as the block above ---------------
  perform pg_temp.dry_run_as_system();
  v_xid := (txid_current() % 4294967296)::text;
  select u.id into v_who from auth.users u where u.email = 'qa.installer@crew.infinitywindows.app';
  if v_who is null or not public.is_test_profile(v_who) then
    raise exception 'dry run: the qa.installer login is missing or is not flagged as a test profile. Stopping rather than punch a clock as a real person.';
  end if;
  select p.id, p.job_code into v_job, v_job_code
    from public.sandbox_projects s join public.projects p on p.id = s.project_id
   where p.deleted_at is null and coalesce(p.is_test, false)
   order by p.job_code
   limit 1;
  if v_job is null then
    raise exception 'dry run: no job is both flagged as testing and on the sandbox list.';
  end if;
  select id into v_cost_code from public.cost_codes order by active desc, code limit 1;
  if not exists (select 1 from public.toolbox_completions where profile_id = v_who
                  and (signed_at at time zone 'America/Denver')::date = (now() at time zone 'America/Denver')::date) then
    insert into public.toolbox_completions (profile_id, signed_at) values (v_who, now());
  end if;
  update public.time_shifts set clock_out_at = now(), status = 'submitted'
   where profile_id = v_who and status = 'open' and clock_out_at is null;
  update public.time_shifts
     set status = 'voided', voided_at = now(), voided_by = v_who,
         voided_reason = 'database practice run: cleared for a clean timeline (rolled back)'
   where profile_id = v_who and status <> 'voided'
     and greatest(clock_in_at, clock_out_at) > now() - interval '1 day';
  perform pg_temp.dry_run_check('timeline: setup on the practice job as the QA installer login', v_job is not null, v_job_code);

  -- ---- 1. A clock-in tapped inside an approved shift -----------------------------------
  -- The stale device: another phone or the office closed the day (3 h ago to
  -- 2 h ago, approved), and this phone's clock-in tapped at 2 h 30 min ago
  -- arrives now. Before the fix it started a second shift at that tap, unmarked.
  perform pg_temp.dry_run_act_as(v_who);
  v_first := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'timeline 1', p_mode => 'data', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '3 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: on a clean timeline a trusted clock-in pays from its tap, unmarked, and is the last punch',
    v_first.review_reason is null and v_first.clock_in_at = now() - interval '3 hours' and v_first.last_punch_at = v_first.clock_in_at,
    coalesce(v_first.review_reason, 'no mark'));
  v_out := public.clock_out(p_shift_id => v_first.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => 0, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '2 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: its trusted clock-out ends it at its tap, unmarked',
    v_out.review_reason is null and v_out.clock_out_at = now() - interval '2 hours' and v_out.status = 'submitted'
    and v_out.last_punch_at = v_out.clock_out_at,
    coalesce(v_out.review_reason, 'no mark') || ' / ' || v_out.status);
  perform pg_temp.dry_run_as_system();
  update public.time_shifts set status = 'approved', approved_at = now() where id = v_first.id;
  perform pg_temp.dry_run_act_as(v_who);
  v_late := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'timeline 1, stale phone', p_mode => 'data', p_client_id => v_id_late,
    p_tapped_at => now() - interval '150 minutes', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: a clock-in tapped inside the approved shift starts at arrival and is marked overlaps_previous_shift',
    v_late.clock_in_at = now() and v_late.review_reason = 'overlaps_previous_shift',
    coalesce(v_late.review_reason, 'no mark') || ', starts ' || round(extract(epoch from (now() - v_late.clock_in_at))) || ' s before arrival');
  perform pg_temp.dry_run_check('timeline: so the two shifts do not overlap', v_late.clock_in_at >= v_out.clock_out_at, null);
  v_out := public.clock_out(p_shift_id => v_late.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => 0, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => gen_random_uuid(),
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);

  perform pg_temp.dry_run_as_system();
  select * into v_ledger from public.time_clock_actions where client_id = v_id_late;
  perform pg_temp.dry_run_check('ledger: the tap the phone claimed is kept for the review, and pay did not use it',
    v_ledger.used_tap_time = false and v_ledger.tapped_at = now() - interval '150 minutes'
    and v_ledger.review_reason = 'overlaps_previous_shift',
    coalesce(v_ledger.review_reason, 'no row'));
  select reason into v_reason from public.time_shift_edits
   where shift_id = v_late.id and field = 'review_reason' order by created_at limit 1;
  perform pg_temp.dry_run_check('timeline: the audit line names the end the tap fell before and what the phone said',
    v_reason like '%before the previous shift ended (%' and v_reason like '%The phone said %',
    coalesce(left(v_reason, 140), 'no line'));
  select * into v_first from public.time_shifts where id = v_first.id;
  perform pg_temp.dry_run_check('timeline: the approved shift was not touched',
    v_first.status = 'approved' and v_first.clock_out_at = now() - interval '2 hours', v_first.status);

  -- ---- 2. A clock-out tapped before the lunch ended ------------------------------------
  -- clock-in 3 h ago, lunch 2 h ago to 90 min ago, and a clock-out tapped
  -- 100 min ago arrives now. Before the fix the shift ended ten minutes before
  -- its own lunch did, kept the full 1,800 s deduction, and was not marked.
  update public.time_shifts
     set status = 'voided', voided_at = now(), voided_by = v_who,
         voided_reason = 'database practice run: cleared for a clean timeline (rolled back)'
   where profile_id = v_who and status <> 'voided'
     and greatest(clock_in_at, clock_out_at) > now() - interval '1 day';
  perform pg_temp.dry_run_act_as(v_who);
  v_s := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'timeline 2', p_mode => 'data', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '3 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  v_b := public.start_break(p_shift_id => v_s.id, p_break_type => 'lunch', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '2 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  v_r := public.end_break(p_shift_id => v_s.id, p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '90 minutes', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: a trusted lunch is 1,800 s tap to tap, and the shift remembers when it ended',
    v_r->>'outcome' = 'ended' and (v_r->'shift'->>'break_seconds')::int = 1800
    and (v_r->'shift'->>'last_punch_at')::timestamptz = now() - interval '90 minutes'
    and v_r->'shift'->>'break_started_at' is null,
    coalesce(v_r->>'outcome', 'null') || ' / ' || coalesce(v_r->'shift'->>'break_seconds', 'null') || ' s');
  v_out := public.clock_out(p_shift_id => v_s.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => null, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '100 minutes', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: a clock-out tapped before the lunch ended pays from arrival, is marked tap_out_of_order, and deducts the lunch once',
    v_out.clock_out_at = now() and v_out.review_reason = 'tap_out_of_order' and v_out.break_seconds = 1800,
    coalesce(v_out.review_reason, 'no mark') || ' / ' || v_out.break_seconds || ' s / ends ' || round(extract(epoch from (now() - v_out.clock_out_at))) || ' s before arrival');
  perform pg_temp.dry_run_as_system();
  select reason into v_reason from public.time_shift_edits
   where shift_id = v_s.id and field = 'review_reason' order by created_at limit 1;
  perform pg_temp.dry_run_check('timeline: the audit line names the punch the tap fell before',
    v_reason like '%before the shift''s last punch (%', coalesce(left(v_reason, 140), 'no line'));

  -- ---- 3. A second break tapped before the first one ended ---------------------------
  update public.time_shifts
     set status = 'voided', voided_at = now(), voided_by = v_who,
         voided_reason = 'database practice run: cleared for a clean timeline (rolled back)'
   where profile_id = v_who and status <> 'voided'
     and greatest(clock_in_at, clock_out_at) > now() - interval '1 day';
  perform pg_temp.dry_run_act_as(v_who);
  v_s := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'timeline 3', p_mode => 'data', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '3 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  v_b := public.start_break(p_shift_id => v_s.id, p_break_type => 'lunch', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '2 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  v_r := public.end_break(p_shift_id => v_s.id, p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '90 minutes', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  v_b := public.start_break(p_shift_id => v_s.id, p_break_type => 'rest', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '100 minutes', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: a second break tapped before the first ended starts at arrival and is marked tap_out_of_order',
    v_b.break_started_at = now() and v_b.review_reason = 'tap_out_of_order' and v_b.break_type = 'rest',
    coalesce(v_b.review_reason, 'no mark'));
  v_r := public.end_break(p_shift_id => v_s.id, p_client_id => gen_random_uuid(),
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  v_out := public.clock_out(p_shift_id => v_s.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => null, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => gen_random_uuid(),
    p_tapped_at => null, p_clock_checked_at => null, p_clock_skew_ms => null);
  perform pg_temp.dry_run_check('timeline: the lunch is deducted once, not twice, through the second break and the clock-out',
    v_r->>'outcome' = 'ended' and (v_r->'shift'->>'break_seconds')::int = 1800 and v_out.break_seconds = 1800,
    coalesce(v_r->'shift'->>'break_seconds', 'null') || ' s after the second break, ' || v_out.break_seconds || ' s at clock-out');

  -- ---- 4. A lunch through the LEGACY signatures bounds a keyed clock-out too ------------
  perform pg_temp.dry_run_as_system();
  update public.time_shifts
     set status = 'voided', voided_at = now(), voided_by = v_who,
         voided_reason = 'database practice run: cleared for a clean timeline (rolled back)'
   where profile_id = v_who and status <> 'voided'
     and greatest(clock_in_at, clock_out_at) > now() - interval '1 day';
  perform pg_temp.dry_run_act_as(v_who);
  v_s := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code, p_photo => null,
    p_lat => null, p_lng => null, p_note => 'timeline 4', p_mode => 'data', p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '3 hours', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  v_b := public.start_break(v_s.id, 'lunch');
  perform pg_temp.dry_run_check('timeline: the legacy start_break stamps the last punch',
    v_b.break_started_at = now() and v_b.last_punch_at = now(), coalesce(v_b.last_punch_at::text, 'null'));
  v_b := public.end_break(v_s.id);
  perform pg_temp.dry_run_check('timeline: the legacy end_break clears the break and stamps the last punch again',
    v_b.break_started_at is null and v_b.last_punch_at = now(), coalesce(v_b.last_punch_at::text, 'null'));
  v_out := public.clock_out(p_shift_id => v_s.id, p_photo => null, p_injured => false, p_time_confirmed => true,
    p_break_seconds => null, p_lat => null, p_lng => null, p_injury_note => null, p_client_id => gen_random_uuid(),
    p_tapped_at => now() - interval '10 minutes', p_clock_checked_at => now() - interval '1 hour', p_clock_skew_ms => 0);
  perform pg_temp.dry_run_check('timeline: a keyed clock-out tapped before that legacy lunch ended pays from arrival and is marked',
    v_out.clock_out_at = now() and v_out.review_reason = 'tap_out_of_order', coalesce(v_out.review_reason, 'no mark'));

  -- ---- the truth, as the system ----------------------------------------------------------
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.time_shifts
   where profile_id = v_who and xmin::text = v_xid and clock_out_at is not null and clock_out_at < clock_in_at;
  perform pg_temp.dry_run_check('timeline: no shift this run wrote ends before it starts', v_n = 0, v_n || ' bad row(s)');
  select count(*) into v_n
    from public.time_shifts a
    join public.time_shifts b on b.profile_id = a.profile_id and b.id > a.id
   where a.profile_id = v_who and a.xmin::text = v_xid and b.xmin::text = v_xid
     and a.status <> 'voided' and b.status <> 'voided'
     and a.clock_in_at < coalesce(b.clock_out_at, now()) and b.clock_in_at < coalesce(a.clock_out_at, now());
  perform pg_temp.dry_run_check('timeline: no two shifts this run wrote overlap', v_n = 0, v_n || ' overlapping pair(s)');
end $$;
