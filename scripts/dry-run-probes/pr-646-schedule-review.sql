-- Probe for PR #646 (branch claude/r2-schedule-review): the schedule_ai_reasons
-- table and its supervisor-only wall from 20261032000000_ai_schedule_review.sql,
-- plus the announcement, tried on the real database and rolled back.
--
-- Who acts. There is no QA supervisor login (docs/test-account.md: installer
-- and foreman only), and acting as a REAL supervisor — even inside a rollback
-- — is what the practice-run rules forbid. So the supervisor side is proved
-- by scripts/verify-schedule-ai-reasons.mjs on synthetic people, and here the
-- system sets the scene (an AI draft on the sandbox job, and its reason), the
-- policy is read back as the system, and the two QA logins prove the DENIAL
-- against the live policies: no rows on read, refused on write. If a QA login
-- has been given another role, the run stops loudly instead of acting as a
-- real person (that is what happened to #641's runs on 2026-09-24).
--
-- The job is whichever job is both flagged as testing and on the sandbox list
-- (PECAN14 first, then BLACK22, then by code), the same rule #641's probe uses.
--
-- Run: gh workflow run db-dry-run.yml --repo Infinity-Windows/infinity-windows \
--        -f ref=claude/r2-schedule-review \
--        -f migrations="supabase/migrations/20261030000000_ai_daily_log_contributions.sql supabase/migrations/20261030010000_ai_actions_note.sql supabase/migrations/20261032000000_ai_schedule_review.sql" \
--        -f probe=scripts/dry-run-probes/pr-646-schedule-review.sql
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_job uuid;
  v_job_code text;
  v_role text;
  v_note public.app_release_notes;
  v_draft uuid;
  v_seen timestamptz;
  v_n int;
  v_policies text;
begin
  -- ---- setup, as the system ---------------------------------------------------
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  if not public.is_test_profile(v_installer) then
    raise exception 'dry run: no QA login has the installer role, so the run would act as a real person. Set qa.installer (shown as "TEST — automation, do not assign") to Installer in the app and run again.';
  end if;
  if not public.is_test_profile(v_foreman) then
    raise exception 'dry run: no QA login has the foreman role, so the run would act as a real person. Set qa.foreman (shown as "TEST — automation FOREMAN, do not assign") to Foreman in the app and run again.';
  end if;
  select p.id, p.job_code into v_job, v_job_code
    from public.sandbox_projects s join public.projects p on p.id = s.project_id
   where p.deleted_at is null and coalesce(p.is_test, false)
   order by (p.job_code = 'PECAN14') desc, (p.job_code = 'BLACK22') desc, p.job_code
   limit 1;
  if v_job is null then
    raise exception 'dry run: no job is both flagged as testing and on the sandbox list. Mark a practice job as testing in the app (that puts it on the sandbox list too) and run again.';
  end if;
  perform pg_temp.dry_run_check('setup: the sandbox job the run writes on (and throws away)', true, v_job_code);

  -- ---- the announcement ----------------------------------------------------------
  select * into v_note from public.app_release_notes where id = '2026-09-24-ai-schedule-review';
  perform pg_temp.dry_run_check('announcement: the row exists after the migration',
    v_note.id is not null, coalesce(v_note.id, 'missing'));
  perform pg_temp.dry_run_check('announcement: supervisors and owners only (ranks 2 and 3), opens Scheduling',
    v_note.audience = array[2, 3] and v_note.href = '/scheduling',
    coalesce(v_note.audience::text, 'null') || ' ' || coalesce(v_note.href, 'null'));
  perform pg_temp.dry_run_check('announcement: title and body in both languages, translated',
    length(trim(v_note.title_en)) > 0 and length(trim(v_note.title_es)) > 0
    and length(trim(v_note.body_en)) > 0 and length(trim(v_note.body_es)) > 0
    and v_note.title_es <> v_note.title_en and v_note.body_es <> v_note.body_en, null);

  -- ---- the wall, as the database describes it -----------------------------------
  perform pg_temp.dry_run_check('schema: schedule_ai_reasons exists with row security on',
    exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'schedule_ai_reasons' and c.relrowsecurity), null);
  select string_agg(policyname || ':' || cmd, ',' order by policyname) into v_policies
    from pg_policies where schemaname = 'public' and tablename = 'schedule_ai_reasons';
  perform pg_temp.dry_run_check('policy: exactly a supervisor read and a supervisor insert, nothing else',
    v_policies = 'schedule_ai_reasons_supervisor_read:SELECT,schedule_ai_reasons_supervisor_write:INSERT',
    coalesce(v_policies, 'none'));
  perform pg_temp.dry_run_check('policy: both name the partner guard and the supervisor rank',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'schedule_ai_reasons'
       and coalesce(qual, with_check) like '%is_partner_user()%' and coalesce(qual, with_check) like '%travel_is_supervisor()%') = 2, null);
  perform pg_temp.dry_run_check('grants: authenticated may select and insert, never update or delete; anon nothing',
    has_table_privilege('authenticated', 'public.schedule_ai_reasons', 'select')
    and has_table_privilege('authenticated', 'public.schedule_ai_reasons', 'insert')
    and not has_table_privilege('authenticated', 'public.schedule_ai_reasons', 'update')
    and not has_table_privilege('authenticated', 'public.schedule_ai_reasons', 'delete')
    and not has_table_privilege('anon', 'public.schedule_ai_reasons', 'select'), null);

  -- ---- an AI draft on the sandbox job, with its reason, as the system ------------
  insert into public.schedule_assignments(project_id, start_date, end_date, status, created_via)
    values (v_job, current_date + 30, current_date + 30, 'draft', 'ai')
    returning id, updated_at into v_draft, v_seen;
  insert into public.schedule_ai_reasons(assignment_id, reason, created_by)
    values (v_draft, 'Dry run: second pair of hands for the corner units', null);
  perform pg_temp.dry_run_check('setup: one AI draft with one reason on the sandbox job', true, 'draft ' || v_draft);
  perform pg_temp.dry_run_expect_error('constraint: a 161-character reason is refused at the database',
    format('insert into public.schedule_ai_reasons(assignment_id, reason) values (%L::uuid, %L)', v_draft, repeat('x', 161)));

  -- ---- the QA installer: nothing to read, nothing to write ---------------------
  v_role := pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_check('acting as the QA installer', v_role = 'installer' and current_user = 'authenticated', v_role);
  select count(*) into v_n from public.schedule_ai_reasons;
  perform pg_temp.dry_run_check('installer: reads zero reasons (no rows, not an error)', v_n = 0, v_n || ' row(s)');
  perform pg_temp.dry_run_expect_error('installer: cannot record a reason',
    format('insert into public.schedule_ai_reasons(assignment_id, reason, created_by) values (%L::uuid, %L, %L::uuid)', v_draft, 'installer tries', v_installer));

  -- ---- the QA foreman: the same ---------------------------------------------------
  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('acting as the QA foreman', v_role = 'foreman', v_role);
  select count(*) into v_n from public.schedule_ai_reasons;
  perform pg_temp.dry_run_check('foreman: reads zero reasons', v_n = 0, v_n || ' row(s)');
  perform pg_temp.dry_run_expect_error('foreman: cannot record a reason',
    format('insert into public.schedule_ai_reasons(assignment_id, reason, created_by) values (%L::uuid, %L, %L::uuid)', v_draft, 'foreman tries', v_foreman));

  -- ---- the truth, as the system ------------------------------------------------
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from public.schedule_ai_reasons where assignment_id = v_draft;
  perform pg_temp.dry_run_check('system: the one reason is still there and readable above the wall', v_n = 1, v_n || ' row(s)');
  -- The review card's Drop after another supervisor published: nothing matches.
  update public.schedule_assignments set status = 'published', published_at = now(), updated_at = clock_timestamp() where id = v_draft;
  delete from public.schedule_assignments where id = v_draft and status = 'draft' and updated_at = v_seen;
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('drop: a stale Drop (status and revision checked) deletes nothing once the row is published', v_n = 0, v_n || ' row(s) deleted');
  select count(*) into v_n from public.schedule_ai_reasons where assignment_id = v_draft;
  perform pg_temp.dry_run_check('drop: the published row keeps its reason', v_n = 1, v_n || ' row(s)');
  -- And when the draft itself goes, the reason goes with it.
  delete from public.schedule_assignments where id = v_draft;
  select count(*) into v_n from public.schedule_ai_reasons where assignment_id = v_draft;
  perform pg_temp.dry_run_check('cascade: deleting the draft removes its reason', v_n = 0, v_n || ' row(s)');
  perform pg_temp.dry_run_as_system();
end $$;
