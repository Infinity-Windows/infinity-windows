-- The real harness rolls this announcement and all synthetic records back.
do $$
declare actor uuid; rank_name text; n int;
begin
  foreach rank_name in array array['installer','foreman','supervisor','owner'] loop
    perform pg_temp.dry_run_as_system();
    actor := pg_temp.dry_run_pick_real(rank_name);
    perform pg_temp.dry_run_act_as(actor);
    select count(*) into n from public.app_release_notes
      where id='2026-10-01-ask-saved-history' and href='/ask'
      and length(title_en)>0 and length(title_es)>0
      and length(body_en)>0 and length(body_es)>0;
    perform pg_temp.dry_run_check(rank_name || ' sees the bilingual saved-history announcement',n=1,n || ' rows');
  end loop;
  perform pg_temp.dry_run_as_system();
end $$;
