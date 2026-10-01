-- Apply the announcement on the real schema, check all audiences, then roll back.
do $$
declare v_person uuid; v_count int; v_role text;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count from public.app_release_notes
   where id = '2026-10-01-receipt-viewer' and published_on = date '2026-10-01'
    and audience = array[0,1,2,3] and kind = 'fix' and href = '/photos'
    and withdrawn_at is null and length(title_en) > 0 and length(title_es) > 0
    and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('receipt viewer note is bilingual and scoped', v_count = 1, format('found %s', v_count));
  foreach v_role in array array['installer','foreman','supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    v_person := pg_temp.dry_run_pick(v_role);
    perform pg_temp.dry_run_act_as(v_person);
    select count(*) into v_count from public.app_release_notes where id = '2026-10-01-receipt-viewer';
    perform pg_temp.dry_run_check(v_role || ' can read receipt viewer note', v_count = 1, format('found %s', v_count));
  end loop;
  perform pg_temp.dry_run_as_system();
end $$;
