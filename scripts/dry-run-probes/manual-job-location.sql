-- Exercised only inside db-dry-run's forced outer rollback. All project writes
-- target the dynamically selected QA sandbox; only QA profile flags are changed.
do $$
declare
  v_job uuid;
  v_foreman uuid;
  v_installer uuid;
  v_original_role text;
  v_original_active boolean;
  v_original_partner boolean;
  v_original_revoked timestamptz;
  v_original_retired timestamptz;
  v_original_deleted timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_address text;
  v_lat double precision;
  v_lon double precision;
  v_original_address text;
  v_original_lat double precision;
  v_original_lon double precision;
  v_role text;
  v_count integer;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_installer := pg_temp.dry_run_pick('installer');
  v_job := pg_temp.dry_run_sandbox_job();
  select role, active, is_partner, access_revoked_at, retired_at
    into v_original_role, v_original_active, v_original_partner, v_original_revoked, v_original_retired
    from public.profiles where id = v_foreman and is_test is true;
  if v_original_role is null then raise exception 'dry run: QA foreman profile unavailable'; end if;
  select address, latitude, longitude, deleted_at, to_jsonb(p) - 'address' - 'latitude' - 'longitude'
    into v_address, v_lat, v_lon, v_original_deleted, v_before from public.projects p where id = v_job;
  if not found then raise exception 'dry run: QA sandbox job unavailable'; end if;
  v_original_address := v_address;
  v_original_lat := v_lat;
  v_original_lon := v_lon;

  perform pg_temp.dry_run_check('RPC grants: authenticated yes, anon no',
    has_function_privilege('authenticated', 'public.set_project_location(uuid,text,double precision,double precision,text,double precision,double precision)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_project_location(uuid,text,double precision,double precision,text,double precision,double precision)', 'EXECUTE'));
  perform pg_temp.dry_run_check('coordinate grants: direct INSERT and UPDATE denied',
    not has_column_privilege('authenticated','public.projects','latitude','UPDATE')
    and not has_column_privilege('authenticated','public.projects','longitude','UPDATE')
    and not has_column_privilege('authenticated','public.projects','latitude','INSERT')
    and not has_column_privilege('authenticated','public.projects','longitude','INSERT')
    and not has_column_privilege('anon','public.projects','latitude','UPDATE'));
  select count(*) into v_count from public.app_release_notes
   where id = '2026-10-08-job-location' and published_on = date '2026-10-08'
     and audience = array[0,1,2,3] and kind = 'improvement'
     and length(title_en)>0 and length(title_es)>0 and length(body_en)>0 and length(body_es)>0;
  perform pg_temp.dry_run_check('bilingual location note has four audiences', v_count = 1);

  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.set_project_location(v_job, '  QA address only  ', null, null, v_address, v_lat, v_lon);
  perform pg_temp.dry_run_as_system();
  select address, latitude, longitude into v_address, v_lat, v_lon from public.projects where id=v_job;
  perform pg_temp.dry_run_check('address-only trims and clears GPS',
    v_address = 'QA address only' and v_lat is null and v_lon is null);
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.set_project_location(v_job, '  QA address only  ', null, null,
    v_original_address, v_original_lat, v_original_lon);
  perform pg_temp.dry_run_check('duplicate retry with original snapshot succeeds unchanged', true);
  perform public.set_project_location(v_job, null, 0, 0, v_address, v_lat, v_lon);
  perform pg_temp.dry_run_as_system();
  select address, latitude, longitude into v_address, v_lat, v_lon from public.projects where id=v_job;
  perform pg_temp.dry_run_check('GPS-only accepts zero pair', v_address is null and v_lat=0 and v_lon=0);
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.set_project_location(v_job, 'Boundary north east', 90, 180, v_address, v_lat, v_lon);
  perform pg_temp.dry_run_as_system();
  select address, latitude, longitude into v_address, v_lat, v_lon from public.projects where id=v_job;
  perform pg_temp.dry_run_check('address plus north/east boundary', v_address='Boundary north east' and v_lat=90 and v_lon=180);
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.set_project_location(v_job, 'Boundary south west', -90, -180, v_address, v_lat, v_lon);
  perform pg_temp.dry_run_as_system();
  select address, latitude, longitude into v_address, v_lat, v_lon from public.projects where id=v_job;
  perform pg_temp.dry_run_check('south/west boundary accepted', v_lat=-90 and v_lon=-180);
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('stale address snapshot refused',
    format('select public.set_project_location(%L::uuid,%L::text,%L::float8,%L::float8,%L::text,%L::float8,%L::float8)',
      v_job,'stale',null,null,'wrong address',v_lat,v_lon), 'changed');
  perform pg_temp.dry_run_expect_error('half coordinate pair refused',
    format('select public.set_project_location(%L::uuid,%L::text,%L::float8,%L::float8,%L::text,%L::float8,%L::float8)',
      v_job,'bad',1,null,v_address,v_lat,v_lon), 'both');
  perform pg_temp.dry_run_expect_error('latitude outside range refused',
    format('select public.set_project_location(%L::uuid,%L::text,%L::float8,%L::float8,%L::text,%L::float8,%L::float8)',
      v_job,'bad',91,0,v_address,v_lat,v_lon), 'valid');
  perform pg_temp.dry_run_expect_error('longitude outside range refused',
    format('select public.set_project_location(%L::uuid,%L::text,%L::float8,%L::float8,%L::text,%L::float8,%L::float8)',
      v_job,'bad',0,181,v_address,v_lat,v_lon), 'valid');
  perform pg_temp.dry_run_expect_error('NaN refused',
    format('select public.set_project_location(%L::uuid,%L::text,%L::float8,%L::float8,%L::text,%L::float8,%L::float8)',
      v_job,'bad','NaN',0,v_address,v_lat,v_lon), 'valid');
  perform pg_temp.dry_run_expect_error('Infinity refused',
    format('select public.set_project_location(%L::uuid,%L::text,%L::float8,%L::float8,%L::text,%L::float8,%L::float8)',
      v_job,'bad',0,'Infinity',v_address,v_lat,v_lon), 'valid');
  perform pg_temp.dry_run_expect_error('unknown job refused',
    format('select public.set_project_location(%L::uuid,null,null,null,null,null,null)', gen_random_uuid()), 'existing');
  perform pg_temp.dry_run_expect_error('direct coordinate UPDATE refused',
    format('update public.projects set latitude=1 where id=%L::uuid',v_job));
  perform public.set_project_location(v_job, null, null, null, v_address, v_lat, v_lon);
  perform pg_temp.dry_run_as_system();
  select address,latitude,longitude,to_jsonb(p)-'address'-'latitude'-'longitude'
    into v_address,v_lat,v_lon,v_after from public.projects p where id=v_job;
  perform pg_temp.dry_run_check('deliberate clear leaves all other job fields intact',
    v_address is null and v_lat is null and v_lon is null and v_after=v_before);

  perform pg_temp.dry_run_act_as(v_installer);
  perform pg_temp.dry_run_expect_error('installer cannot save location',
    format('select public.set_project_location(%L::uuid,%L::text,null,null,null,null,null)',v_job,'installer'), 'foreman');
  perform pg_temp.dry_run_as_system();
  -- Only the QA foreman is temporarily changed. Restore every flag before
  -- switching to another identity, even though the harness discards the batch.
  update public.profiles set active=false where id=v_foreman and is_test is true;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform public.set_project_location(v_job, 'Off today', null, null, null, null, null);
  perform pg_temp.dry_run_check('Off today still permits an authorized save', true);
  perform pg_temp.dry_run_as_system();
  update public.profiles set active=v_original_active where id=v_foreman and is_test is true;
  foreach v_role in array array['supervisor','owner'] loop
    update public.profiles set role=v_role where id=v_foreman and is_test is true;
    perform pg_temp.dry_run_act_as(v_foreman);
    perform public.set_project_location(v_job, v_role, null, null, 'Off today', null, null);
    perform pg_temp.dry_run_check('QA '||v_role||' may edit sandbox', true);
    perform pg_temp.dry_run_as_system();
    update public.profiles set role=v_original_role where id=v_foreman and is_test is true;
    update public.projects set address='Off today' where id=v_job;
  end loop;
  update public.profiles set is_partner=true where id=v_foreman and is_test is true;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('partner foreman refused',
    format('select public.set_project_location(%L::uuid,%L::text,null,null,%L::text,null,null)',v_job,'partner','Off today'), 'foreman');
  perform pg_temp.dry_run_as_system();
  update public.profiles set is_partner=v_original_partner where id=v_foreman and is_test is true;
  update public.profiles set access_revoked_at=now() where id=v_foreman and is_test is true;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('revoked foreman refused',
    format('select public.set_project_location(%L::uuid,%L::text,null,null,%L::text,null,null)',v_job,'revoked','Off today'), 'foreman');
  perform pg_temp.dry_run_as_system();
  update public.profiles set access_revoked_at=v_original_revoked where id=v_foreman and is_test is true;
  update public.profiles set retired_at=now() where id=v_foreman and is_test is true;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('retired foreman refused',
    format('select public.set_project_location(%L::uuid,%L::text,null,null,%L::text,null,null)',v_job,'retired','Off today'), 'foreman');
  perform pg_temp.dry_run_as_system();
  update public.profiles set retired_at=v_original_retired where id=v_foreman and is_test is true;
  perform pg_temp.dry_run_check('QA role and access flags restored',
    exists(select 1 from public.profiles where id=v_foreman and is_test is true
      and role=v_original_role and active=v_original_active and is_partner=v_original_partner
      and access_revoked_at is not distinct from v_original_revoked
      and retired_at is not distinct from v_original_retired));
  update public.projects set deleted_at=now() where id=v_job;
  perform pg_temp.dry_run_act_as(v_foreman);
  perform pg_temp.dry_run_expect_error('deleted sandbox job refused',
    format('select public.set_project_location(%L::uuid,%L::text,null,null,%L::text,null,null)',
      v_job,'deleted','Off today'), 'existing');
  perform pg_temp.dry_run_as_system();
  update public.projects set deleted_at=v_original_deleted where id=v_job;
end $$;
