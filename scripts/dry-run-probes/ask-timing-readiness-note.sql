-- Check the all-crew Ask note on the real schema, then roll it back.
do $$
declare
  v_installer uuid;
  v_count int;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-30-ask-timing-readiness'
     and published_on = date '2026-09-30'
     and audience = array[0,1,2,3]
     and kind = 'improvement' and href = '/ask' and withdrawn_at is null
     and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('Ask timing note is stored for all crew', v_count = 1,
    format('expected one bilingual note, found %s', v_count));
  v_installer := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-30-ask-timing-readiness';
  perform pg_temp.dry_run_check('installer can read Ask timing note', v_count = 1,
    format('expected one visible note, found %s', v_count));
  perform pg_temp.dry_run_as_system();
end $$;
