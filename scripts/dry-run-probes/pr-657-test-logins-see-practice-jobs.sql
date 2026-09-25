-- Probe for 20261030030000_test_logins_see_practice_jobs.sql (#657): a test
-- login sees the practice job — a job that is BOTH a testing project AND on
-- the sandbox list — with the rows under it that the drill opens; it sees no
-- other testing job; and nobody else's list of jobs changes by a single row.
--
-- Every real person is only READ as. The only writes are the system's, rolled
-- back with the batch like everything else: two throwaway jobs (one testing job
-- off the sandbox list, one practice job in the trash), a custom unit on the
-- practice job if it has none, each QA login's test flag cleared for one check,
-- and, last, the rule on master put back to compare every login against.
-- Job codes and qa.* logins only in the output; people are counted, never named.
--
-- Run: gh workflow run db-dry-run.yml --repo Infinity-Windows/infinity-windows \
--        -f ref=claude/test-logins-see-practice-jobs \
--        -f migrations="supabase/migrations/20261030030000_test_logins_see_practice_jobs.sql" \
--        -f probe=scripts/dry-run-probes/pr-657-test-logins-see-practice-jobs.sql

-- ---------------------------------------------------------------------------
-- 1. The rule on the database, and the two helpers it calls
-- ---------------------------------------------------------------------------
do $$
declare
  v_qual text;
  v_n int;
  v_codes text;
begin
  perform pg_temp.dry_run_as_system();
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_select_visible';
  perform pg_temp.dry_run_check('rule: the jobs read rule has the new branch (a test login, a testing job, on the sandbox list)',
    coalesce(v_qual ilike '%is_test_profile(auth.uid())%' and v_qual ilike '%is_sandbox_project(%', false), null);
  perform pg_temp.dry_run_check('rule: the trash gate, the supervisor branch and the partner grant are all still in it',
    coalesce(v_qual ilike '%deleted_at IS NULL%' and v_qual ilike '%is_supervisor(auth.uid())%'
      and v_qual ilike '%partner_job_grants%' and v_qual ilike '%is_partner_user()%', false), null);
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'projects' and cmd in ('SELECT', 'ALL');
  perform pg_temp.dry_run_check('rule: it is still the only rule that lets anyone read jobs', v_n = 1,
    v_n || ' read rule(s) on projects, expected 1');
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('is_test_profile', 'is_sandbox_project')
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
  perform pg_temp.dry_run_check('helpers: the two the rule calls are security definer with a pinned search path', v_n = 2,
    v_n || ' of 2');
  perform pg_temp.dry_run_check('helpers: a signed-out caller can run neither; a signed-in caller can run both',
    not has_function_privilege('anon', 'public.is_test_profile(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.is_sandbox_project(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.is_test_profile(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.is_sandbox_project(uuid)', 'execute'), null);
  select count(*), string_agg(p.job_code, ', ' order by p.job_code) into v_n, v_codes
    from public.projects p
   where coalesce(p.is_test, false) and p.deleted_at is null and public.is_sandbox_project(p.id);
  perform pg_temp.dry_run_check('the jobs a test login gains: every live job that is testing AND on the sandbox list',
    v_n >= 1, v_n || ': ' || coalesce(v_codes, 'none'));
end $$;

-- ---------------------------------------------------------------------------
-- 2. The two QA logins see the practice job and the rows the drill opens
-- ---------------------------------------------------------------------------
do $$
declare
  v_job uuid;
  v_code text;
  v_active boolean;
  r record;
  v_id uuid;
  v_role text;
  v_n int;
  v_docs int;
  s_units int;
  s_sessions int;
  s_history int;
  s_records int;
  s_openings int;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  select job_code, status = 'active' into v_code, v_active from public.projects where id = v_job;
  perform pg_temp.dry_run_check('setup: the practice job is active, so the clock-in list can offer it',
    coalesce(v_active, false), v_code);
  -- The drill opens units, so make sure there is one to open (rolled back).
  if not exists (select 1 from public.custom_work_units where project_id = v_job) then
    insert into public.custom_work_units (id, project_id, created_by, label)
    values (gen_random_uuid(), v_job, pg_temp.dry_run_pick('installer'), 'Dry run unit');
  end if;
  -- What is under the job, read as the system.
  select count(*) into s_units from public.custom_work_units where project_id = v_job;
  select count(*) into s_sessions from public.custom_work_sessions where project_id = v_job;
  select count(*) into s_history from public.custom_work_history where project_id = v_job;
  select count(*) into s_records from public.crew_work_records where project_id = v_job;
  select count(*) into s_openings from public.project_openings where project_id = v_job and removed_at is null;

  for r in select * from (values ('installer', 'qa.installer'), ('foreman', 'qa.foreman')) as t(role, login) loop
    perform pg_temp.dry_run_as_system();
    v_id := pg_temp.dry_run_pick(r.role);
    -- Documents the login may read at all: money ones only with the cost grant.
    select count(*) into v_docs from public.project_documents d
     where d.project_id = v_job and (not d.money or public.can_see_costs(v_id));
    v_role := pg_temp.dry_run_act_as(v_id);
    perform pg_temp.dry_run_check(r.login || ': acting as the QA login, a test login with the ' || r.role || ' role',
      current_user = 'authenticated' and auth.uid() = v_id and v_role = r.role and public.is_test_profile(v_id), v_role);

    select count(*) into v_n from public.projects where id = v_job;
    perform pg_temp.dry_run_check(r.login || ': sees the practice job', v_n = 1,
      v_code || ': ' || v_n || ' row(s), expected 1');
    select count(*) into v_n
      from public.projects p left join public.project_pipeline pp on pp.project_id = p.id
     where p.id = v_job and p.status = 'active' and p.deleted_at is null;
    perform pg_temp.dry_run_check(r.login || ': the clock-in job list (active jobs, with their pipeline row) offers it', v_n = 1,
      v_n || ' row(s), expected 1');
    select count(*) into v_n from public.custom_work_units where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ': opens every custom unit on it', v_n = s_units and v_n > 0,
      v_n || ' of ' || s_units);
    select count(*) into v_n from public.custom_work_sessions where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ': reads the work sessions on it', v_n = s_sessions,
      v_n || ' of ' || s_sessions);
    select count(*) into v_n from public.custom_work_history where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ': reads the unit history on it', v_n = s_history,
      v_n || ' of ' || s_history);
    select count(*) into v_n from public.crew_work_records where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ': reads the crew work records on it', v_n = s_records,
      v_n || ' of ' || s_records);
    select count(*) into v_n from public.project_documents where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ': reads the job documents it may read', v_n = v_docs,
      v_n || ' of ' || v_docs);
    select count(*) into v_n from public.project_openings where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ': reads its map units (openings), as it already could', v_n = s_openings,
      v_n || ' of ' || s_openings);
  end loop;
  perform pg_temp.dry_run_as_system();
end $$;

-- ---------------------------------------------------------------------------
-- 3. Every other testing job stays hidden from them; real crew are unchanged
-- ---------------------------------------------------------------------------
do $$
declare
  v_job uuid;
  v_offlist uuid;
  v_trashed uuid;
  v_ids uuid[];
  v_codes text;
  r record;
  v_id uuid;
  v_role text;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  -- Two throwaway jobs, made by the system and rolled back with the run: a
  -- testing job that is NOT on the sandbox list, and a practice job in the trash.
  insert into public.projects (job_code, name, notes, is_test)
  values ('ZZDRYRUN-OFFLIST', 'Dry run: a testing job off the sandbox list', 'Rolled back with the practice run.', true)
  returning id into v_offlist;
  insert into public.projects (job_code, name, notes, is_test, deleted_at)
  values ('ZZDRYRUN-TRASHED', 'Dry run: a practice job in the trash', 'Rolled back with the practice run.', true, now())
  returning id into v_trashed;
  insert into public.sandbox_projects (project_id, note) values (v_trashed, 'Dry run: rolled back with the practice run');
  insert into public.custom_work_units (id, project_id, created_by, label)
  values (gen_random_uuid(), v_offlist, pg_temp.dry_run_pick('installer'), 'Dry run unit');
  -- Every live testing job off the sandbox list, the throwaway one included.
  select array_agg(p.id), string_agg(p.job_code, ', ' order by p.job_code) into v_ids, v_codes
    from public.projects p
   where coalesce(p.is_test, false) and p.deleted_at is null and not public.is_sandbox_project(p.id);
  perform pg_temp.dry_run_check('setup: the testing jobs off the sandbox list, to look for', v_offlist = any(v_ids),
    cardinality(v_ids) || ': ' || v_codes);

  for r in select * from (values ('installer', 'qa.installer'), ('foreman', 'qa.foreman')) as t(role, login) loop
    perform pg_temp.dry_run_as_system();
    v_id := pg_temp.dry_run_pick(r.role);
    v_role := pg_temp.dry_run_act_as(v_id);
    select count(*) into v_n from public.projects where id = any(v_ids);
    perform pg_temp.dry_run_check(r.login || ': sees no testing job that is off the sandbox list', v_n = 0,
      v_n || ' of ' || cardinality(v_ids) || ' visible, expected 0');
    select count(*) into v_n from public.custom_work_units where project_id = v_offlist;
    perform pg_temp.dry_run_check(r.login || ': nor the units on one', v_n = 0, v_n || ' unit(s), expected 0');
    select count(*) into v_n from public.projects where id = v_trashed;
    perform pg_temp.dry_run_check(r.login || ': does not see a practice job in the trash', v_n = 0,
      v_n || ' row(s), expected 0');
  end loop;

  for r in select * from (values ('installer'), ('foreman')) as t(role) loop
    perform pg_temp.dry_run_as_system();
    v_id := pg_temp.dry_run_pick_real(r.role);
    v_role := pg_temp.dry_run_act_as(v_id);
    select count(*) into v_n from public.projects where id = v_job or id = v_offlist;
    perform pg_temp.dry_run_check('a real ' || r.role || ': still sees neither the practice job nor any other testing job', v_n = 0,
      v_n || ' row(s), expected 0');
    select count(*) into v_n from public.custom_work_units where project_id = v_job;
    perform pg_temp.dry_run_check('a real ' || r.role || ': nor the practice job''s units', v_n = 0,
      v_n || ' unit(s), expected 0');
  end loop;

  perform pg_temp.dry_run_as_system();
  v_id := pg_temp.dry_run_pick('supervisor');
  v_role := pg_temp.dry_run_act_as(v_id);
  select count(*) into v_n from public.projects where id in (v_job, v_offlist, v_trashed);
  perform pg_temp.dry_run_check('a supervisor: still sees every testing job, the trashed one included', v_n = 3,
    v_n || ' of 3');
  perform pg_temp.dry_run_as_system();
end $$;

-- ---------------------------------------------------------------------------
-- 4. It is the test flag that opens the job: clear it and the job is gone
-- ---------------------------------------------------------------------------
do $$
declare
  v_job uuid;
  r record;
  v_id uuid;
  v_role text;
  v_n int;
  v_u int;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  for r in select * from (values ('installer', 'qa.installer'), ('foreman', 'qa.foreman')) as t(role, login) loop
    perform pg_temp.dry_run_as_system();
    v_id := pg_temp.dry_run_pick(r.role);
    update public.profiles set is_test = false where id = v_id;
    v_role := pg_temp.dry_run_act_as(v_id);
    select count(*) into v_n from public.projects where id = v_job;
    select count(*) into v_u from public.custom_work_units where project_id = v_job;
    perform pg_temp.dry_run_check(r.login || ' with its test flag cleared: the practice job and its units disappear',
      v_n = 0 and v_u = 0 and not public.is_test_profile(v_id),
      v_n || ' job row(s), ' || v_u || ' unit(s), expected 0 and 0');
    perform pg_temp.dry_run_as_system();
    update public.profiles set is_test = true where id = v_id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Every login, this rule against the rule on master
-- ---------------------------------------------------------------------------
-- Last, because it puts master's rule back (inside the batch, rolled back with
-- it). Each person's list of jobs is read under both rules and compared, so
-- "nobody else's view changes" is measured, not argued.
do $$
declare
  v_master_rule constant text := $rule$
create policy "projects_select_visible" on projects
  for select to authenticated using (
    (deleted_at is null or _is_supervisor(auth.uid()))
    and (
      is_test = false or _is_supervisor(auth.uid())
      or (
        public.is_partner_user()
        and exists (
          select 1 from partner_job_grants g
          where g.project_id = projects.id and g.partner_profile_id = auth.uid()
        )
      )
    )
  )$rule$;
  v_job uuid;
  v_gain_expected text;
  v_after jsonb := '{}'::jsonb;
  v_units_after jsonb := '{}'::jsonb;
  r record;
  v_seen text;
  v_units int;
  v_a text[];
  v_b text[];
  v_gained text;
  v_lost int;
  v_people int := 0;
  v_same int := 0;
  v_tests int := 0;
  v_tests_ok int := 0;
  v_units_ok int := 0;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  select coalesce(string_agg(p.id::text, ',' order by p.id::text), '') into v_gain_expected
    from public.projects p
   where coalesce(p.is_test, false) and p.deleted_at is null and public.is_sandbox_project(p.id);

  -- Under the rule this pull request writes.
  for r in select p.id from public.profiles p where p.role is not null order by p.id loop
    perform pg_temp.dry_run_act_as(r.id);
    select coalesce(string_agg(id::text, ',' order by id::text), '') into v_seen from public.projects;
    select count(*) into v_units from public.custom_work_units where project_id = v_job;
    v_after := v_after || jsonb_build_object(r.id::text, v_seen);
    v_units_after := v_units_after || jsonb_build_object(r.id::text, v_units);
  end loop;

  -- Under the rule on master.
  perform pg_temp.dry_run_as_system();
  drop policy "projects_select_visible" on public.projects;
  execute v_master_rule;

  for r in select p.id, coalesce(p.is_test, false) as t from public.profiles p where p.role is not null order by p.id loop
    perform pg_temp.dry_run_act_as(r.id);
    select coalesce(string_agg(id::text, ',' order by id::text), '') into v_seen from public.projects;
    select count(*) into v_units from public.custom_work_units where project_id = v_job;
    if r.t then
      v_tests := v_tests + 1;
      v_a := string_to_array(nullif(v_after ->> r.id::text, ''), ',');
      v_b := string_to_array(nullif(v_seen, ''), ',');
      select coalesce(string_agg(x, ',' order by x), '') into v_gained
        from unnest(coalesce(v_a, '{}'::text[])) x where not (x = any(coalesce(v_b, '{}'::text[])));
      select count(*) into v_lost
        from unnest(coalesce(v_b, '{}'::text[])) x where not (x = any(coalesce(v_a, '{}'::text[])));
      if v_gained = v_gain_expected and v_lost = 0 then v_tests_ok := v_tests_ok + 1; end if;
      if v_units = 0 and (v_units_after ->> r.id::text)::int > 0 then v_units_ok := v_units_ok + 1; end if;
    else
      v_people := v_people + 1;
      if v_after ->> r.id::text = v_seen then v_same := v_same + 1; end if;
    end if;
  end loop;
  perform pg_temp.dry_run_as_system();

  perform pg_temp.dry_run_check('every real login (' || v_people || '): reads exactly the jobs the rule on master showed',
    v_people > 0 and v_same = v_people, (v_people - v_same) || ' differ, expected 0');
  perform pg_temp.dry_run_check('the test logins (' || v_tests || '): gain exactly the testing jobs on the sandbox list and lose none',
    v_tests >= 2 and v_tests_ok = v_tests, v_tests_ok || ' of ' || v_tests || ' as expected');
  perform pg_temp.dry_run_check('the test logins: the practice job''s units were hidden under master''s rule and open under this one',
    v_tests >= 2 and v_units_ok = v_tests, v_units_ok || ' of ' || v_tests);
end $$;
