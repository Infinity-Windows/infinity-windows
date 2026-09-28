-- PR #668: one crew note (docs/app-updates.md) for setting your own PIN in
-- Settings. Read it as the system to prove it was stored exactly as written,
-- then through row security as the QA installer and the QA foreman: the same
-- read the "What's new" popup makes, for the two roles who could not reach the
-- PIN setting before.
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
   where id = '2026-09-25-pin-setting'
     and audience = array[0,1,2,3] and kind = 'improvement'
     and published_on = date '2026-09-25' and withdrawn_at is null and href = '/settings'
     and title_en = 'Set or change your Forge PIN in Settings'
     and title_es = 'Pon o cambia tu PIN de Forge en Ajustes'
     and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the note is stored as written', v_n = 1,
    format('expected 1 row for all four roles, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-pin-setting';
  perform pg_temp.dry_run_check('the QA installer reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-25-pin-setting';
  perform pg_temp.dry_run_check('the QA foreman reads it', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;
