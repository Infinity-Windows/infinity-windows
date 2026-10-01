-- Metadata-only announcement; harness owns the transaction and discards it.
do $$
declare
  v_roles text[] := array['installer','foreman','supervisor','owner'];
  v_people uuid[] := array[]::uuid[];
  v_i int;
  v_n int;
  v_id text := '2026-09-30-monday-file-status';
begin
  perform pg_temp.dry_run_as_system();
  for v_i in 1..4 loop
    v_people := array_append(v_people, pg_temp.dry_run_pick(v_roles[v_i]));
  end loop;
  select count(*) into v_n from public.app_release_notes
    where id = v_id and audience = array[1,2,3] and published_on = '2026-09-30'
      and kind = 'improvement' and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0 and href='/projects';
  perform pg_temp.dry_run_check('plans import note has bilingual copy and exact audience', v_n=1, v_n || ' matching rows');
  for v_i in 1..4 loop
    perform pg_temp.dry_run_act_as(v_people[v_i]);
    select count(*) into v_n from public.app_release_notes where id=v_id;
    perform pg_temp.dry_run_check(v_roles[v_i] || ' sees the correct plans import note audience',
      v_n = case when v_i=1 then 0 else 1 end, v_n || ' visible rows');
    perform pg_temp.dry_run_as_system();
  end loop;
end $$;
