-- PR #682: validate the all-crew loading note on the real schema, then roll back.
do $$
declare
  v_person uuid;
  v_count int;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-28-faster-first-open'
     and published_on = date '2026-09-28'
     and audience = array[0,1,2,3]
     and kind = 'improvement'
     and href is null and withdrawn_at is null
     and title_en = 'Smaller first download'
     and title_es = 'Descarga inicial más pequeña'
     and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('loading note is stored as written', v_count = 1,
    format('expected one bilingual note, found %s', v_count));

  v_person := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_act_as(v_person);
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-28-faster-first-open';
  perform pg_temp.dry_run_check('installer can read loading note', v_count = 1,
    format('expected one visible note, found %s', v_count));

  perform pg_temp.dry_run_as_system();
  v_person := pg_temp.dry_run_pick('foreman');
  perform pg_temp.dry_run_act_as(v_person);
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-28-faster-first-open';
  perform pg_temp.dry_run_check('foreman can read loading note', v_count = 1,
    format('expected one visible note, found %s', v_count));
  perform pg_temp.dry_run_as_system();
end $$;
