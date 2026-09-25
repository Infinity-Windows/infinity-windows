-- Probe for 20261027020000_test_logins_own_folder.sql: a test login may save
-- files in its own folder (toolbox signature, voice memo) but still nowhere
-- on a real job or in another person's folder; real people are unchanged.
-- Storage rows are written as the signed-in role and rolled back with
-- everything else. qa.* logins and job codes only in the output.
-- Run: gh workflow run db-dry-run.yml -f ref=claude/qa-own-folder \
--        -f migrations="supabase/migrations/20261027020000_test_logins_own_folder.sql" \
--        -f probe=scripts/dry-run-probes/test-logins-own-folder.sql
do $$
declare
  v_qa uuid;
  v_real uuid;
  v_sandbox uuid;
  v_sandbox_code text;
  v_real_job uuid;
  v_role text;
  v_ok boolean;
  v_msg text;
begin
  perform pg_temp.dry_run_as_system();
  select u.id into v_qa from auth.users u join public.profiles p on p.id = u.id
   where u.email = 'qa.installer@crew.infinitywindows.app' and coalesce(p.is_test, false);
  if v_qa is null then
    raise exception 'dry run: qa.installer is missing or not flagged as a test login.';
  end if;
  v_real := pg_temp.dry_run_pick_real('installer');
  select p.id, p.job_code into v_sandbox, v_sandbox_code
    from public.sandbox_projects s join public.projects p on p.id = s.project_id
   where p.deleted_at is null and coalesce(p.is_test, false)
   order by (p.job_code = 'PECAN14') desc, p.job_code limit 1;
  select p.id into v_real_job from public.projects p
   where p.deleted_at is null and not coalesce(p.is_test, false) and not public.is_sandbox_project(p.id)
   order by p.created_at desc limit 1;
  perform pg_temp.dry_run_check('setup: a test login, a real installer, the practice job and a real job', v_qa is not null and v_real is not null and v_sandbox is not null and v_real_job is not null, v_sandbox_code);

  -- ---- the test login ----------------------------------------------------------
  v_role := pg_temp.dry_run_act_as(v_qa);
  begin
    insert into storage.objects (bucket_id, name) values ('toolbox-records', v_qa::text || '/dry-run/talk/signature.png');
    v_ok := true; v_msg := 'saved';
  exception when others then v_ok := false; v_msg := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.dry_run_check('test login: saves its toolbox signature in its own folder (the drill blocker)', v_ok, v_msg);
  begin
    insert into storage.objects (bucket_id, name) values ('toolbox-records', v_qa::text || '/dry-run/talk/signed.pdf');
    v_ok := true; v_msg := 'saved';
  exception when others then v_ok := false; v_msg := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.dry_run_check('test login: saves the signed PDF in its own folder', v_ok, v_msg);
  begin
    insert into storage.objects (bucket_id, name) values ('ai-field-memos', v_qa::text || '/00000000-0000-4000-8000-000000000001/memo.webm');
    v_ok := true; v_msg := 'saved';
  exception when others then v_ok := false; v_msg := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.dry_run_check('test login: an Ask voice memo in its own folder (information: the memo bucket has its own crew-login rule)', true, v_msg);
  perform pg_temp.dry_run_expect_error('test login: refused in a real person''s folder',
    format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'toolbox-records', v_real::text || '/dry-run/talk/signature.png'),
    'row-level security');
  perform pg_temp.dry_run_expect_error('test login: refused on a real job''s files',
    format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'install-media', v_real_job::text || '/dry-run/photo.jpg'),
    'row-level security');
  begin
    insert into storage.objects (bucket_id, name) values ('install-media', v_sandbox::text || '/dry-run/photo.jpg');
    v_ok := true; v_msg := 'saved';
  exception when others then v_ok := false; v_msg := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.dry_run_check('test login: still saves on the practice job, as before', v_ok, v_msg);

  -- ---- a real person: unchanged ------------------------------------------------
  v_role := pg_temp.dry_run_act_as(v_real);
  begin
    insert into storage.objects (bucket_id, name) values ('toolbox-records', v_real::text || '/dry-run/talk/signature.png');
    v_ok := true; v_msg := 'saved';
  exception when others then v_ok := false; v_msg := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.dry_run_check('real installer: signs as before', v_ok, v_msg);

  -- ---- the policies on the database are the new ones --------------------------
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('the three test-login storage policies carry the own-folder rule',
    (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'test logins write only their sandbox%'
      and coalesce(with_check, qual) like '%split_part(name%auth.uid()%') = 3, null);
end $$;
