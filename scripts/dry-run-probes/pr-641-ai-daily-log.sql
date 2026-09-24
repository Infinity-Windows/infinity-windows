-- Probe for PR #641 (branch claude/r2-ai): append_daily_log_contribution from
-- 20261030000000_ai_daily_log_contributions.sql, called on the real database
-- as the two QA logins on a sandbox job, and rolled back. (A real installer
-- cannot reach a testing job at all — it is hidden below supervisor — so the
-- two people who can both write there are the QA installer and the QA
-- foreman; the last scenario proves the fence still holds for a real one.)
-- The job is whichever job is both flagged as testing and on the sandbox list
-- (PECAN14 first — the owner restored it on 2026-09-24 as the practice job, so
-- a run never needs MADMOOSE, a real job flagged as testing — then BLACK22 if
-- it is flagged again, then by code), never a fixed code: on 2026-09-24
-- BLACK22 had been unflagged, and a probe pinned to it failed on the fence
-- instead of testing the change.
--   * two different people contribute to the same job-day: both entries are
--     kept, the second is appended under the first, the first author stays;
--   * the same words under the same id again is already_saved, not a copy;
--   * a stale revision writes nothing;
--   * person_record_counts still carries every key master has, plus the
--     contributions'.
-- Run: gh workflow run db-dry-run.yml -f ref=claude/r2-ai \
--        -f migrations="supabase/migrations/20261030000000_ai_daily_log_contributions.sql supabase/migrations/20261030010000_ai_actions_note.sql" \
--        -f probe=scripts/dry-run-probes/pr-641-ai-daily-log.sql
do $$
declare
  v_first uuid;
  v_second uuid;
  v_real uuid;
  v_job uuid;
  v_job_code text;
  v_role text;
  v_rev_before bigint;
  v_r1 jsonb;
  v_r2 jsonb;
  v_r3 jsonb;
  v_r4 jsonb;
  v_counts jsonb;
  v_log public.daily_logs;
  v_n int;
  v_id1 uuid := gen_random_uuid();
  v_id2 uuid := gen_random_uuid();
  v_answers1 jsonb := '{"work_completed": {"status": "captured", "value": "Dry run: set two frames on the east wall", "source": "said"},
                        "day_flow": {"status": "captured", "value": "fine"}, "weather": {"status": "unknown"}}';
  v_body1 text := 'Work completed: Dry run: set two frames on the east wall';
  v_answers2 jsonb := '{"work_completed": {"status": "captured", "value": "Dry run: flashed units 3 and 4", "source": "said"},
                        "went_well": {"status": "captured", "value": "Dry run: deliveries on time"}}';
  v_body2 text := 'Work completed: Dry run: flashed units 3 and 4';
begin
  -- ---- setup, as the system -------------------------------------------------
  perform pg_temp.dry_run_as_system();
  v_first := pg_temp.dry_run_pick('installer');
  v_second := pg_temp.dry_run_pick('foreman');
  v_real := pg_temp.dry_run_pick_real('installer');
  select p.id, p.job_code into v_job, v_job_code
    from public.sandbox_projects s join public.projects p on p.id = s.project_id
   where p.deleted_at is null and coalesce(p.is_test, false)
   order by (p.job_code = 'PECAN14') desc, (p.job_code = 'BLACK22') desc, p.job_code
   limit 1;
  if v_job is null then
    raise exception 'dry run: no job is both flagged as testing and on the sandbox list, so the QA logins have nowhere to write. Mark a practice job as testing in the app (that puts it on the sandbox list too) and run again.';
  end if;
  -- dry_run_pick falls back to a real person when no QA login holds the role,
  -- and a real person is refused on a testing job with the same sentence this
  -- probe is here to test. On 2026-09-24 qa.installer had been set to foreman
  -- and three runs died on that refusal. Stop loudly instead.
  if not public.is_test_profile(v_first) then
    raise exception 'dry run: no QA login has the installer role, so the run would act as a real person. Set qa.installer (shown as "TEST — automation, do not assign") to Installer in the app and run again.';
  end if;
  if not public.is_test_profile(v_second) then
    raise exception 'dry run: no QA login has the foreman role, so the run would act as a real person. Set qa.foreman (shown as "TEST — automation FOREMAN, do not assign") to Foreman in the app and run again.';
  end if;
  perform pg_temp.dry_run_check('setup: the sandbox job the run writes on (and throws away)', true, v_job_code);
  perform pg_temp.dry_run_check('setup: two different people who may write on the sandbox job', v_first <> v_second, null);
  perform pg_temp.dry_run_check('schema: daily_logs.revision, daily_log_contributions and the revision trigger exist',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'daily_logs' and column_name = 'revision')
    and to_regclass('public.daily_log_contributions') is not null
    and exists (select 1 from pg_trigger where tgname = 'daily_logs_revision'),
    null);
  select coalesce((select revision from public.daily_logs where project_id = v_job and log_date = current_date), 0)
    into v_rev_before;
  perform pg_temp.dry_run_check('setup: the sandbox job has a log for today already, or not', true,
    'revision before the run: ' || v_rev_before);

  -- ---- the first person contributes -------------------------------------------
  v_role := pg_temp.dry_run_act_as(v_first);
  perform pg_temp.dry_run_check('acting as an installer', v_role = 'installer' and current_user = 'authenticated', v_role);
  v_r1 := public.append_daily_log_contribution(v_id1, v_first, v_job, current_date, v_rev_before,
    v_answers1, v_body1, '{}'::uuid[], '{}'::uuid[]);
  perform pg_temp.dry_run_check('append: the first contribution is saved on the revision the person was shown',
    v_r1->>'status' = 'saved' and (v_r1->>'base_revision')::bigint = v_rev_before
    and (v_r1->>'saved_revision')::bigint = v_rev_before + 1,
    coalesce(v_r1->>'status', 'null') || ', revision ' || coalesce(v_r1->>'base_revision', '?') || ' -> ' || coalesce(v_r1->>'saved_revision', '?'));
  perform pg_temp.dry_run_check('append: the receipt carries the shared log with the words in it',
    (v_r1->'log'->>'notes') like '%' || v_body1 || '%' and (v_r1->'log'->>'day_flow') is not null,
    'log ' || coalesce(v_r1->'log'->>'id', 'null'));

  -- ---- the second person adds theirs, on the revision the first save made ----
  v_role := pg_temp.dry_run_act_as(v_second);
  perform pg_temp.dry_run_check('acting as a foreman', v_role = 'foreman', v_role);
  v_r2 := public.append_daily_log_contribution(v_id2, v_second, v_job, current_date, (v_r1->>'saved_revision')::bigint,
    v_answers2, v_body2, '{}'::uuid[], '{}'::uuid[]);
  perform pg_temp.dry_run_check('append: the second person''s contribution is saved on top, not instead',
    v_r2->>'status' = 'saved' and (v_r2->>'created_log')::boolean = false
    and (v_r2->>'saved_revision')::bigint = (v_r1->>'saved_revision')::bigint + 1,
    coalesce(v_r2->>'status', 'null') || ', revision ' || coalesce(v_r2->>'saved_revision', '?'));

  -- ---- the truth, as the system -----------------------------------------------
  perform pg_temp.dry_run_as_system();
  select * into v_log from public.daily_logs where project_id = v_job and log_date = current_date;
  perform pg_temp.dry_run_check('log: both contributions are in the one shared job-day log',
    v_log.notes like '%' || v_body1 || '%' and v_log.notes like '%' || v_body2 || '%'
    and position(v_body1 in v_log.notes) < position(v_body2 in v_log.notes),
    'revision ' || v_log.revision || ', ' || length(v_log.notes) || ' characters');
  perform pg_temp.dry_run_check('log: each addendum names who added it, and the first author is kept',
    (length(v_log.notes) - length(replace(v_log.notes, 'with Forge AI:', ''))) / length('with Forge AI:') >= 2
    and v_log.filed_by = case when (v_r1->>'created_log')::boolean then v_first else v_log.filed_by end
    and v_log.updated_by = v_second,
    'filed_by unchanged: ' || ((v_r1->>'created_log')::boolean = false or v_log.filed_by = v_first)::text);
  select count(*) into v_n from public.daily_log_contributions where id in (v_id1, v_id2) and project_id = v_job;
  perform pg_temp.dry_run_check('contributions: two rows, one per person', v_n = 2, v_n || ' row(s)');

  -- ---- a lost response: the first phone sends the same words again ---------------
  perform pg_temp.dry_run_act_as(v_first);
  v_r3 := public.append_daily_log_contribution(v_id1, v_first, v_job, current_date, v_rev_before,
    v_answers1, v_body1, '{}'::uuid[], '{}'::uuid[]);
  perform pg_temp.dry_run_check('append: the same id and words again is already_saved, even after the log moved on',
    v_r3->>'status' = 'already_saved' and (v_r3->>'contribution_id')::uuid = v_id1,
    coalesce(v_r3->>'status', 'null'));
  perform pg_temp.dry_run_expect_error('append: the same id with different words is refused',
    format('select public.append_daily_log_contribution(%L::uuid, %L::uuid, %L::uuid, current_date, 0, %L::jsonb, %L, ''{}''::uuid[], ''{}''::uuid[])',
           v_id1, v_first, v_job, '{"work_completed": {"status": "captured", "value": "Dry run: other words"}}', 'Dry run: other words'),
    'already saved with different words');

  -- ---- a stale preview writes nothing -----------------------------------------------
  perform pg_temp.dry_run_act_as(v_second);
  v_r4 := public.append_daily_log_contribution(gen_random_uuid(), v_second, v_job, current_date, v_rev_before,
    '{"work_completed": {"status": "captured", "value": "Dry run: stale words"}}'::jsonb, 'Dry run: stale words',
    '{}'::uuid[], '{}'::uuid[]);
  perform pg_temp.dry_run_check('append: a save against an old revision is stale and shows the current log',
    v_r4->>'status' = 'stale' and (v_r4->>'current_revision')::bigint = (v_r2->>'saved_revision')::bigint,
    coalesce(v_r4->>'status', 'null') || ', current ' || coalesce(v_r4->>'current_revision', '?'));

  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.daily_log_contributions where project_id = v_job and log_date = current_date
    and body like '%Dry run:%';
  perform pg_temp.dry_run_check('contributions: the replay and the stale save added no row', v_n = 2, v_n || ' row(s)');
  select * into v_log from public.daily_logs where project_id = v_job and log_date = current_date;
  perform pg_temp.dry_run_check('log: the stale words never reached the log',
    v_log.notes not like '%Dry run: stale words%' and v_log.revision = (v_r2->>'saved_revision')::bigint,
    'revision ' || v_log.revision);

  -- ---- the fence: a real installer cannot reach the testing job ---------------------
  perform pg_temp.dry_run_act_as(v_real);
  perform pg_temp.dry_run_expect_error('fence: a real installer is refused on the sandbox job (a testing job is not theirs to see)',
    format('select public.append_daily_log_contribution(%L::uuid, %L::uuid, %L::uuid, current_date, 0, %L::jsonb, %L, ''{}''::uuid[], ''{}''::uuid[])',
           gen_random_uuid(), v_real, v_job, '{"work_completed": {"status": "captured", "value": "Dry run: must not save"}}', 'Dry run: must not save'),
    'Choose an existing job');

  -- ---- person_record_counts: every key master has, plus the contributions' ---------------
  perform pg_temp.dry_run_as_system();
  v_counts := public.person_record_counts(v_first);
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
    'daily_log_contributions.actor_id']) k where not (v_counts ? k);
  perform pg_temp.dry_run_check('person_record_counts: keeps every key master has (learning references included) plus daily_log_contributions',
    v_n = 0, v_n || ' key(s) missing');
  perform pg_temp.dry_run_check('person_record_counts: counts the contribution this run wrote',
    (v_counts->>'daily_log_contributions.actor_id')::int >= 1, coalesce(v_counts->>'daily_log_contributions.actor_id', 'null') || ' row(s)');
end $$;
