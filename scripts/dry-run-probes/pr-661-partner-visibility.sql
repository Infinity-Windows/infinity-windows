-- Probe for 20261030100000_partner_sees_granted_jobs_only.sql (#661): a
-- partner (builder) login reads the row of a job only when that job is live
-- and granted to it, and writes no job directly; every login that is not a
-- partner reads exactly the jobs it read before (the QA logins still see the
-- practice job, 20261030030000), and still edits the jobs it may edit.
--
-- Every real person is only READ as. The only writes are the system's, rolled
-- back with the batch like everything else: three throwaway jobs, the two QA
-- logins marked as partners for one section (test flag cleared, grants given
-- to one of them, then all of it put back), one no-change edit of the
-- practice job by the QA installer, and, last, the read rule on master put
-- back to compare every login against.
-- Counts only in the output: no names, no ids, no job codes.
--
-- Run: gh workflow run db-dry-run.yml --repo Infinity-Windows/infinity-windows \
--        -f ref=claude/partner-sees-granted-jobs-only \
--        -f migrations="supabase/migrations/20261030100000_partner_sees_granted_jobs_only.sql" \
--        -f probe=scripts/dry-run-probes/pr-661-partner-visibility.sql

-- ---------------------------------------------------------------------------
-- 1. The rules on the database, and the helper the partner branch calls
-- ---------------------------------------------------------------------------
do $$
declare
  v_qual text;
  v_ins text;
  v_upd_q text;
  v_upd_c text;
  v_grants text;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'projects' and cmd in ('SELECT', 'ALL');
  perform pg_temp.dry_run_check('rule: still one rule decides who reads a job', v_n = 1,
    v_n || ' read rule(s) on projects, expected 1');
  select replace(qual, 'public.', '') into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_select_visible';
  perform pg_temp.dry_run_check('rule: a partner reads a live job only through its own grant (partner_has_job_grant)',
    coalesce(v_qual ilike '%(is_partner_user() AND (deleted_at IS NULL) AND partner_has_job_grant(id))%', false), null);
  perform pg_temp.dry_run_check('rule: the crew branches, the test-login branch included, are asked only for a login that is not a partner',
    coalesce(v_qual ilike '%((NOT is_partner_user()) AND ((is_test = false) OR _is_supervisor(auth.uid()) OR (is_test AND is_test_profile(auth.uid()) AND custom_work_internal() AND is_sandbox_project(id))))%', false), null);
  perform pg_temp.dry_run_check('rule: the grant is asked through the helper, never by reading the grants table inline',
    coalesce(v_qual not ilike '%partner_job_grants%', false), null);
  perform pg_temp.dry_run_check('rule: the trash gate still wraps the whole rule',
    coalesce(v_qual ilike '(((deleted_at IS NULL) OR _is_supervisor(auth.uid())) AND %', false), null);
  select replace(with_check, 'public.', '') into v_ins from pg_policies
   where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_insert';
  select replace(qual, 'public.', ''), replace(with_check, 'public.', '') into v_upd_q, v_upd_c from pg_policies
   where schemaname = 'public' and tablename = 'projects' and policyname = 'projects_update';
  perform pg_temp.dry_run_check('writes: adding or editing a job refuses a partner and asks nothing new of anyone else',
    coalesce(v_ins = '(NOT is_partner_user())'
      and v_upd_q = '((deleted_at IS NULL) AND (NOT is_partner_user()))'
      and v_upd_c = '(NOT is_partner_user())', false), null);
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'projects' and cmd = 'DELETE';
  perform pg_temp.dry_run_check('writes: still no rule deletes a job directly (the trash RPCs are the door)', v_n = 0,
    v_n || ' delete rule(s), expected 0');
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partner_has_job_grant' and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
  perform pg_temp.dry_run_check('helper: partner_has_job_grant is security definer with a pinned search path', v_n = 1,
    v_n || ' of 1');
  perform pg_temp.dry_run_check('helper: a signed-out caller cannot run it; a signed-in caller can',
    not has_function_privilege('anon', 'public.partner_has_job_grant(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.partner_has_job_grant(uuid)', 'execute'), null);
  select count(*), max(replace(qual, 'public.', '')) into v_n, v_grants from pg_policies
   where schemaname = 'public' and tablename = 'partner_job_grants';
  perform pg_temp.dry_run_check('grants table: still read by the owner only, as THE WALL built it',
    v_n = 1 and coalesce(v_grants ilike '%(NOT is_partner_user())%' and v_grants ilike '%my_role_rank() >= 3%', false),
    v_n || ' rule(s) on it');
end $$;

-- ---------------------------------------------------------------------------
-- 2. A partner reads its live grants and nothing else, and writes no job
-- ---------------------------------------------------------------------------
-- No QA login is a partner, so the two QA logins stand in: each is marked a
-- builder login with its test flag cleared (the shape a partner invite
-- gives a login), the QA installer is granted three jobs and the QA foreman
-- none, and both are put back at the end of the section.
do $$
declare
  v_inst uuid;
  v_fore uuid;
  v_job uuid;
  v_live uuid;
  v_trash uuid;
  v_other uuid;
  v_crew uuid;
  v_role text;
  v_n int;
  v_m int;
  v_p1 boolean;
  v_t1 boolean;
  v_p2 boolean;
  v_t2 boolean;
begin
  perform pg_temp.dry_run_as_system();
  v_inst := pg_temp.dry_run_pick('installer');
  v_fore := pg_temp.dry_run_pick('foreman');
  v_job := pg_temp.dry_run_sandbox_job();

  -- A crew login still edits a job it may see and write: a throwaway job that
  -- is not a testing project, put on the sandbox list so the QA installer's
  -- fence allows it (the practice job itself is a testing project, which an
  -- installer does not see). A change to nothing.
  insert into public.projects (job_code, name, notes)
  values ('ZZDRYRUN-CREW-EDIT', 'Dry run: a job a crew login edits', 'Rolled back with the practice run.')
  returning id into v_crew;
  insert into public.sandbox_projects (project_id, note) values (v_crew, 'Dry run: rolled back with the practice run');
  v_role := pg_temp.dry_run_act_as(v_inst);
  update public.projects set notes = notes where id = v_crew;
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('crew: the QA installer still edits a job it may see and write', v_n = 1,
    v_n || ' row(s), expected 1');
  perform pg_temp.dry_run_check('crew: a crew login passes the new add-a-job rule', not public.is_partner_user(), v_role);
  select count(*) into v_n from public.projects where id = v_job;
  perform pg_temp.dry_run_check('crew: the QA installer still sees the practice job (the test-login branch is kept)', v_n = 1,
    v_n || ' row(s), expected 1');

  perform pg_temp.dry_run_as_system();
  insert into public.projects (job_code, name, notes)
  values ('ZZDRYRUN-PARTNER-LIVE', 'Dry run: a job granted to a partner', 'Rolled back with the practice run.')
  returning id into v_live;
  insert into public.projects (job_code, name, notes, deleted_at)
  values ('ZZDRYRUN-PARTNER-TRASHED', 'Dry run: a granted job in the trash', 'Rolled back with the practice run.', now())
  returning id into v_trash;
  insert into public.projects (job_code, name, notes)
  values ('ZZDRYRUN-PARTNER-OTHER', 'Dry run: a job granted to nobody', 'Rolled back with the practice run.')
  returning id into v_other;
  select coalesce(p.is_partner, false), coalesce(p.is_test, false) into v_p1, v_t1 from public.profiles p where p.id = v_inst;
  select coalesce(p.is_partner, false), coalesce(p.is_test, false) into v_p2, v_t2 from public.profiles p where p.id = v_fore;
  update public.profiles set is_partner = true, is_test = false where id in (v_inst, v_fore);
  insert into public.partner_job_grants (partner_profile_id, project_id)
  values (v_inst, v_job), (v_inst, v_live), (v_inst, v_trash);

  -- The partner with three grants: a testing job, a real job, a trashed job.
  v_role := pg_temp.dry_run_act_as(v_inst);
  perform pg_temp.dry_run_check('partner (the QA installer marked a builder login): acting as it',
    current_user = 'authenticated' and auth.uid() = v_inst and public.is_partner_user(), v_role);
  select count(*) into v_n from public.projects;
  select count(*) into v_m from public.projects where id in (v_job, v_live);
  perform pg_temp.dry_run_check('partner: reads exactly its two live grants, a testing job and a real one',
    v_n = 2 and v_m = 2, v_n || ' job(s) visible, expected 2');
  select count(*) into v_n from public.projects where id in (v_trash, v_other);
  perform pg_temp.dry_run_check('partner: not its granted job in the trash, nor a job granted to nobody', v_n = 0,
    v_n || ' row(s), expected 0');
  select count(*), count(*) filter (where s.id in (v_job, v_live)) into v_n, v_m from public.stg_job_list() s;
  perform pg_temp.dry_run_check('partner: its builder view (stg_job_list) lists the same two jobs', v_n = 2 and v_m = 2,
    v_n || ' listed, expected 2');
  perform pg_temp.dry_run_check('partner: partner_has_job_grant says yes to its grant and no to a job granted to nobody',
    public.partner_has_job_grant(v_live) and not public.partner_has_job_grant(v_other), null);
  select count(*) into v_n from public.partner_job_grants;
  perform pg_temp.dry_run_check('partner: still reads no row of the grants table itself', v_n = 0,
    v_n || ' row(s), expected 0');
  select (select count(*) from public.project_openings where project_id in (v_job, v_live))
       + (select count(*) from public.custom_work_units where project_id in (v_job, v_live))
       + (select count(*) from public.custom_work_sessions where project_id in (v_job, v_live))
       + (select count(*) from public.project_documents where project_id in (v_job, v_live))
       + (select count(*) from public.time_shifts where project_id in (v_job, v_live))
    into v_n;
  perform pg_temp.dry_run_check('partner: reads no row under its granted jobs (openings, units, sessions, documents, shifts)',
    v_n = 0, v_n || ' row(s), expected 0');
  perform pg_temp.dry_run_expect_error('partner: cannot add a job',
    'insert into public.projects (job_code, name) values (''ZZDRYRUN-BY-PARTNER'', ''Dry run'')', 'row-level security');
  update public.projects set notes = notes where id in (v_job, v_live);
  get diagnostics v_n = row_count;
  perform pg_temp.dry_run_check('partner: edits no job, its granted ones included', v_n = 0,
    v_n || ' row(s) changed, expected 0');

  -- The partner with no grants.
  v_role := pg_temp.dry_run_act_as(v_fore);
  select count(*) into v_n from public.projects;
  perform pg_temp.dry_run_check('partner with no grants (the QA foreman marked a builder login): reads no job at all',
    v_n = 0 and public.is_partner_user(), v_n || ' job(s) visible, expected 0');
  select count(*) into v_n from public.stg_job_list();
  perform pg_temp.dry_run_check('partner with no grants: its builder view lists none', v_n = 0, v_n || ' listed, expected 0');

  -- Both back as they were.
  perform pg_temp.dry_run_as_system();
  delete from public.partner_job_grants where partner_profile_id in (v_inst, v_fore);
  update public.profiles set is_partner = v_p1, is_test = v_t1 where id = v_inst;
  update public.profiles set is_partner = v_p2, is_test = v_t2 where id = v_fore;
  select count(*) into v_n from public.profiles
   where id in (v_inst, v_fore) and not coalesce(is_partner, false) and coalesce(is_test, false);
  perform pg_temp.dry_run_check('setup: both QA logins are back to test logins that are not partners', v_n = 2, v_n || ' of 2');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Every login, this rule against the rule on master
-- ---------------------------------------------------------------------------
-- Last, because it puts master's rule back (20261030030000's, inside the
-- batch, rolled back with it). Each login that is not a partner has its list of jobs read under both
-- rules and compared, so "nobody else's view changes" is measured, not argued.
-- Each real partner login is held to its own live grants under this rule.
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
      or (
        is_test
        and public.is_test_profile(auth.uid())
        and public.custom_work_internal()
        and public.is_sandbox_project(projects.id)
      )
    )
  )$rule$;
  v_after jsonb := '{}'::jsonb;
  r record;
  v_seen text;
  v_granted text;
  v_people int := 0;
  v_same int := 0;
  v_partners int := 0;
  v_partners_ok int := 0;
begin
  perform pg_temp.dry_run_as_system();
  -- Under the rule this pull request writes.
  for r in select p.id, coalesce(p.is_partner, false) as partner
             from public.profiles p where p.role is not null order by p.id loop
    perform pg_temp.dry_run_act_as(r.id);
    select coalesce(string_agg(id::text, ',' order by id::text), '') into v_seen from public.projects;
    v_after := v_after || jsonb_build_object(r.id::text, v_seen);
    if r.partner then
      perform pg_temp.dry_run_as_system();
      select coalesce(string_agg(p.id::text, ',' order by p.id::text), '') into v_granted
        from public.projects p join public.partner_job_grants g on g.project_id = p.id
       where g.partner_profile_id = r.id and p.deleted_at is null;
      v_partners := v_partners + 1;
      if v_seen = v_granted then v_partners_ok := v_partners_ok + 1; end if;
    end if;
  end loop;

  -- Under the rule on master, for every login that is not a partner.
  perform pg_temp.dry_run_as_system();
  drop policy "projects_select_visible" on public.projects;
  execute v_master_rule;
  for r in select p.id from public.profiles p
            where p.role is not null and not coalesce(p.is_partner, false) order by p.id loop
    perform pg_temp.dry_run_act_as(r.id);
    select coalesce(string_agg(id::text, ',' order by id::text), '') into v_seen from public.projects;
    v_people := v_people + 1;
    if v_after ->> r.id::text = v_seen then v_same := v_same + 1; end if;
  end loop;
  perform pg_temp.dry_run_as_system();

  perform pg_temp.dry_run_check('every login that is not a partner (' || v_people || '): reads exactly the jobs the rule on master showed',
    v_people > 0 and v_same = v_people, (v_people - v_same) || ' differ, expected 0');
  perform pg_temp.dry_run_check('every real partner login (' || v_partners || '): reads exactly its own live grants',
    v_partners_ok = v_partners, v_partners_ok || ' of ' || v_partners);
end $$;
