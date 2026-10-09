-- Actual caller and sandbox/missing scopes only. No accepted field/payroll/QC writes.
do $totals_provider$
declare actor uuid; job uuid; missing_job uuid:=gen_random_uuid(); missing_unit uuid:=gen_random_uuid(); v jsonb;
 before_commands bigint; before_events bigint;
begin
 perform pg_temp.dry_run_as_system();
 actor:=pg_temp.dry_run_pick_real('owner');job:=pg_temp.dry_run_sandbox_job();
 if exists(select 1 from public.projects where id=missing_job)
 or exists(select 1 from public.custom_work_units where id=missing_unit) then
 raise exception 'dry run: missing totals identity unexpectedly exists';end if;
 select count(*) into before_commands from public.work_unit_review_commands;
 select count(*) into before_events from public.work_unit_review_events;
 perform pg_temp.dry_run_act_as(actor);
 perform pg_temp.dry_run_check('provider/totalsActualCaller',current_user='authenticated' and auth.uid()=actor,'Actual owner login context');
 v:=public.work_activity_totals_read(job,null);
 perform pg_temp.dry_run_check('provider/totalsSandboxGeneralRead',(v->>'protocolVersion')::integer=1
 and ((v->>'availability'='unavailable' and v->'totals'='null'::jsonb)
 or (v->>'availability'='available' and v#>>'{totals,projectId}'=job::text
 and v#>>'{totals,actorId}'=actor::text and v#>'{totals,unitId}'='null'::jsonb
 and v#>'{totals,cohort}'=jsonb_build_object('availability','unavailable','reason','unit_selection_required'))),
 'Real sandbox read, no casual unit or area denominator');
 v:=public.work_activity_totals_read(missing_job,null);
 perform pg_temp.dry_run_check('provider/totalsMissingJobHidden',v=jsonb_build_object('protocolVersion',1,'availability','unavailable','totals',null),'No absent-job identity or payroll counts');
 v:=public.work_activity_totals_read(job,missing_unit);
 perform pg_temp.dry_run_check('provider/totalsMissingUnitHidden',v=jsonb_build_object('protocolVersion',1,'availability','unavailable','totals',null),'No absent-unit identity or source digest');
 perform pg_temp.dry_run_as_system();
 perform pg_temp.dry_run_check('provider/totalsNoReviewDecisionWritten',
 (select count(*) from public.work_unit_review_commands)=before_commands
 and (select count(*) from public.work_unit_review_events)=before_events,'Totals reads create no review decisions');
end; $totals_provider$;
