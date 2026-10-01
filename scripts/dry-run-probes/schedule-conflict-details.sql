-- Metadata-only announcement; harness owns the transaction and discards it.
do $$
declare
  v_roles text[] := array['installer','foreman','supervisor','owner'];
  v_person uuid;
  v_original_role text;
  v_i int;
  v_n int;
  v_id text := '2026-09-30-schedule-conflict-details';
begin
  perform pg_temp.dry_run_as_system();
  -- Only the QA foreman is temporarily assigned each rank. Some ranks have
  -- no real account; no employee account or business record is changed.
  -- The harness discards every change and the original role is restored too.
  v_person := pg_temp.dry_run_pick('foreman');
  select role into v_original_role from public.profiles where id=v_person;
  select count(*) into v_n from public.app_release_notes
    where id = v_id and audience = array[1,2,3] and published_on = '2026-09-30'
      and kind = 'fix' and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0 and href='/scheduling';
  perform pg_temp.dry_run_check('schedule conflict details note has bilingual copy and exact audience', v_n=1, v_n || ' matching rows');
  for v_i in 1..4 loop
    update public.profiles set role=v_roles[v_i] where id=v_person;
    perform pg_temp.dry_run_act_as(v_person);
    perform pg_temp.dry_run_check(v_roles[v_i] || ' QA audience rank is active',
      public.my_role_rank() = v_i-1, public.my_role_rank()::text);
    select count(*) into v_n from public.app_release_notes where id=v_id;
    perform pg_temp.dry_run_check(v_roles[v_i] || ' sees the correct schedule conflict details note audience',
      v_n = case when v_i=1 then 0 else 1 end, v_n || ' visible rows');
    perform pg_temp.dry_run_as_system();
  end loop;
  update public.profiles set role=v_original_role where id=v_person;
end $$;
