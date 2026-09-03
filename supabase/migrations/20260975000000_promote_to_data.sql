-- Build a tracking job out into a full data job (standard-tracking-jobs slice 6).
--
-- WHY (owner ask): a job can start life as a lighter Tracking job — clock time,
-- log the day, hold the plan files — and later earn the full per-window data
-- loop (openings, the flat map, Maps Interactive, Model Studio, framing/flash/
-- unit tracking, dispatch). This is the one-way upgrade. It does not create a
-- new job or move anything: every hour already logged, every photo, daily log,
-- cost code and summon is project-scoped and is untouched by a mode change, so
-- the moment the job becomes data-capable all of that history is still there —
-- the data screens simply switch on (they key off allowed_modes; see slice 2's
-- lib/jobModes + ProjectDetail + the RequireDataJob guards).
--
-- DECISION — union, not replace. Promoting ADDS 'data' to allowed_modes rather
-- than replacing the set. A tracking-only job {tracking} becomes {data,tracking}
-- (data + tracking), so a both-mode job keeps its tracking clock-in path; a job
-- that already allows data is unchanged. 'data' is only ever ADDED here and
-- never removed — there is no branch in this function that drops a mode — which
-- is exactly what makes the upgrade one-way: there is no downgrade RPC, and this
-- one cannot become a downgrade.
--
-- DECISION — no who/when stamp. Following the two sibling projects flags
-- (is_test in 20260933000000, allowed_modes in 20260970000000), neither of which
-- carries an audit column: the one-way guarantee is structural (the set only
-- grows), not a flag we have to trust, so a stamp would add a column for no
-- behaviour. Left out on purpose; the shape stays minimal.
--
-- Precedent followed exactly: a projects change written ONLY by a SECURITY
-- DEFINER RPC, foreman+ (_is_lead), with the direct allowed_modes write already
-- revoked from clients in 20260970000000 — the same lock is_test uses. No new
-- table, so no attach_sandbox_guards() is needed.

create or replace function public.promote_project_to_data(p_project_id uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
  v_current text[];
  v_next text[];
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can build a job out into a data job';
  end if;

  select allowed_modes into v_current from projects where id = p_project_id;
  if not found then
    raise exception 'that job does not exist';
  end if;

  -- The job's existing (known) modes, plus 'data'. distinct + order keep the
  -- stored array canonical (data before tracking) and make a re-promote a true
  -- no-op: a job that already allows data lands on the identical set. A garbled
  -- or empty current set degrades to data-only rather than to an illegal job.
  select array_agg(distinct m order by m) into v_next
  from (
    select m from unnest(coalesce(v_current, array['data']::text[])) as m
    where m in ('data', 'tracking')
    union
    select 'data'
  ) s;

  update projects set allowed_modes = v_next where id = p_project_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.promote_project_to_data(uuid) is
  'One-way upgrade: ADD data to a job''s allowed_modes so a Tracking job becomes a full Data job (data, or data+tracking if it also tracked). Foreman+ (server-checked, _is_lead). Idempotent — promoting an already-data job is a no-op. Never removes a mode; there is no downgrade path. Logged time, photos, daily logs, cost codes and summons are project-scoped and are untouched (standard-tracking-jobs slice 6).';

revoke all on function public.promote_project_to_data(uuid) from public;
grant execute on function public.promote_project_to_data(uuid) to authenticated;
