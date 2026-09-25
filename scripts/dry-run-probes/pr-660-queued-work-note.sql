-- PR #660: one crew note (docs/app-updates.md), in
-- supabase/migrations/20261030080000_queued_work_stays_yours_note.sql. Read it
-- as the system to prove it was stored exactly as written, then through row
-- security as the QA installer and the QA foreman: the same read the "What's
-- new" popup makes.
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
   where id = '2026-09-25-queued-work-stays-yours'
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-25' and withdrawn_at is null and href is null
     and length(title_en) > 0 and length(body_en) > 0
     and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the note is stored as written', v_n = 1,
    format('expected 1 row for all four roles, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-queued-work-stays-yours';
  perform pg_temp.dry_run_check('the QA installer reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-queued-work-stays-yours';
  perform pg_temp.dry_run_check('the QA foreman reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;
