-- Read-only check of the owner's phone drill on PECAN14, 2026-09-24 ~11:30 PM MDT
-- (05:30 UTC Sep 25). Times in MDT, counts only; no names, no ids.
do $$
declare
  v_job uuid; v_since timestamptz := '2026-09-25 05:00:00+00'; v_line text; r record; v_n int; v_sql text;
begin
  perform pg_temp.dry_run_as_system();
  select id into v_job from public.projects where job_code = 'PECAN14';
  perform pg_temp.dry_run_check('PECAN14 flags', true, (select format('is_test=%s sandbox=%s', coalesce(p.is_test,false), public.is_sandbox_project(p.id)) from public.projects p where p.id = v_job));
  for r in select s.id, s.clock_in_at, s.clock_out_at, s.break_seconds, s.status, to_jsonb(s)->>'review_reason' as rr, pr.role, coalesce(pr.is_test,false) as t
             from public.time_shifts s join public.profiles pr on pr.id = s.profile_id
            where s.project_id = v_job and s.clock_in_at > v_since - interval '1 hour' order by s.clock_in_at loop
    perform pg_temp.dry_run_check('shift', true, format('%s%s in %s out %s breaks %ss status %s review %s',
      r.role, case when r.t then ' (test login)' else '' end,
      to_char(r.clock_in_at at time zone 'America/Denver', 'HH24:MI:SS'), coalesce(to_char(r.clock_out_at at time zone 'America/Denver', 'HH24:MI:SS'), 'open'),
      coalesce(r.break_seconds, 0), r.status, coalesce(r.rr, '-')));
    select string_agg(format('%s %s tap %s arrived %s used_tap=%s review=%s', a.action, a.outcome,
             coalesce(to_char(a.tapped_at at time zone 'America/Denver', 'HH24:MI:SS'), '-'), to_char(a.arrived_at at time zone 'America/Denver', 'HH24:MI:SS'),
             a.used_tap_time, coalesce(a.review_reason, '-')), '; ' order by a.created_at)
      into v_line from public.time_clock_actions a where a.shift_id = r.id;
    perform pg_temp.dry_run_check('  clock ledger', true, coalesce(v_line, 'no ledger rows'));
  end loop;
  -- photo-ish rows on the job since the drill started, in every table that has project_id + created_at
  v_line := '';
  for r in select c.table_name from information_schema.columns c
            where c.table_schema = 'public' and c.column_name = 'project_id'
              and (c.table_name ilike '%photo%' or c.table_name ilike '%media%' or c.table_name ilike '%image%')
              and exists (select 1 from information_schema.columns c2 where c2.table_schema = 'public' and c2.table_name = c.table_name and c2.column_name = 'created_at') loop
    begin
      execute format('select count(*) from public.%I where project_id = $1 and created_at > $2', r.table_name) into v_n using v_job, v_since;
      if v_n > 0 then v_line := v_line || format('%s=%s ', r.table_name, v_n); end if;
    exception when others then null; end;
  end loop;
  perform pg_temp.dry_run_check('photo rows on PECAN14 since 11 PM', true, coalesce(nullif(v_line, ''), 'none'));
  select string_agg(format('%s=%s', b, n), ' ') into v_line from (
    select o.bucket_id as b, count(*) as n from storage.objects o
     where o.created_at > v_since and (split_part(o.name, '/', 1) = v_job::text or o.name like '%' || v_job::text || '%') group by 1) x;
  perform pg_temp.dry_run_check('stored files for PECAN14 since 11 PM', true, coalesce(v_line, 'none'));
  select format('%s units changed, %s marked whole-install complete', count(*), count(*) filter (where facts->>'installation_complete' = 'Yes'))
    into v_line from public.custom_work_units where project_id = v_job and updated_at > v_since;
  perform pg_temp.dry_run_check('custom units on PECAN14 since 11 PM', true, v_line);
  select format('log %s revision %s, %s AI contribution(s) since 11 PM', d.log_date, d.revision,
           (select count(*) from public.daily_log_contributions c where c.project_id = v_job and c.created_at > v_since))
    into v_line from public.daily_logs d where d.project_id = v_job order by d.log_date desc limit 1;
  perform pg_temp.dry_run_check('daily log on PECAN14', true, coalesce(v_line, 'no log'));
end $$;
