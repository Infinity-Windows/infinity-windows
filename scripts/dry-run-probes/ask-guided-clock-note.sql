-- Confirm the bilingual crew note can be read through row security.
do $$
declare
  v_person uuid;
  v_count int;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-30-ask-guided-clock'
     and published_on = date '2026-09-30'
     and audience = array[0,1,2,3]
     and kind = 'improvement' and href = '/ask'
     and withdrawn_at is null
     and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('guided clock note is stored for all crew', v_count = 1,
    format('expected one bilingual note, found %s', v_count));

  v_person := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_act_as(v_person);
  select count(*) into v_count from public.app_release_notes
   where id = '2026-09-30-ask-guided-clock';
  perform pg_temp.dry_run_check('installer can read guided clock note', v_count = 1,
    format('expected one visible note, found %s', v_count));
  perform pg_temp.dry_run_as_system();
end $$;
