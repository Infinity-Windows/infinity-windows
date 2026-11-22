-- Probe for 20261130190000_new_design_for_everyone.sql (docs/db-dry-run.md).
--
-- Everyone is on the new design, new people start there, and a person can
-- still switch themselves back to classic and forward again from Settings.
do $$
declare
  installer uuid;
begin
  perform pg_temp.dry_run_as_system();
  perform pg_temp.dry_run_check('nobody is left on classic',
    not exists (select 1 from public.profiles where ui_design = 'classic'),
    (select count(*)::text from public.profiles where ui_design = 'classic'));
  perform pg_temp.dry_run_check('a new person starts on the new design',
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'ui_design') like '%new%',
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'ui_design'));
  installer := pg_temp.dry_run_pick('installer');
  perform pg_temp.dry_run_act_as(installer);
  perform public.set_my_ui_design('classic');
  perform pg_temp.dry_run_check('a person can still switch back to classic',
    (select ui_design from public.profiles where id = installer) = 'classic', installer::text);
  perform public.set_my_ui_design('new');
  perform pg_temp.dry_run_check('and forward to the new design again',
    (select ui_design from public.profiles where id = installer) = 'new', installer::text);
end $$;
