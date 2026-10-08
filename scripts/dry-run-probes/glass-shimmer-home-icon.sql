-- QA profiles only, no business job writes; outer harness forces rollback.
do $$
declare v_uid uuid; v_original text; v_role text; v_note jsonb; v_after jsonb; v_count int;
begin
 perform pg_temp.dry_run_as_system();
 v_uid:=pg_temp.dry_run_pick('foreman');
 select role into v_original from public.profiles where id=v_uid and is_test is true;
 if v_original is null then raise exception 'Refuses non-QA profile'; end if;
 select to_jsonb(n) into v_note from public.app_release_notes n where id='2026-10-08-glass-shimmer-icon';
 perform pg_temp.dry_run_check('icon note has today and all crew roles',v_note->>'published_on'='2026-10-08' and v_note->'audience'='[0,1,2,3]'::jsonb);
 perform pg_temp.dry_run_check('both languages explain saved app icon',v_note->>'title_en' like '%Home Screen%' and v_note->>'title_es' like '%pantalla de inicio%' and v_note->>'body_en' like '%Existing Home Screen icons%' and length(v_note->>'body_es')>0);
 foreach v_role in array array['installer','foreman','supervisor','owner'] loop
  perform pg_temp.dry_run_as_system();
  update public.profiles set role=v_role where id=v_uid and is_test is true;
  perform pg_temp.dry_run_act_as(v_uid);
  select count(*) into v_count from public.app_release_notes where id='2026-10-08-glass-shimmer-icon';
  perform pg_temp.dry_run_check(v_role||' sees the icon announcement',v_count=1);
  perform pg_temp.dry_run_expect_error(v_role||' cannot edit announcement', 'update public.app_release_notes set title_en=''changed'' where id=''2026-10-08-glass-shimmer-icon''','permission denied');
 end loop;
 perform pg_temp.dry_run_as_system();
 update public.profiles set role=v_original where id=v_uid and is_test is true;
 perform pg_temp.dry_run_check('QA original role restored',(select role=v_original from public.profiles where id=v_uid));
 insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es)
 values('2026-10-08-glass-shimmer-icon',date '2026-10-08',array[0],'improvement','changed','changed','changed','changed') on conflict(id) do nothing;
 select to_jsonb(n) into v_after from public.app_release_notes n where id='2026-10-08-glass-shimmer-icon';
 perform pg_temp.dry_run_check('idempotent migration preserves original note',v_after=v_note);
end $$;
