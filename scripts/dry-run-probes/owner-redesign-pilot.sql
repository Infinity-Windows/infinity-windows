-- Rolled-back production-shape rehearsal for the one-account design pilot.
-- No job, shift, grant, or choice survives scripts/db-dry-run.sh.
do $$
declare
  v_owner uuid;
  v_installer uuid;
  v_foreman uuid;
  v_role text;
  v_before text;
  v_after text;
  v_other_owner uuid;
begin
  perform pg_temp.dry_run_as_system();
  select u.id into v_owner from auth.users u join public.profiles p on p.id=u.id
    where lower(u.email)='isaac@forgewd.com' and p.role='owner'
      and p.access_revoked_at is null and p.retired_at is null;
  if v_owner is null then
    raise exception 'dry run: the owner pilot account is missing or inactive';
  end if;
  v_installer := pg_temp.dry_run_pick('installer');
  v_foreman := pg_temp.dry_run_pick('foreman');
  select p.id into v_other_owner from public.profiles p
    where p.role='owner' and p.id<>v_owner
      and p.access_revoked_at is null and p.retired_at is null
    order by p.id limit 1;
  perform pg_temp.dry_run_check('migration alone activates no pilot account',
    not exists (select 1 from public.redesign_pilot_accounts where enabled), null);
  insert into public.redesign_pilot_accounts(profile_id,enabled)
  values(v_owner,true) on conflict(profile_id) do update set enabled=true;
  perform pg_temp.dry_run_check('pilot table is private',
    not has_table_privilege('authenticated','public.redesign_pilot_accounts','SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon','public.redesign_pilot_accounts','SELECT,INSERT,UPDATE,DELETE'), null);
  perform pg_temp.dry_run_check('crew-wide master is off',
    (select not new_design_r1_enabled from public.company_settings where id=1), null);

  v_role := pg_temp.dry_run_act_as(v_installer);
  select ui_design into v_before from public.profiles where id=v_installer;
  perform pg_temp.dry_run_check('installer has no pilot admission',
    not public.my_redesign_pilot_access(), null);
  perform pg_temp.dry_run_expect_error('installer cannot choose new design',
    'select public.set_my_ui_design(''new'')', 'pilot account');
  select ui_design into v_after from public.profiles where id=v_installer;
  perform pg_temp.dry_run_check('installer choice was preserved',
    v_after is not distinct from v_before, null);
  perform pg_temp.dry_run_as_system();

  v_role := pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_check('foreman has no pilot admission',
    not public.my_redesign_pilot_access(), null);
  perform pg_temp.dry_run_expect_error('foreman cannot choose new design',
    'select public.set_my_ui_design(''new'')', 'pilot account');
  perform pg_temp.dry_run_as_system();

  if v_other_owner is not null then
    v_role := pg_temp.dry_run_act_as(v_other_owner);
    perform pg_temp.dry_run_check('another owner has no pilot admission',
      not public.my_redesign_pilot_access(), null);
    perform pg_temp.dry_run_expect_error('another owner cannot choose new design',
      'select public.set_my_ui_design(''new'')', 'pilot account');
    perform pg_temp.dry_run_as_system();
  end if;

  v_role := pg_temp.dry_run_act_as(v_owner);
  perform pg_temp.dry_run_check('admitted owner is the real signed-in account',
    v_role='owner' and auth.uid()=v_owner and public.my_redesign_pilot_access(), null);
  perform public.set_my_ui_design('new');
  select ui_design into v_after from public.profiles where id=v_owner;
  perform pg_temp.dry_run_check('owner can choose new design',v_after='new',null);
  perform pg_temp.dry_run_expect_error('old owner client cannot release to crew',
    'select public.set_new_design_switch(''r1'',true)', 'held for owner review');
  perform public.set_my_ui_design('classic');
  perform pg_temp.dry_run_as_system();
end $$;
