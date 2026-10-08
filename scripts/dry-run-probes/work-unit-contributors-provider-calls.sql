-- Actual owner and sandbox/missing identities only; no accepted work writes.
do $contributors_provider$
declare actor uuid;job uuid;missing_job uuid:=gen_random_uuid();missing_unit uuid:=gen_random_uuid();v jsonb;
 before_commands bigint;before_events bigint;invalid_rejected boolean:=false;
 unavailable constant jsonb:='{"protocolVersion":1,"availability":"unavailable","contributors":null}';
begin
 perform pg_temp.dry_run_as_system();
 actor:=pg_temp.dry_run_pick_real('owner');job:=pg_temp.dry_run_sandbox_job();
 if exists(select 1 from public.projects where id=missing_job)
 or exists(select 1 from public.custom_work_units where id=missing_unit) then
 raise exception 'dry run: missing contributor identity unexpectedly exists';end if;
 select count(*) into before_commands from public.work_unit_review_commands;
 select count(*) into before_events from public.work_unit_review_events;
 perform pg_temp.dry_run_act_as(actor);
 perform pg_temp.dry_run_check('provider/contributorsActualCaller',current_user='authenticated' and auth.uid()=actor,'Actual owner caller context');
 v:=public.work_unit_contributors_read(job,missing_unit,1);
 perform pg_temp.dry_run_check('provider/contributorsMissingUnitHidden',v=unavailable,'No absent-unit person names, hours or counts');
 v:=public.work_unit_contributors_read(missing_job,missing_unit,1);
 perform pg_temp.dry_run_check('provider/contributorsMissingJobHidden',v=unavailable,'No absent-job person names, hours or counts');
 begin
 perform public.work_unit_contributors_read(job,missing_unit,2);
 exception when check_violation then invalid_rejected:=true;
 end;
 perform pg_temp.dry_run_check('provider/contributorsInvalidProtocolRefused',invalid_rejected,'No unsupported wire protocol');
 perform pg_temp.dry_run_as_system();
 perform pg_temp.dry_run_check('provider/contributorsNoReviewDecisionWritten',
 (select count(*) from public.work_unit_review_commands)=before_commands
 and (select count(*) from public.work_unit_review_events)=before_events,'Reads create no review decisions');
end; $contributors_provider$;
