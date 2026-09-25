-- PR #655: two crew notes (docs/app-updates.md). Read them as the system to
-- prove they were stored exactly as written, then through row security as the
-- QA installer and the QA foreman: the same read the "What's new" popup makes.
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
   where id in ('2026-09-25-unit-complete', '2026-09-25-weak-signal-screen')
     and audience = array[0,1,2,3] and kind = 'fix'
     and published_on = date '2026-09-25' and withdrawn_at is null and href is null
     and length(title_en) > 0 and length(body_en) > 0
     and length(title_es) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('both notes stored as written', v_n = 2,
    format('expected 2 rows for all four roles, got %s', v_n));

  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes
   where id in ('2026-09-25-unit-complete', '2026-09-25-weak-signal-screen');
  perform pg_temp.dry_run_check('the QA installer reads both', v_n = 2,
    format('expected 2, got %s', v_n));

  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes
   where id in ('2026-09-25-unit-complete', '2026-09-25-weak-signal-screen');
  perform pg_temp.dry_run_check('the QA foreman reads both', v_n = 2,
    format('expected 2, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;
