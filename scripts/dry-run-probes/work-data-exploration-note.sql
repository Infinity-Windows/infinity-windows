-- Announcement only. The candidate migration and all probe work are rolled back.
-- Use existing accounts only for role-filtered read checks; never alter profiles.
do $$
declare
  v_installer uuid;
  v_foreman uuid;
  v_owner uuid;
  v_n integer;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_owner := pg_temp.dry_run_pick_real('owner');
  select count(*) into v_n from public.app_release_notes
    where id='2026-10-04-work-data-exploration' and published_on=date '2026-10-04'
      and audience=array[2,3] and kind='improvement' and withdrawn_at is null and href='/data'
      and length(title_en)>0 and length(title_es)>0 and length(body_en)>0 and length(body_es)>0;
  perform pg_temp.dry_run_check('Data exploration note has bilingual supervisor/owner content',v_n=1,format('matching rows %s',v_n));
  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into v_n from public.app_release_notes where id='2026-10-04-work-data-exploration';
  perform pg_temp.dry_run_check('installer cannot read supervisor/owner Data note',v_n=0,format('visible rows %s',v_n));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.app_release_notes where id='2026-10-04-work-data-exploration';
  perform pg_temp.dry_run_check('foreman cannot read supervisor/owner Data note',v_n=0,format('visible rows %s',v_n));
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_act_as(v_owner);
  select count(*) into v_n from public.app_release_notes where id='2026-10-04-work-data-exploration';
  perform pg_temp.dry_run_check('owner can read shipped Data note',v_n=1,format('visible rows %s',v_n));
  perform pg_temp.dry_run_as_system();
end $$;
