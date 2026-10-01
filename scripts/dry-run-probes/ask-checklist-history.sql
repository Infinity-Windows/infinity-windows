-- The real harness rolls this announcement and all synthetic records back.
do $$
declare
  actor uuid; original_role text; n int; i int;
  role_names text[] := array['installer','foreman','supervisor','owner'];
begin
  perform pg_temp.dry_run_as_system();
  -- As in monday-import-status.sql, use only the QA foreman for ranks that
  -- have no real account. Restore its original role as well as rolling back.
  actor := pg_temp.dry_run_pick('foreman');
  select role into original_role from public.profiles where id=actor;
  select count(*) into n from public.app_release_notes
    where id='2026-10-01-ask-saved-history' and audience=array[0,1,2,3]
      and published_on='2026-10-01' and kind='fix';
  perform pg_temp.dry_run_check('saved-history note has the exact crew audience and date',n=1,n || ' rows');
  for i in 1..4 loop
    update public.profiles set role=role_names[i] where id=actor;
    perform pg_temp.dry_run_act_as(actor);
    perform pg_temp.dry_run_check(role_names[i] || ' QA audience rank is active',
      public.my_role_rank()=i-1,public.my_role_rank()::text);
    select count(*) into n from public.app_release_notes
      where id='2026-10-01-ask-saved-history' and href='/ask'
      and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0;
    perform pg_temp.dry_run_check(role_names[i] || ' sees the bilingual saved-history announcement',n=1,n || ' rows');
    perform pg_temp.dry_run_as_system();
  end loop;
  update public.profiles set role=original_role where id=actor;
end $$;
