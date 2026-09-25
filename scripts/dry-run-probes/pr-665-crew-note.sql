-- PR #665: one crew note (docs/app-updates.md) for the toolbox talk signing
-- fix. Read it as the system to prove it was stored exactly as written, then
-- through row security as the QA installer and the QA foreman: the same read
-- the "What's new" popup makes.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');

  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-toolbox-signing'
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-25' and withdrawn_at is null and href = '/safety'
     and title_en = 'Signing a toolbox talk no longer fails on days whose talk has Do and Don''t lists'
     and title_es = 'Firmar la charla de seguridad ya no falla los días en que la charla trae listas Do y Don''t'
     and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the note is stored as written', v_n = 1,
    format('expected 1 row for all four roles, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-toolbox-signing';
  perform pg_temp.dry_run_check('the QA installer reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-toolbox-signing';
  perform pg_temp.dry_run_check('the QA foreman reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;
