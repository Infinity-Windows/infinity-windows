-- Synthetic reports only; the harness rolls every row and schema change back.
do $$
declare
  reporter uuid; other_reader uuid; reviewer uuid; report_id uuid; n int;
begin
  perform pg_temp.dry_run_as_system();
  reporter := pg_temp.dry_run_pick('installer');
  other_reader := pg_temp.dry_run_pick('foreman');
  reviewer := pg_temp.dry_run_pick_real('owner');
  perform pg_temp.dry_run_act_as(reporter);
  insert into public.app_feedback (author,kind,body,category)
    values (reporter,'bug','Synthetic dry-run AI report','ai') returning id into report_id;
  select count(*) into n from public.app_feedback where id=report_id and category='ai';
  perform pg_temp.dry_run_check('installer can file and read their AI report',n=1,n||' rows');
  perform pg_temp.dry_run_expect_error('report cannot pretend to have another author',
    format('insert into public.app_feedback (author,kind,body,category) values (%L::uuid,''bug'',''Synthetic impersonation test'',''ai'')',reviewer),null);
  perform pg_temp.dry_run_expect_error('AI category admits only known sections',
    format('insert into public.app_feedback (author,kind,body,category) values (%L::uuid,''bug'',''Synthetic invalid category'',''other'')',reporter),null);
  update public.app_feedback set status='resolved' where id=report_id;
  get diagnostics n=row_count;
  perform pg_temp.dry_run_check('installer cannot resolve reports',n=0,n||' rows updated');
  perform pg_temp.dry_run_act_as(other_reader);
  select count(*) into n from public.app_feedback where id=report_id;
  perform pg_temp.dry_run_check('another non-owner cannot read the AI report',n=0,n||' rows');
  perform pg_temp.dry_run_act_as(reviewer);
  update public.app_feedback set status='resolved',resolved_by=reviewer,resolved_at=now(),
    resolution_note='Synthetic verified release evidence' where id=report_id;
  get diagnostics n=row_count;
  perform pg_temp.dry_run_check('owner can review and resolve AI report',n=1,n||' rows updated');
  perform pg_temp.dry_run_act_as(reporter);
  select count(*) into n from public.app_feedback where id=report_id and status='resolved'
    and resolved_by=reviewer and resolution_note='Synthetic verified release evidence';
  perform pg_temp.dry_run_check('reporter can see resolution and verification',n=1,n||' rows');
  perform pg_temp.dry_run_as_system();
end $$;

do $$
declare installer uuid; reviewer uuid; n int;
begin
  perform pg_temp.dry_run_as_system();
  installer := pg_temp.dry_run_pick('installer'); reviewer := pg_temp.dry_run_pick_real('owner');
  perform pg_temp.dry_run_act_as(installer);
  select count(*) into n from public.app_release_notes where id in ('2026-10-01-ask-ai-issues','2026-10-01-learning-rounds','2026-10-01-model-contrast');
  perform pg_temp.dry_run_check('installer sees three crew announcements',n=3,n||' rows');
  select count(*) into n from public.app_release_notes where id='2026-10-01-schedule-date-inputs';
  perform pg_temp.dry_run_check('installer does not see scheduling manager announcement',n=0,n||' rows');
  perform pg_temp.dry_run_act_as(reviewer);
  select count(*) into n from public.app_release_notes where id in ('2026-10-01-ask-ai-issues','2026-10-01-learning-rounds','2026-10-01-model-contrast','2026-10-01-schedule-date-inputs');
  perform pg_temp.dry_run_check('owner sees all four release announcements',n=4,n||' rows');
  perform pg_temp.dry_run_as_system();
end $$;
