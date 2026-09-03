-- Delete a job: supervisor+, with a reason, 30 days to undo, then gone.
--
-- Owner ask (standard-tracking-jobs slice 5, 2026-09-03): a supervisor should
-- be able to delete a bad job — a mistaken quick tracking job, a duplicate
-- callback, a test that leaked onto the board — not only the owner. Deleting a
-- job is a big act, so it now demands a REASON and puts a NOTICE in front of
-- every supervisor (the notice is client-side, lib/jobDeletion.ts; this file is
-- the reason and the gate). The 30-day recoverable trash itself is unchanged
-- (20260959000000 built it); this widens who may work it and records why.
--
-- Read first: 20260959000000_project_trash.sql (the trash model, the full
-- purge order, and every WHY behind it — this migration REBUILDS its three
-- functions verbatim except the gate and the reason, per the "rebuild in full,
-- never a diff" rule the movements_event_ck incident set), _is_supervisor
-- (20260810000000), and the void_shift reason precedent (20260944000000).
--
-- Nothing here creates or re-scopes a project-scoped table: projects already
-- exists and is already fenced by the sandbox guard (20260967000000), and
-- deleted_reason is a plain text column on it — so no attach_sandbox_guards()
-- call is needed (scripts/test_sandbox_guard.py agrees).


-- =============================================================================
-- 1. The reason column
-- =============================================================================
-- Stored on the row beside deleted_at/deleted_by, written ONLY by
-- trash_project() (SECURITY DEFINER) and cleared by restore_project(). It is
-- deliberately NOT added to the projects UPDATE column grant (20260959000000):
-- a direct client PATCH naming deleted_reason must 42501, exactly like
-- deleted_at, is_test and allowed_modes — the RPC is the one door.

alter table projects add column if not exists deleted_reason text;

comment on column projects.deleted_reason is
  'Why the job was deleted — required, set by trash_project(), cleared by restore_project(), erased with the row by purge_project(). RPC-only: not in the projects UPDATE column grant, so a direct PATCH naming it 42501s.';


-- =============================================================================
-- 2. See-the-trash: a supervisor now manages it, so a supervisor must see it
-- =============================================================================
-- projects_select_visible (20260959000000) hid a trashed row from everyone but
-- rank>=3 (the owner). With deletion and restore now supervisor+, a supervisor
-- who deletes a job could not see it in the trash to undo it — restore_project
-- being supervisor+ would be unreachable from the UI. So the trash sub-
-- predicate widens from my_role_rank()>=3 to _is_supervisor(auth.uid()). Every
-- other branch is byte-identical to 20260959000000 — crucially the whole
-- is_test / partner-grant predicate is preserved, so a trashed job still cannot
-- leak to a partner login (the partner branch is ANDed under the same trash
-- gate), and THE WALL's partner_job_grants + is_partner_user guard stays intact
-- (scripts/test_partner_wall.py checks for exactly those two).

drop policy if exists "projects_select_visible" on projects;
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
  );


-- =============================================================================
-- 3. trash_project — supervisor+, reason required and stored
-- =============================================================================
-- The signature changes (uuid -> uuid, text), so the old one-arg overload is
-- DROPPED first: leaving it would keep a reasonless, owner-only delete door
-- open alongside this one, defeating "require a reason".

drop function if exists public.trash_project(uuid);

create or replace function public.trash_project(p_project_id uuid, p_reason text)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can delete a job.' using errcode = '42501';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for deleting this job.';
  end if;

  select * into v_row from projects where id = p_project_id for update;
  if v_row.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'That job is already in the trash.';
  end if;

  update projects
     set deleted_at = now(), deleted_by = auth.uid(), deleted_reason = v_reason
   where id = p_project_id
  returning * into v_row;

  -- The Horizon fake-success lesson (cited verbatim in void_shift,
  -- 20260944000000): an UPDATE matching nothing must never be reported back
  -- as though the trash happened. Unreachable given the row lock above; kept
  -- explicit so a future refactor that drops the lock still fails loudly.
  if v_row.id is null then
    raise exception 'trash did not apply to job % — no row was updated', p_project_id;
  end if;

  return v_row;
end;
$$;

comment on function public.trash_project(uuid, text) is
  'Supervisor+: move a job to the 30-day trash (deleted_at/deleted_by/deleted_reason). Reason is required. Refuses a job already in the trash or that does not exist. Undo via restore_project(); permanent erase via purge_project() after 30 days (nightly sweep) or directly. Widened from owner-only + reasonless in 20260974000000.';

revoke all on function public.trash_project(uuid, text) from public, anon;
grant execute on function public.trash_project(uuid, text) to authenticated;


-- =============================================================================
-- 4. restore_project — supervisor+, clears the reason too
-- =============================================================================

create or replace function public.restore_project(p_project_id uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can undo a deleted job.' using errcode = '42501';
  end if;

  select * into v_row from projects where id = p_project_id for update;
  if v_row.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_row.deleted_at is null then
    raise exception 'That job is not in the trash.';
  end if;
  -- Past the deadline refuses even if the nightly sweep has not swept this
  -- row yet, so the 30-day promise is exact regardless of cron timing.
  if now() >= v_row.deleted_at + interval '30 days' then
    raise exception 'The 30 days are up — this job is gone for good.';
  end if;

  update projects
     set deleted_at = null, deleted_by = null, deleted_reason = null
   where id = p_project_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'restore did not apply to job % — no row was updated', p_project_id;
  end if;

  return v_row;
end;
$$;

comment on function public.restore_project(uuid) is
  'Supervisor+: undo a trash within the 30-day window (clears deleted_at/deleted_by/deleted_reason). Refuses a job not in the trash, and refuses past the 30-day deadline even if the nightly sweep has not run yet. Widened from owner-only in 20260974000000.';

revoke all on function public.restore_project(uuid) from public, anon;
grant execute on function public.restore_project(uuid) to authenticated;


-- =============================================================================
-- 5. purge_project — the permanent erase, now supervisor+
-- =============================================================================
-- REBUILT IN FULL from 20260959000000 (the whole detach-then-purge order, the
-- ADR-0004 package_marks unlink, the attachments dual-anchor split, the storage
-- cleanup) — never a diff. Two changes from that body:
--   * the direct-caller gate: my_role_rank() < 3 becomes not
--     _is_supervisor(auth.uid());
--   * one added delete — project_cost_codes (a job's pickable cost-code subset,
--     standard-tracking-jobs slice 3, 20260973000000) did not exist when
--     20260959000000 was written. It is a direct project_id child, so it is
--     purged explicitly here beside its siblings. (Its FK is ON DELETE CASCADE,
--     so the final projects delete would take it anyway — the explicit delete
--     matches how every other direct child is handled and keeps the cascade
--     legible.)
-- The cron path is untouched: auth.uid() is null under pg_cron (no JWT), so the
-- sweep runs exactly as before, trusted the way a migration or the service key
-- is. The 45-table project-scoped census (sandbox_scoped_tables) maps cleanly
-- onto this body — every scoped table is detached here, deleted here, or
-- cascades from project_openings / the final projects delete;
-- app/src/lib/trashCascade.test.ts is the standing check that it stays so.

create or replace function public.purge_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project projects;
  v_job_name text;
  v_install_media_paths text[];
  v_issue_photo_paths text[];
begin
  if auth.uid() is not null and not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can permanently delete a job.' using errcode = '42501';
  end if;

  select * into v_project from projects where id = p_project_id for update;
  if v_project.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_project.deleted_at is null then
    raise exception 'That job is not in the trash.';
  end if;
  v_job_name := v_project.name;

  -- ---------------------------------------------------------------------
  -- STEP 0 — every detach runs first, inside this one transaction, so no
  -- FK can block a delete below (movements' FK carries NO on-delete rule
  -- at all — it would abort the whole purge if it still pointed at this
  -- job when the projects row goes).
  -- ---------------------------------------------------------------------
  update movements set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update windows set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update packages set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update time_shifts set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update task_sessions set project_id = null
   where project_id = p_project_id;
  update incidents set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update service_cases set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update trips set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update receipts set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update studio_projects set project_id = null
   where project_id = p_project_id;
  update monday_jobs set project_id = null
   where project_id = p_project_id;
  update job_costs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update change_orders set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update daily_logs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;

  -- OPEN Q4: a damage report on a package that survives detaches WITH the
  -- package (project_id nulled, row and photo kept); every other issue on
  -- this job purges below.
  update issues
     set project_id = null
   where project_id = p_project_id
     and kind = 'damage' and package_id is not null;

  -- AUDIT HOLES 3+4: attachments dual-anchored to a surviving physical thing
  -- (window, package, or service case) detach — unlink install_event_id and
  -- project_id, keep the row and its storage file untouched. Two passes:
  -- rows already carrying this project's id, and (defense in depth, in case
  -- a row was ever written without project_id set) rows reached only via
  -- install_event_id whose event belongs to one of this job's openings.
  update attachments
     set install_event_id = null, project_id = null
   where project_id = p_project_id
     and (window_id is not null or package_id is not null or service_case_id is not null);

  update attachments a
     set install_event_id = null, project_id = null
    from install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id
     and (a.window_id is not null or a.package_id is not null or a.service_case_id is not null);

  -- OPEN Q3 / ADR-0004: snapshot the mark's text onto every package_marks
  -- row still pointing at one of this job's marks, THEN unlink — must
  -- happen before project_marks purges below, or the RESTRICT FK aborts.
  update package_marks pm
     set mark_code = coalesce(pm.mark_code, pmk.mark_code)
    from project_marks pmk
   where pm.mark_id = pmk.id and pmk.project_id = p_project_id;

  update package_marks
     set mark_id = null
   where mark_id in (select id from project_marks where project_id = p_project_id);

  -- ---------------------------------------------------------------------
  -- The purge order. summon_helpers/summon_declines cascade from summons;
  -- install_events/qc_checks/opening_phases/opening_notes/unit_redos/
  -- unit_sessions/project_opening_pin_moves/install_event_time_repairs all
  -- cascade from project_openings (verified against each table's own
  -- migration) — one delete of the parent takes the whole branch.
  -- project_planset_pages cascades from project_plansets the same way.
  -- ---------------------------------------------------------------------
  delete from summons where project_id = p_project_id;

  -- Gather storage paths BEFORE deleting the rows that name them: install
  -- photos anchored only to this job's install_events (no surviving window/
  -- package/service_case — the survivors above already lost that link), and
  -- opening_phases' finished-work photos, which carry no attachments row of
  -- their own and are about to cascade away with project_openings below.
  select coalesce(array_agg(path), '{}') into v_install_media_paths
    from (
      select a.storage_path as path
        from attachments a
        join install_events ie on ie.id = a.install_event_id
        join project_openings po on po.id = ie.project_opening_id
       where po.project_id = p_project_id
      union all
      select op.photo_path
        from opening_phases op
        join project_openings po on po.id = op.opening_id
       where po.project_id = p_project_id and op.photo_path is not null
    ) paths;

  delete from attachments a
   using install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id;

  -- Issues: gather photo paths of what purges (the surviving package-damage
  -- carve-out above already left this project, so it is excluded here).
  select coalesce(array_agg(photo_path), '{}') into v_issue_photo_paths
    from issues where project_id = p_project_id and photo_path is not null;

  delete from issues where project_id = p_project_id;

  -- Takes install_events, qc_checks, opening_phases, opening_notes,
  -- unit_redos, unit_sessions, project_opening_pin_moves and
  -- install_event_time_repairs with it.
  delete from project_openings where project_id = p_project_id;

  -- Takes project_planset_pages with it.
  delete from project_mark_elevation_views where project_id = p_project_id;
  delete from project_plan_outlines where project_id = p_project_id;
  delete from project_plansets where project_id = p_project_id;
  delete from project_spec_discrepancies where project_id = p_project_id;
  delete from project_mark_specs where project_id = p_project_id;
  -- package_marks already unlinked above, so this can never hit RESTRICT.
  delete from project_marks where project_id = p_project_id;
  delete from project_windows where project_id = p_project_id;
  delete from job_notes where project_id = p_project_id;
  delete from supply_orders where project_id = p_project_id;
  delete from flash_run_assignments where project_id = p_project_id;
  delete from schedule_assignments where project_id = p_project_id;
  delete from vehicle_project_assignments where project_id = p_project_id;
  delete from takeoffs where project_id = p_project_id;
  delete from project_message_reads where project_id = p_project_id;
  delete from project_messages where project_id = p_project_id;
  delete from project_cost_codes where project_id = p_project_id;
  delete from sandbox_projects where project_id = p_project_id;
  delete from partner_job_grants where project_id = p_project_id;

  -- Storage cleanup: SQL DELETE against storage.objects — the bytes become
  -- unreachable in the bucket, there is no separate "delete the file" step
  -- this migration can call from SQL. Files go second-to-last, right before
  -- the projects row, so a crash mid-purge leaves harmless orphan files in
  -- the bucket, never a row pointing at a file that is already gone.
  delete from storage.objects
   where bucket_id = 'plansets' and name like p_project_id::text || '/%';

  delete from storage.objects
   where bucket_id = 'install-media' and name = any (v_install_media_paths);

  delete from storage.objects
   where bucket_id = 'issue-photos' and name = any (v_issue_photo_paths);

  delete from projects where id = p_project_id;
end;
$$;

comment on function public.purge_project(uuid) is
  'The permanent erase: supervisor+ when called directly, and fed expired ids by purge_expired_projects (nightly pg_cron sweep, no auth.uid() in that context — trusted the same way a migration or the service key is). Refuses a job that does not exist or is not currently in the trash; does NOT re-check the 30-day deadline itself. Runs the full detach-then-purge order the census specifies. Gate widened from owner-only in 20260974000000; body otherwise identical to 20260959000000.';

revoke all on function public.purge_project(uuid) from public, anon;
grant execute on function public.purge_project(uuid) to authenticated;
