-- One read of the test-login fence on the live database, flattened to `kind|…`
-- rows the way scripts/live_schema.sql is, so scripts/sandbox_guard.py can
-- judge it without knowing anything about Supabase.
--
-- Run with: scripts/pgq.sh scripts/sandbox_guard_census.sql > /tmp/fence.json
-- Normally invoked through scripts/verify-sandbox-guard.sh.
--
-- Read-only: every row here is a SELECT, which is all scripts/pgq.sh allows.
--
-- The three functions come from 20260965000000_sandbox_guard_rearm.sql. If this
-- query fails to parse on the server, that migration has not been applied —
-- which is itself the answer, and sandbox_guard.py says so in those words.
select 'scoped|' || table_name || '|' || link_column || '|' || link_kind as k
  from public.sandbox_scoped_tables()
union all
select 'unguarded|' || table_name || '|' || link_column || '|' || reason
  from public.sandbox_guard_census()
union all
-- Which jobs a test login may write. Not a pass/fail — a fence is only as tight
-- as the list of what is inside it, and 20260933000000_testing_projects.sql
-- widened this list to every job flagged as practice data. Printing it on every
-- deploy is how that stays a decision somebody made rather than a surprise.
select 'sandbox_job|' || coalesce(p.job_code, '(no job code)') || '|' || coalesce(p.name, '')
  from public.sandbox_projects s
  join public.projects p on p.id = s.project_id
union all
-- Who the fence applies to. Two accounts, both robots. A third would be news.
select 'test_login|' || coalesce(pr.display_name, '(no name)')
  from public.profiles pr
 where pr.is_test
order by 1
