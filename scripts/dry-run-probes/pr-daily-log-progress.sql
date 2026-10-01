-- Exercise structured logging and the protected photo path as real QA roles.
-- The harness owns the transaction; all records belong to its sandbox job.
do $$
declare
  v_actor uuid; v_lead uuid; v_job uuid; v_mail text; v_day date; v_rev integer;
  v_log public.daily_logs; v_client uuid := gen_random_uuid(); v_photo uuid;
  v_object_name text; v_storage_path text; v_n integer; v_r text;
begin
  perform pg_temp.dry_run_as_system();
  v_actor := pg_temp.dry_run_pick('installer');
  v_lead := pg_temp.dry_run_pick('foreman');
  v_job := pg_temp.dry_run_sandbox_job();
  select email into v_mail from auth.users where id=v_actor;
  -- Find an unused historical sandbox date instead of overwriting today's log.
  select d::date into v_day from generate_series(current_date-1000,current_date-900,interval '1 day') d
    where not exists(select 1 from public.daily_logs where project_id=v_job and log_date=d::date) limit 1;
  if v_day is null then raise exception 'dry run: no free sandbox log date'; end if;
  v_r := pg_temp.dry_run_act_as(v_actor);
  perform pg_temp.dry_run_check('installer role and identity',current_user='authenticated' and auth.uid()=v_actor and v_r='installer');
  v_log := public.file_daily_log(p_project_id=>v_job,p_log_date=>v_day,p_notes=>'Practice: window progress',
    p_expected_revision=>0,p_progress_provided=>true,p_work_stages=>array['frames','glass'],
    p_stage_progress=>'{"frames":40,"glass":15}',p_units_today=>2,p_units_to_date=>12,
    p_units_remaining=>0,p_units_remaining_detail=>'All scheduled windows complete');
  perform pg_temp.dry_run_check('full snapshot preserves a reported zero',v_log.id is not null and v_log.units_remaining=0 and v_log.units_to_date=12);
  v_log := public.file_daily_log(p_project_id=>v_job,p_log_date=>v_day,p_notes=>'Practice: text-only update',p_expected_revision=>v_log.revision);
  perform pg_temp.dry_run_check('legacy text edit retains progress',v_log.units_remaining=0 and v_log.stage_progress->>'frames'='40');
  v_rev := v_log.revision;
  perform pg_temp.dry_run_expect_error('stale revision is refused',format('select public.file_daily_log(%L::uuid,%L::date,p_notes=>%L,p_expected_revision=>0)',v_job,v_day,'Stale edit'),'changed');
  perform pg_temp.dry_run_expect_error('numeric-string stage is refused',format('select public.file_daily_log(%L::uuid,%L::date,p_notes=>%L,p_expected_revision=>%s,p_progress_provided=>true,p_stage_progress=>%L::jsonb)',v_job,v_day,'Bad stage',v_rev,'{"frames":"50"}'),'0-100');
  perform pg_temp.dry_run_expect_error('negative unit count is refused',format('select public.file_daily_log(%L::uuid,%L::date,p_notes=>%L,p_expected_revision=>%s,p_progress_provided=>true,p_units_remaining=>-1)',v_job,v_day,'Bad units',v_rev),'negative');
  v_log := public.file_daily_log(p_project_id=>v_job,p_log_date=>v_day,p_notes=>'Practice: deliberately clear',p_expected_revision=>v_rev,p_progress_provided=>true);
  perform pg_temp.dry_run_check('explicit snapshot can clear counts to unknown',v_log.units_remaining is null and v_log.units_to_date is null);

  v_object_name := v_job::text||'/daily-logs/'||v_log.id::text||'/'||v_actor::text||'/'||v_client::text||'.jpg';
  v_storage_path := 'install-media/'||v_object_name;
  perform pg_temp.dry_run_check('namespace parser invoked',public._is_daily_log_photo_name(v_object_name));
  perform pg_temp.dry_run_check('active internal photo actor invoked',public._daily_log_photo_actor());
  perform pg_temp.dry_run_check('provider preflight may precede final size',public._daily_log_photo_upload_allowed(v_object_name,v_actor::text,'{"mimetype":"image/jpeg","contentLength":5}'));
  perform pg_temp.dry_run_check('final object metadata predicate invoked',public._daily_log_photo_metadata_valid('{"mimetype":"image/jpeg","size":5}') and not public._daily_log_photo_metadata_valid('{"mimetype":"image/jpeg","contentLength":5}'));
  -- This is SQL metadata only, never an actual object upload or byte claim.
  insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
    values('install-media',v_object_name,v_actor,v_actor::text,'{"mimetype":"image/jpeg","contentLength":5}');
  perform pg_temp.dry_run_expect_error('unfinished provider object cannot attach',format('insert into public.attachments(client_id,project_id,daily_log_id,kind,storage_path,created_by) values(%L,%L,%L,%L,%L,%L)',v_client,v_job,v_log.id,'photo',v_storage_path,v_mail),'original JPEG');
  -- Leave the unfinished synthetic row unassociated. Everything is discarded.
  perform pg_temp.dry_run_as_system();
  -- A different final upload identity represents the successful completion.
  v_client := gen_random_uuid();
  v_object_name := v_job::text||'/daily-logs/'||v_log.id::text||'/'||v_actor::text||'/'||v_client::text||'.jpg';
  v_storage_path := 'install-media/'||v_object_name;
  insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
    values('install-media',v_object_name,v_actor,v_actor::text,'{"mimetype":"image/jpeg","size":5}');
  perform pg_temp.dry_run_act_as(v_actor);
  insert into public.attachments(client_id,project_id,daily_log_id,kind,storage_path,created_by)
    values(v_client,v_job,v_log.id,'photo',v_storage_path,v_mail) returning id into v_photo;
  perform pg_temp.dry_run_check('completed own JPEG associates under actual policies',v_photo is not null);
  update public.attachments set caption=caption where id=v_photo;
  get diagnostics v_n=row_count;
  perform pg_temp.dry_run_check('exact own retry preserves identity',v_n=1);
  perform pg_temp.dry_run_expect_error('association cannot be removed',format('update public.attachments set daily_log_id=null where id=%L',v_photo),'retain');
  perform pg_temp.dry_run_expect_error('photo identity cannot be replaced',format('update public.attachments set client_id=gen_random_uuid() where id=%L',v_photo),'identity');
  perform pg_temp.dry_run_expect_error('untagged protected-path alias refused',format('insert into public.attachments(project_id,kind,storage_path,created_by) values(%L,%L,%L,%L)',v_job,'photo',v_storage_path,v_mail),'retain');
  perform pg_temp.dry_run_expect_error('direct photo deletion refused',format('delete from public.attachments where id=%L',v_photo),'recoverable');
  update storage.objects set metadata='{"mimetype":"image/jpeg","size":1}' where bucket_id='install-media' and name=v_object_name;
  get diagnostics v_n=row_count;
  perform pg_temp.dry_run_check('client cannot overwrite protected Storage object',v_n=0);
  -- Hosted Storage has its own statement-level delete protection. Exercise
  -- that real refusal without disabling it or changing provider settings.
  perform pg_temp.dry_run_expect_error('client protected Storage delete is refused',format('delete from storage.objects where bucket_id=%L and name=%L','install-media',v_object_name));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_expect_error('privileged completion cannot replace protected object',format('update storage.objects set metadata=%L::jsonb where bucket_id=%L and name=%L','{"mimetype":"image/jpeg","size":1}','install-media',v_object_name),'replaced');
  perform pg_temp.dry_run_expect_error('backend cleanup cannot delete original association',format('delete from storage.objects where bucket_id=%L and name=%L','install-media',v_object_name));
  perform pg_temp.dry_run_act_as(v_lead);
  perform public.soft_delete_job_photo(v_photo);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('authorized photo trash retains log identity',(select daily_log_id=v_log.id and deleted_at is not null from public.attachments where id=v_photo));
  perform pg_temp.dry_run_act_as(v_lead);
  perform public.restore_job_photo(v_photo);
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('authorized restore retains photo identity',(select daily_log_id=v_log.id and deleted_at is null and client_id=v_client from public.attachments where id=v_photo));
  perform pg_temp.dry_run_check('global sweep is still unavailable to authenticated',not has_function_privilege('authenticated','public.purge_expired_job_photos()','execute'));
  -- No global sweep: it could inspect unrelated live jobs even in this batch.
end $$;
