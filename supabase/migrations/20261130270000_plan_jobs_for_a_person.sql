-- Which jobs' published Plans name a given person.
--
-- "View as" a person showed an empty Upcoming work for everyone but the QA
-- logins: the preview could only ask job by job (get_published_installer_plan)
-- and had no way to know which jobs to ask about, so it asked the test jobs and
-- nothing else. An owner who planned a foreman onto a job and then viewed as
-- them saw "no assigned work" and took the Plan for broken (Matt, 2026-11-22).
--
-- This answers only "which jobs", with the label the list needs. The blocks
-- still come from get_published_installer_plan, which stays the one place that
-- decides what of a block a person sees. Reading another person's Plan is a
-- foreman-and-above right there (_installer_plan_access with p_manage), and the
-- same call fences testing jobs here, so a job the caller may not manage is
-- left out rather than refused: the list is what they are allowed to see.
create function public.list_installer_plan_jobs(p_installer_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'projectId', job.id, 'jobCode', job.job_code, 'jobName', job.name
    ) order by job.job_code, job.id), '[]'::jsonb)
  from public.installer_job_plans plan
  join public.projects job on job.id = plan.project_id
  where p_installer_id is not null
    and exists (
      select 1 from jsonb_array_elements(plan.published) as items(block)
      where block->'installerIds' ? p_installer_id::text
    )
    and public._installer_plan_access(job.id, p_installer_id is distinct from auth.uid());
$$;

revoke all on function public.list_installer_plan_jobs(uuid) from public, anon;
grant execute on function public.list_installer_plan_jobs(uuid) to authenticated;
