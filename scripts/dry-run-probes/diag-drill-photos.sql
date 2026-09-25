-- Read-only: where did the drill's photos land? Counts and labels only.
do $$
declare
  v_job uuid; v_who uuid; v_since timestamptz := '2026-09-25 05:00:00+00'; v_line text; r record; v_n int; v_cols text;
begin
  perform pg_temp.dry_run_as_system();
  select id into v_job from public.projects where job_code = 'PECAN14';
  select s.profile_id into v_who from public.time_shifts s where s.project_id = v_job and s.clock_in_at > v_since - interval '1 hour' order by s.clock_in_at limit 1;
  -- every stored file created since 11 PM MDT, by bucket, with what the first folder is
  select string_agg(format('%s: %s file(s), first folder=%s', b, n, k), '; ') into v_line from (
    select o.bucket_id as b,
           case when split_part(o.name, '/', 1) = v_job::text then 'PECAN14'
                when split_part(o.name, '/', 1) = v_who::text then 'the tester'
                when exists (select 1 from public.projects p where p.id::text = split_part(o.name, '/', 1)) then 'another job'
                else 'other' end as k, count(*) as n
      from storage.objects o where o.created_at > v_since group by 1, 2) x;
  perform pg_temp.dry_run_check('all stored files since 11 PM', true, coalesce(v_line, 'none'));
  -- every table whose name mentions photo/media/image/attachment: rows since 11 PM (any job)
  v_line := '';
  for r in select t.table_name from information_schema.tables t
            where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
              and (t.table_name ilike '%photo%' or t.table_name ilike '%media%' or t.table_name ilike '%image%' or t.table_name ilike '%attach%')
              and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'created_at') loop
    begin
      execute format('select count(*) from public.%I where created_at > $1', r.table_name) into v_n using v_since;
      if v_n > 0 then v_line := v_line || format('%s=%s ', r.table_name, v_n); end if;
    exception when others then null; end;
  end loop;
  perform pg_temp.dry_run_check('photo/media rows since 11 PM (any job)', true, coalesce(nullif(v_line, ''), 'none'));
  -- the custom unit completed in the drill: its photo-like facts / evidence counts
  select format('unit facts keys: %s', coalesce((select string_agg(k, ',') from jsonb_object_keys(u.facts) k), '-'))
    into v_line from public.custom_work_units u where u.project_id = v_job and u.updated_at > v_since limit 1;
  perform pg_temp.dry_run_check('drill unit', true, coalesce(v_line, 'none'));
end $$;
