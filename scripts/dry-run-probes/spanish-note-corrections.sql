-- The #639 note's Spanish now quotes the words the screen shows. Read as the
-- system (stored text) and as the QA installer (the popup's read).
do $$
declare
  v_installer uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-unit-photos-send'
     and title_es like '%Todo sincronizado%' and body_es like '%Todo sincronizado%'
     and body_es like '%Envíos atascados%'
     and title_es not like '%All synced%' and body_es not like '%All synced%'
     and body_es not like '%Escrituras atascadas%'
     and title_en like '%All synced%';
  perform pg_temp.dry_run_check('the note quotes the new Spanish words, English unchanged', v_n = 1,
    format('expected 1 corrected row, got %s', v_n));
  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes where id = '2026-09-25-unit-photos-send';
  perform pg_temp.dry_run_check('the QA installer still reads it', v_n = 1, format('expected 1, got %s', v_n));
  perform pg_temp.dry_run_as_system();
end $$;
