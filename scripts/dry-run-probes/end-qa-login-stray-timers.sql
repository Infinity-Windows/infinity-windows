-- Probe for the QA-login stray-timer cleanup (branch claude/qa-stray-timers):
-- 20261027010000_end_qa_login_stray_timers.sql run on the live database and
-- rolled back.
--   * no QA login keeps an open timer on a job off the sandbox list;
--   * qa.foreman's task timer on BLACK22 from 2026-09-02 is ended at its own
--     start — zero length, no labour invented;
--   * every row the migration changed belongs to a QA login (rows it changed
--     carry this transaction's id: the tool sends the migrations at top level,
--     no savepoint, and these checks run before the probe writes anything);
--   * both QA logins can now start Prep time on the practice job — before the
--     cleanup, qa.foreman's start died on the sandbox fence, because a start
--     ends every open timer first and one sat on BLACK22.
-- Job codes and qa.* logins only in the output; the repo and its logs are public.
-- Run: gh workflow run db-dry-run.yml -f ref=claude/qa-stray-timers \
--        -f migrations="supabase/migrations/20261027010000_end_qa_login_stray_timers.sql" \
--        -f probe=scripts/dry-run-probes/end-qa-login-stray-timers.sql
do $$
declare
  v_xid text;
  v_n int;
  v_total int;
  v_job uuid;
  v_job_code text;
  v_cost_code uuid;
  v_role text;
  v_shift public.time_shifts;
  v_prep uuid;
  r record;
begin
  perform pg_temp.dry_run_as_system();
  v_xid := (txid_current() % 4294967296)::text;

  -- ---- the cleanup ------------------------------------------------------------
  select count(*) into v_n
    from public.task_sessions t
    join public.profiles p on p.id = t.profile_id
    left join public.project_openings o on o.id = t.opening_id
   where coalesce(p.is_test, false) and t.ended_at is null
     and coalesce(t.project_id, o.project_id) is not null
     and not public.is_sandbox_project(coalesce(t.project_id, o.project_id));
  select v_n + count(*) into v_n
    from public.unit_sessions s
    join public.profiles p on p.id = s.profile_id
    join public.project_openings o on o.id = s.opening_id
   where coalesce(p.is_test, false) and s.ended_at is null and not public.is_sandbox_project(o.project_id);
  select v_n + count(*) into v_n
    from public.custom_work_sessions c
    join public.profiles p on p.id = c.profile_id
   where coalesce(p.is_test, false) and c.ended_at is null and c.project_id is not null
     and not public.is_sandbox_project(c.project_id);
  perform pg_temp.dry_run_check('cleanup: no QA login keeps an open timer on a job off the sandbox list', v_n = 0, v_n || ' left open');

  select count(*) into v_n
    from public.task_sessions t
    join auth.users u on u.id = t.profile_id
    left join public.project_openings o on o.id = t.opening_id
    left join public.projects pj on pj.id = coalesce(t.project_id, o.project_id)
   where u.email = 'qa.foreman@crew.infinitywindows.app' and t.xmin::text = v_xid
     and t.ended_at = t.started_at and pj.job_code = 'BLACK22';
  perform pg_temp.dry_run_check('cleanup: qa.foreman''s BLACK22 task timer is ended at its own start (zero length)', v_n >= 1, v_n || ' timer(s)');

  select count(*), count(*) filter (where not coalesce(p.is_test, false)) into v_total, v_n
    from (select t.profile_id from public.task_sessions t where t.xmin::text = v_xid
          union all select s.profile_id from public.unit_sessions s where s.xmin::text = v_xid
          union all select c.profile_id from public.custom_work_sessions c where c.xmin::text = v_xid) x
    join public.profiles p on p.id = x.profile_id;
  perform pg_temp.dry_run_check('cleanup: it touched no real person''s timer', v_n = 0,
    v_total || ' row(s) changed, ' || v_n || ' of them a real person''s');

  -- ---- the proof: both QA logins start Prep time on the practice job -----------
  select p.id, p.job_code into v_job, v_job_code
    from public.sandbox_projects s join public.projects p on p.id = s.project_id
   where p.deleted_at is null and coalesce(p.is_test, false)
   order by (p.job_code = 'PECAN14') desc, (p.job_code = 'BLACK22') desc, p.job_code
   limit 1;
  if v_job is null then
    raise exception 'dry run: no job is both flagged as testing and on the sandbox list, so the QA logins have nowhere to work. Mark a practice job as testing in the app and run again.';
  end if;
  select id into v_cost_code from public.cost_codes order by active desc, code limit 1;
  perform pg_temp.dry_run_check('setup: the practice job the run works on (and throws away)', true, v_job_code);

  for r in
    select u.id, split_part(u.email, '@', 1) as who
      from auth.users u join public.profiles p on p.id = u.id
     where u.email in ('qa.foreman@crew.infinitywindows.app', 'qa.installer@crew.infinitywindows.app')
       and coalesce(p.is_test, false)
     order by u.email
  loop
    perform pg_temp.dry_run_as_system();
    update public.time_shifts set clock_out_at = now(), status = 'submitted' where profile_id = r.id and clock_out_at is null;
    insert into public.toolbox_completions (profile_id, signed_at) values (r.id, now());
    v_role := pg_temp.dry_run_act_as(r.id);
    v_prep := null;
    begin
      v_shift := public.clock_in(p_project_id => v_job, p_cost_code_id => v_cost_code);
      v_prep := public.custom_work_command(gen_random_uuid(), 'start', jsonb_build_object(
        'id', gen_random_uuid(), 'unit_id', null, 'shift_id', v_shift.id, 'expected_session_id', null,
        'description', 'dry run prep'));
      perform pg_temp.dry_run_check(r.who || ' (' || v_role || ') clocks in and starts Prep time on the practice job',
        v_prep is not null, 'session ' || coalesce(v_prep::text, 'none'));
    exception when others then
      perform pg_temp.dry_run_check(r.who || ' (' || v_role || ') clocks in and starts Prep time on the practice job',
        false, 'refused: ' || sqlstate || ' ' || sqlerrm);
    end;
  end loop;
end $$;
