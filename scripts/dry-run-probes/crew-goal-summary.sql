-- Called by db-dry-run inside its forced-rollback transaction.
do $$
declare
  v_job uuid; v_person uuid; v_partner uuid; v_role text; v_actual_role text; v_result jsonb;
  v_expected numeric; v_before bigint; v_after bigint; v_goal numeric;
  v_unresolved_before bigint; v_flagged_id uuid := gen_random_uuid();
  v_qa_foreman uuid; v_partner_fixture boolean := false;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  -- Test the actual approved-target source without changing any lasting record.
  insert into public.project_labor_targets(project_id, goal_hours, revision)
    values (v_job, 120, 1)
    on conflict (project_id) do update set goal_hours = 120, revision = public.project_labor_targets.revision + 1;
  select goal_hours into v_goal from public.project_labor_targets where project_id = v_job;
  select count(*) into v_unresolved_before from public.time_shifts
    where project_id = v_job and status <> 'voided' and (
      status in ('needs_finish','rejected')
      or (status not in ('voided','open') and clock_out_at is null)
      or (status = 'open' and clock_out_at is not null)
      or (status in ('submitted','approved') and clock_out_at is not null and (
        review_reason is not null or time_confirmed is false
        or clock_out_at < clock_in_at or break_seconds < 0
        or break_seconds > extract(epoch from (clock_out_at-clock_in_at)))));
  -- A valid 90-minute submitted shift with TWO uncertainty flags must add
  -- one review count and still contribute its payable-shaped duration.
  v_person := pg_temp.dry_run_pick('installer');
  v_qa_foreman := pg_temp.dry_run_pick('foreman');
  insert into public.time_shifts(id, profile_id, project_id, clock_in_at, clock_out_at,
    break_seconds, status, review_reason, time_confirmed)
  values (v_flagged_id, v_person, v_job, now() - interval '2 hours', now() - interval '30 minutes',
    0, 'submitted', 'clock_unchecked', false);
  select count(*) into v_before from public.time_shifts where project_id = v_job;
  select coalesce(sum(greatest(0, extract(epoch from (clock_out_at-clock_in_at)) - break_seconds)/3600),0)
    into v_expected from public.time_shifts
    where project_id = v_job and status in ('submitted','approved') and clock_out_at is not null;

  foreach v_role in array array['installer','foreman','supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    -- No current supervisor login exists. Exercise that real SQL role using
    -- only the QA foreman, temporarily promoted inside the forced rollback.
    if v_role = 'supervisor' then
      update public.profiles set role = 'supervisor' where id = v_qa_foreman;
      v_person := v_qa_foreman;
    else
      v_person := pg_temp.dry_run_pick(v_role);
    end if;
    v_actual_role := pg_temp.dry_run_act_as(v_person);
    perform pg_temp.dry_run_check('crew goal ' || v_role || ' uses authenticated role and selected login',
      current_user = 'authenticated' and auth.uid() = v_person and v_actual_role = v_role,
      'authenticated role and profile checked');
    select public.crew_goal_summary(v_job) into v_result;
    perform pg_temp.dry_run_check('crew goal ' || v_role || ' matches approved source and complete paid time',
      (v_result->>'goal_hours')::numeric = v_goal and (v_result->>'recorded_hours')::numeric = v_expected
      and (v_result->>'as_of') is not null and (v_result->>'goal_revision') is not null,
      'aggregate and revision checked');
    perform pg_temp.dry_run_check('crew goal ' || v_role || ' counts flagged submitted time once',
      (v_result->>'unresolved_shifts')::bigint = v_unresolved_before + 1,
      'two flags on one closed row count once');
    perform pg_temp.dry_run_check('crew goal ' || v_role || ' exposes only safe aggregate fields',
      (select count(*) = 9 from jsonb_object_keys(v_result))
      and not (v_result ?| array['profile_id','display_name','rate','cost','time_shifts','updated_by']),
      '9 keys, no private rows or rates');
    if v_role = 'supervisor' then
      perform pg_temp.dry_run_as_system();
      update public.profiles set role = 'foreman' where id = v_qa_foreman;
    end if;
  end loop;

  perform pg_temp.dry_run_as_system();
  select id into v_partner from public.profiles where is_partner is true and retired_at is null and access_revoked_at is null order by id limit 1;
  if v_partner is null then
    -- A QA-only partner fixture is also rolled back; never change an employee.
    v_partner := v_qa_foreman;
    v_partner_fixture := true;
    update public.profiles set is_partner = true where id = v_partner;
  end if;
  v_actual_role := pg_temp.dry_run_act_as(v_partner);
  perform pg_temp.dry_run_check('partner denial uses selected authenticated login',
    current_user = 'authenticated' and auth.uid() = v_partner,
    'authenticated partner fixture checked');
  perform pg_temp.dry_run_expect_error('partner cannot read crew goal',
    format('select public.crew_goal_summary(%L::uuid)', v_job), 'unavailable');

  perform pg_temp.dry_run_as_system();
  if v_partner_fixture then update public.profiles set is_partner = false where id = v_partner; end if;
  select count(*) into v_after from public.time_shifts where project_id = v_job;
  perform pg_temp.dry_run_check('goal reads did not change job clock rows', v_after = v_before, 'row count unchanged');
end $$;
