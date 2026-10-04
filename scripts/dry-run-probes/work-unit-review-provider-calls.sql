-- Real authenticated caller, sandbox-bound read, and missing identities only.
-- No accepted review, defect, verification, employee or payroll write is made.
do $review_provider$
declare actor uuid; job uuid; unit_id uuid; missing_unit uuid:=gen_random_uuid();
 missing_command uuid:=gen_random_uuid(); missing_fact uuid:=gen_random_uuid();
 v jsonb; payload jsonb; before_commands bigint; before_events bigint;
begin
 perform pg_temp.dry_run_as_system();
 actor:=pg_temp.dry_run_pick_real('owner'); job:=pg_temp.dry_run_sandbox_job();
 select id into unit_id from public.custom_work_units where project_id=job order by id limit 1;
 if exists(select 1 from public.custom_work_units where id=missing_unit)
 or exists(select 1 from public.work_unit_review_commands where command_id=missing_command) then
 raise exception 'dry run: missing synthetic review identity unexpectedly exists';end if;
 select count(*) into before_commands from public.work_unit_review_commands;
 select count(*) into before_events from public.work_unit_review_events;
 perform pg_temp.dry_run_act_as(actor);
 perform pg_temp.dry_run_check('provider/reviewActualCaller',current_user='authenticated' and auth.uid()=actor,'Actual owner login context');
 v:=public.work_unit_review_read(coalesce(unit_id,missing_unit));
 perform pg_temp.dry_run_check('provider/reviewSandboxRead',(v->>'protocolVersion')::integer=1
 and ((v->>'availability'='unavailable' and v->'review'='null'::jsonb)
 or (v->>'availability'='available' and coalesce((v#>>'{review,qc,qcAccepted}')::boolean,false)=false)),
 'Existing legacy sandbox work cannot acquire accepted QC from a read');
 v:=public.work_unit_review_read(missing_unit);
 perform pg_temp.dry_run_check('provider/reviewMissingUnitHidden',v->>'availability'='unavailable' and v->'review'='null'::jsonb,'No identity, digest or counts for absent unit');
 v:=public.work_unit_review_command_receipt(missing_command);
 perform pg_temp.dry_run_check('provider/reviewMissingReceiptHidden',v=jsonb_build_object('protocolVersion',1,'availability','unavailable','receipt',null),'Missing receipt is not non-delivery proof');
 payload:=jsonb_build_object('action','submit','basis',jsonb_build_object(
 'unitId',missing_unit,'unitRevision',0,'factId',missing_fact,'factRevision',1,
 'scopeToken','ur1:'||repeat('0',64),'reviewRevision',0,'submissionId',null,'generation',0),'data',jsonb_build_object('note',null));
 perform pg_temp.dry_run_expect_error('provider/reviewMissingUnitCommandRefused',
 format('select public.work_unit_review_command(%L::uuid,1,%L::jsonb)',missing_command,payload::text),'Unit review is unavailable.');
 perform pg_temp.dry_run_expect_error('provider/reviewMissingUnitCancelRefused',
 format('select public.work_unit_review_cancel(%L::uuid,1,%L::jsonb)',missing_command,payload::text),'Unit review is unavailable.');
 perform pg_temp.dry_run_as_system();
 perform pg_temp.dry_run_check('provider/reviewNoDecisionWritten',
 (select count(*) from public.work_unit_review_commands)=before_commands
 and (select count(*) from public.work_unit_review_events)=before_events,
 'Read-only checks and refused missing-unit command and cancellation preserve review records');
end; $review_provider$;
