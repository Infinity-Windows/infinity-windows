-- Exercise this release note on the real schema; the harness discards it.
do $$
declare
  v_person uuid;
  v_role text;
  v_count integer;
  v_expected integer;
begin
  foreach v_role in array array['installer','foreman','supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    v_person := pg_temp.dry_run_pick(v_role);
    perform pg_temp.dry_run_act_as(v_person);
    select count(*) into v_count
      from public.app_release_notes
      where id = '2026-10-01-jobs-overview';
    v_expected := case when v_role in ('supervisor','owner') then 1 else 0 end;
    perform pg_temp.dry_run_check(
      'Jobs overview announcement has the correct audience for ' || v_role,
      v_count = v_expected, v_count || ' readable note(s)'
    );
  end loop;
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check(
    'Jobs overview note links to Jobs and contains both languages',
    exists(select 1 from public.app_release_notes
      where id = '2026-10-01-jobs-overview'
        and href = '/projects'
        and length(title_en) > 0 and length(title_es) > 0
        and length(body_en) > 0 and length(body_es) > 0),
    'release note contents'
  );
end $$;

-- Read-only contract probes as the two overview roles. No business rows change.
do $$
declare v_role text; v_person uuid; v_job uuid; v_n integer;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  foreach v_role in array array['supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    v_person := pg_temp.dry_run_pick(v_role);
    perform pg_temp.dry_run_act_as(v_person);
    perform project_id, openings, installed from public.project_scope_counts where project_id=v_job;
    perform id, project_id, opening_id, facts from public.custom_work_units where project_id=v_job;
    perform id, project_id, started_at, ended_at, outcome from public.custom_work_sessions where project_id=v_job;
    perform s.id, s.started_at, s.ended_at, s.opening_id, s.end_reason, s.role, o.project_id
      from public.unit_sessions s join public.project_openings o on o.id=s.opening_id where o.project_id=v_job;
    perform id, project_id, unit_id, filed_by, work_date, stage, outcome, whole_complete, description, created_at
      from public.crew_work_records where project_id=v_job;
    perform id, project_id, log_date, headline, created_at, updated_at from public.daily_logs where project_id=v_job;
    perform a.id, a.project_id, a.kind, a.start_date, a.end_date, a.start_time, a.status, a.note, a.published_at, a.updated_at, a.created_at, m.profile_id, m.role, p.display_name
      from public.schedule_assignments a left join public.schedule_assignment_members m on m.assignment_id=a.id left join public.profiles p on p.id=m.profile_id where a.project_id=v_job;
    select count(*) into v_n from public.list_issues() where project_id=v_job;
    perform pg_temp.dry_run_check('Overview read contracts available to '||v_role,true,'sandbox-scoped reads completed');
    select count(*) into v_n from public.green_light_items(v_job);
    perform pg_temp.dry_run_check('Readiness RPC available to '||v_role,v_n=6,v_n||' checklist items');
  end loop;
  perform pg_temp.dry_run_as_system();
end $$;
