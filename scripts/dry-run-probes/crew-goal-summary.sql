-- Called by db-dry-run inside its forced-rollback transaction.
do $$
declare
  v_job uuid; v_person uuid; v_partner uuid; v_role text; v_result jsonb;
  v_expected numeric; v_before bigint; v_after bigint; v_goal numeric;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  -- Test the actual approved-target source without changing any lasting record.
  insert into public.project_labor_targets(project_id, goal_hours, revision)
    values (v_job, 120, 1)
    on conflict (project_id) do update set goal_hours = 120, revision = public.project_labor_targets.revision + 1;
  select goal_hours into v_goal from public.project_labor_targets where project_id = v_job;
  select count(*) into v_before from public.time_shifts where project_id = v_job;
  select coalesce(sum(greatest(0, extract(epoch from (clock_out_at-clock_in_at)) - break_seconds)/3600),0)
    into v_expected from public.time_shifts
    where project_id = v_job and status in ('submitted','approved') and clock_out_at is not null;

  foreach v_role in array array['installer','foreman','supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    v_person := pg_temp.dry_run_pick(v_role);
    perform pg_temp.dry_run_act_as(v_person);
    select public.crew_goal_summary(v_job) into v_result;
    perform pg_temp.dry_run_check('crew goal ' || v_role || ' matches approved source and complete paid time',
      (v_result->>'goal_hours')::numeric = v_goal and (v_result->>'recorded_hours')::numeric = v_expected
      and (v_result->>'as_of') is not null and (v_result->>'goal_revision') is not null,
      'aggregate and revision checked');
    perform pg_temp.dry_run_check('crew goal ' || v_role || ' exposes only safe aggregate fields',
      (select count(*) = 9 from jsonb_object_keys(v_result))
      and not (v_result ?| array['profile_id','display_name','rate','cost','time_shifts','updated_by']),
      '9 keys, no private rows or rates');
  end loop;

  perform pg_temp.dry_run_as_system();
  select id into v_partner from public.profiles where is_partner is true and retired_at is null and access_revoked_at is null order by id limit 1;
  if v_partner is null then raise exception 'dry run: no current partner login to test denial'; end if;
  perform pg_temp.dry_run_act_as(v_partner);
  perform pg_temp.dry_run_expect_error('partner cannot read crew goal',
    format('select public.crew_goal_summary(%L::uuid)', v_job), 'unavailable');

  perform pg_temp.dry_run_as_system();
  select count(*) into v_after from public.time_shifts where project_id = v_job;
  perform pg_temp.dry_run_check('goal reads did not change job clock rows', v_after = v_before, 'row count unchanged');
end $$;
