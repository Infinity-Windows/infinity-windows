-- Announcements only: exercise the existing role filter, then roll back both rows.
do $$
declare v_installer uuid; v_owner uuid; n int;
begin
  perform pg_temp.dry_run_as_system();
  v_installer := pg_temp.dry_run_pick('installer');
  v_owner := pg_temp.dry_run_pick_real('owner');
  perform pg_temp.dry_run_act_as(v_installer);
  select count(*) into n from public.app_release_notes where id = '2026-10-01-searchable-supply-jobs';
  perform pg_temp.dry_run_check('installer sees supplies dropdown announcement', n = 1, n || ' row(s)');
  select count(*) into n from public.app_release_notes where id = '2026-10-01-searchable-costing-jobs';
  perform pg_temp.dry_run_check('installer does not see owner costing announcement', n = 0, n || ' row(s)');
  perform pg_temp.dry_run_act_as(v_owner);
  select count(*) into n from public.app_release_notes where id in ('2026-10-01-searchable-supply-jobs', '2026-10-01-searchable-costing-jobs');
  perform pg_temp.dry_run_check('owner sees both dropdown announcements', n = 2, n || ' row(s)');
  perform pg_temp.dry_run_as_system();
end $$;
