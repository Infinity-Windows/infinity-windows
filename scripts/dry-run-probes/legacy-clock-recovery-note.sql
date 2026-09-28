-- The legacy-clock recovery announcement (docs/app-updates.md). The harness
-- applies the new migration inside a transaction that it always rolls back.
-- Check the stored note and read visibility through installer and foreman RLS.
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
   where id = '2026-09-28-legacy-clock-recovery'
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-28' and withdrawn_at is null and href = '/stuck'
     and length(title_en) > 0 and length(body_en) > 0
     and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the legacy-clock note is stored for all four roles', v_n = 1,
    format('expected 1 row, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-28-legacy-clock-recovery';
  perform pg_temp.dry_run_check('the QA installer reads the legacy-clock note', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-28-legacy-clock-recovery';
  perform pg_temp.dry_run_check('the QA foreman reads the legacy-clock note', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;
