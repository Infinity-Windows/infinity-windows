-- A partner (builder) login reads a job only when that job was shared with it.
--
-- WHAT A PARTNER IS FOR. CONTEXT.md, "The partner wall" (settled 2026-08-26/27,
-- Q12/Q13): a partner sees the STG view of the jobs the owner granted it, one
-- row per (login, job) in partner_job_grants, and never a crew table. `projects`
-- is the one table it reads whole, and only for its granted jobs: the app shell
-- names them. Everything under a job reaches it through the stg_* projections
-- (20260952000000), which already join the grants.
--
-- THE READ RULE, rebuilt in full (never a diff; last written by 20261030030000),
-- with the crew branches and the partner branch kept apart:
--   * Anyone who is not a partner reads exactly what they read before: a live
--     job that is not a testing project; a supervisor or above, every job,
--     trash included; a test login that is a current crew login, the practice
--     job on the sandbox list too (20261030030000). Those branches are
--     byte-identical, now asked only when `not public.is_partner_user()`, so
--     a branch added to them later cannot reach a partner either.
--   * A partner reads a job that is live (not in the trash) and granted to that
--     login. A granted testing job counts too, the same set stg_job_list()
--     shows. No crew branch applies to a partner, whatever its role column says
--     (a partner's role is pinned 'installer', but a role can be changed, and
--     being a partner must not depend on it).
--   * The trash gate still wraps the whole rule.
--
-- WHY A HELPER, NOT AN INLINE exists(). partner_job_grants is owner-read-only
-- by design (Q13, 20260950000000 section 4): it says which outside parties see
-- which jobs, so a partner may not read it, not even its own rows. A
-- `select ... from partner_job_grants` written inside this policy runs under
-- the caller's own row security, so it can never find a partner's grant.
-- partner_has_job_grant() answers the one question the rule needs, "is this job
-- granted to ME?", as a definer keyed to auth.uid(), so no caller can ask it
-- about anyone else. It has the same shape as is_sandbox_project() reading the
-- sandbox list no client can read. The other way would be a "partner reads its
-- own grant rows" policy on partner_job_grants. It was not chosen: it would
-- open a new direct read of that table (granted_by included), and this rule
-- would then be only as right as that table's policy stays.
--
-- CHILD TABLES need nothing. Every one carries its own is_partner_user() guard
-- (THE WALL's sweep; custom_work_internal() on the newer ones), so a partner
-- still reads none of a job's openings, units, logs, photos, documents or
-- costs, granted or not. scripts/verify-partner-visibility.mjs pins this rule;
-- scripts/test_partner_wall.py pins its shape.

create or replace function public.partner_has_job_grant(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_project_id is not null and exists (
    select 1 from public.partner_job_grants g
     where g.project_id = p_project_id
       and g.partner_profile_id = auth.uid()
  );
$$;

comment on function public.partner_has_job_grant(uuid) is
  'True when the job is granted to the CALLING login in partner_job_grants (20261030100000). SECURITY DEFINER because partner_job_grants is owner-read-only (Q13) and projects_select_visible must still see a partner''s own grant; keyed to auth.uid(), so it can answer only about the caller. Signed-out callers cannot run it.';

revoke all on function public.partner_has_job_grant(uuid) from public, anon;
grant execute on function public.partner_has_job_grant(uuid) to authenticated, service_role;

drop policy if exists "projects_select_visible" on projects;
create policy "projects_select_visible" on projects
  for select to authenticated using (
    (deleted_at is null or _is_supervisor(auth.uid()))
    and (
      (
        not public.is_partner_user()
        and (
          is_test = false or _is_supervisor(auth.uid())
          or (
            is_test
            and public.is_test_profile(auth.uid())
            and public.custom_work_internal()
            and public.is_sandbox_project(projects.id)
          )
        )
      )
      or (
        public.is_partner_user()
        and deleted_at is null
        and public.partner_has_job_grant(projects.id)
      )
    )
  );
