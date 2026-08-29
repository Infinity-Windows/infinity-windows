-- Wave D: delete a job, 30 days in the trash, then gone for good.
--
-- Owner's ask (2026-08-28): delete a job from Active projects; deleting
-- removes it everywhere; a 30-day undo window; past 30 days it is purged for
-- good. Owner-only. The data policy (69-row census, audited) says what
-- happens to every table a job touches: purge (gone), detach (row survives,
-- project_id nulled, a job-name copy left behind), keep (untouched), or
-- hide-only (the projects RLS predicate below does the whole job). This
-- migration builds the model, the three RPCs, the nightly sweep, and closes
-- a live security bug found while designing it.
--
-- Read first: CONTEXT.md, delete_packages (20260924000000, guard voice),
-- void_shift/restore_shift (20260944000000, void+undo shape), the summon
-- 5-minute-warning migration (20260918000000, pg_cron pattern), server_now
-- (20260948000000), the stg projection RPCs (20260952000000), ADR-0004,
-- 20260730210000 (soft-delete openings — the "hidden means hidden via RLS,
-- not a filter repeated N times" precedent this migration's projects policy
-- copies), and 20260933000000/20260941000000 (is_test / delete_project —
-- the RLS-per-command and owner-rank-gate precedents).
--
-- =============================================================================
-- 1. THE SECURITY FIX (do this first, plainly)
-- =============================================================================
-- `projects_delete` has read `for delete to authenticated using (true)` since
-- 20260933000000: any signed-in login, partner logins included (projects is
-- exempt from THE WALL's sweep), can DELETE a projects row straight through
-- PostgREST today — no owner check, no trash, no 30-day window, and it fires
-- every cascade including money/payroll/safety records the policy below
-- means to protect. Direct deletes are forbidden from here on; deletion only
-- happens through trash_project -> purge_project (or the legacy, now-fixed,
-- delete_project for an untouched empty shell — section 3).

drop policy if exists "projects_delete" on projects;
-- No replacement SELECT-scoped policy: zero delete policies means RLS denies
-- every direct DELETE from anon/authenticated outright, the same "no direct-
-- write path" shape daily_logs/timecard_periods/partner_job_grants already
-- use for their own RPC-only tables.


-- =============================================================================
-- 2. THE TRASH COLUMNS + THE RLS PREDICATE
-- =============================================================================

alter table projects
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references profiles(id) on delete set null;

comment on column projects.deleted_at is
  'Set by trash_project(), cleared by restore_project() within 30 days, then purge_project() erases the row for good (owner-only sweep, purge_expired_projects via pg_cron). Non-owners never see a non-null row (RLS). RPC-only — see the column revoke below.';

-- Column-level lock — done STRUCTURALLY, because the is_test / status
-- precedent (20260933000000 / 20260941000000) never actually held: Postgres
-- privileges are additive, so a bare `revoke update (col)` does nothing
-- while the table-level UPDATE grant stands. Proved against production
-- 2026-08-28: an installer login's zero-row PATCH naming `status` returned
-- 200, not 42501. So this migration revokes the TABLE-level write grants
-- and grants back exactly the columns the app writes directly
-- (createProject / updateProject in lib/api.ts, setBidAndMargin in
-- lib/costing.ts, the estimate write in lib/install/api.ts). Everything
-- else — is_test, status, status_changed_at, green_light*, deleted_at,
-- deleted_by — is now writable only through its SECURITY DEFINER RPC,
-- which is what those migrations' comments always claimed.
-- LAW for future migrations: a new app-writable projects column must be
-- added to the grant lists below, or direct writes to it will 42501.
revoke insert, update on table projects from anon, authenticated;
grant insert (job_code, name, address, customer_name, contact_phone,
              contact_email, site_state, unit_number, start_date, end_date,
              notes)
  on projects to authenticated;
grant update (name, address, customer_name, contact_phone, contact_email,
              site_state, unit_number, start_date, end_date, notes,
              bid_amount, target_margin_pct,
              estimated_minutes, estimated_crew, estimated_at)
  on projects to authenticated;

-- SELECT: hidden means hidden, via RLS, once — not a filter repeated at every
-- read site (the soft-delete-openings lesson). Wraps the CURRENT policy
-- (20260950000000's three-branch OR: not-test-or-supervisor, or a granted
-- partner) with one more predicate: a trashed row is invisible to everyone
-- except the owner, who needs to see it (that IS the trash list). Crucially
-- this wraps the WHOLE existing predicate, so the partner grant branch
-- cannot leak a trashed job either — a granted partner must not keep seeing
-- a job the company just deleted for the 30-day window it's sitting in trash.
drop policy if exists "projects_select_visible" on projects;
create policy "projects_select_visible" on projects
  for select to authenticated using (
    (deleted_at is null or public.my_role_rank() >= 3)
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

-- UPDATE: a trashed job refuses normal edits (a stale open tab must not be
-- able to edit a job someone just trashed). restore_project is the only way
-- back, and it is SECURITY DEFINER — it bypasses this policy entirely, same
-- as restore_opening bypasses openings_update_live's `removed_at is null`.
drop policy if exists "projects_update" on projects;
create policy "projects_update" on projects
  for update to authenticated using (deleted_at is null) with check (true);


-- =============================================================================
-- 3. delete_project: AUDIT HOLE 1 — the payroll/openings guards are dead
-- =============================================================================
-- delete_project (20260941000000) checks `from openings` (no such table —
-- the real table is project_openings) and, three lines later, guards
-- `to_regclass('public.shifts')` (no such table either — the real table is
-- time_shifts, 20260717001000) with `is not null`, so that branch can never
-- run. Both guards are permanent no-ops: as written, an owner could
-- hard-delete a job carrying real openings or clocked payroll shifts with no
-- refusal at all. The smallest honest fix: point the checks at the tables
-- that actually exist. delete_project stays reachable (nothing else calls it
-- after this migration repoints the one UI path at trash_project — see the
-- PR body) rather than being dropped outright, because a correctly-guarded
-- "delete an untouched empty shell instantly" door is still occasionally
-- useful and safe now that its guards are honest; a broken guard pretending
-- to protect something is what actually needed to go.

create or replace function public.delete_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only an owner can delete a job.' using errcode = '42501';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'That job does not exist.';
  end if;

  select count(*) into v_n from packages where project_id = p_project;
  if v_n > 0 then
    raise exception 'This job has % tracked package%. Complete or cancel it instead — deleting would erase where material went.',
      v_n, case when v_n = 1 then '' else 's' end;
  end if;
  select count(*) into v_n from project_openings where project_id = p_project;
  if v_n > 0 then
    raise exception 'This job has % opening% on its plans. Complete or cancel it instead.',
      v_n, case when v_n = 1 then '' else 's' end;
  end if;
  select count(*) into v_n from time_shifts where project_id = p_project;
  if v_n > 0 then
    raise exception 'This job has % clocked shift%. Complete or cancel it instead — hours are payroll.',
      v_n, case when v_n = 1 then '' else 's' end;
  end if;

  delete from project_marks where project_id = p_project;
  delete from sandbox_projects where project_id = p_project;
  delete from projects where id = p_project;
end;
$$;

revoke all on function public.delete_project(uuid) from public, anon;
grant execute on function public.delete_project(uuid) to authenticated;


-- =============================================================================
-- 4. SCHEMA PREP FOR DETACH: job-name columns + NOT NULL / FK-action fixes
-- =============================================================================
-- Tables the policy says DETACH (row survives, project_id -> null) but that
-- have no existing text column to remember which job they came from get a
-- dedicated `job_name` — never reusing a column with its own job (windows /
-- service_cases / incidents / trips all have free-text fields already
-- spoken for by something else; a fresh column costs nothing and can't
-- collide). packages and receipts already have pending_job_name for exactly
-- this — reused as-is, the policy's own "prefer existing columns" call.

alter table movements add column if not exists job_name text;
alter table windows add column if not exists job_name text;
alter table time_shifts add column if not exists job_name text;
alter table incidents add column if not exists job_name text;
alter table service_cases add column if not exists job_name text;
alter table trips add column if not exists job_name text;

-- AUDIT HOLE 2: job_costs.project_id and change_orders.project_id are NOT
-- NULL (20260717002000); daily_logs.project_id is NOT NULL (20260949000000).
-- A detach's `set project_id = null` would fail every one of these with a
-- not-null violation and abort the whole purge transaction. Drop the NOT
-- NULLs, add job_name, and (defense in depth, matching every other detach
-- FK already being SET NULL) change the FK action from CASCADE to SET NULL —
-- purge_project always nulls these before it ever deletes the projects row,
-- so the CASCADE would in practice never fire, but a future direct delete of
-- a projects row (there should be none — see section 1) must degrade to
-- "orphaned money record" rather than "silently destroyed money record."
--
-- issues.project_id is also NOT NULL (20260718005000) and needs the same
-- NOT NULL drop for the one open-question carve-out this migration keeps:
-- a damage report tied to a package that survives (detaches WITH the
-- package) rather than being purged with the rest of the job's issues.
--
-- Constraint names are looked up from pg_catalog rather than guessed, since
-- nothing in this repo has ever renamed an inline unnamed FK before — safer
-- than assuming Postgres's default `<table>_<column>_fkey` naming held.

do $$
declare
  v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.job_costs'::regclass
     and confrelid = 'public.projects'::regclass and contype = 'f';
  if v_conname is not null then
    execute format('alter table job_costs drop constraint %I', v_conname);
  end if;
end;
$$;
alter table job_costs alter column project_id drop not null;
alter table job_costs add constraint job_costs_project_id_fkey
  foreign key (project_id) references projects(id) on delete set null;
alter table job_costs add column if not exists job_name text;

do $$
declare
  v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.change_orders'::regclass
     and confrelid = 'public.projects'::regclass and contype = 'f';
  if v_conname is not null then
    execute format('alter table change_orders drop constraint %I', v_conname);
  end if;
end;
$$;
alter table change_orders alter column project_id drop not null;
alter table change_orders add constraint change_orders_project_id_fkey
  foreign key (project_id) references projects(id) on delete set null;
alter table change_orders add column if not exists job_name text;

do $$
declare
  v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.daily_logs'::regclass
     and confrelid = 'public.projects'::regclass and contype = 'f';
  if v_conname is not null then
    execute format('alter table daily_logs drop constraint %I', v_conname);
  end if;
end;
$$;
alter table daily_logs alter column project_id drop not null;
alter table daily_logs add constraint daily_logs_project_id_fkey
  foreign key (project_id) references projects(id) on delete set null;
alter table daily_logs add column if not exists job_name text;
-- unique (project_id, log_date) needs no change: Postgres treats every NULL
-- as distinct from every other NULL in a plain unique constraint (no NULLS
-- NOT DISTINCT was ever declared here), so any number of detached logs can
-- share project_id = null and a log_date without colliding. Verified rather
-- than assumed — the census's own note flagged this as worth rethinking;
-- rethought, and it turns out to already be safe.

do $$
declare
  v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.issues'::regclass
     and confrelid = 'public.projects'::regclass and contype = 'f';
  if v_conname is not null then
    execute format('alter table issues drop constraint %I', v_conname);
  end if;
end;
$$;
alter table issues alter column project_id drop not null;
alter table issues add constraint issues_project_id_fkey
  foreign key (project_id) references projects(id) on delete set null;

-- AUDIT HOLES 3+4: attachments.project_id and attachments.install_event_id
-- are both ON DELETE CASCADE today (20260721002000 / 20260715120000). Every
-- install-capture upload writes a row with window_id, install_event_id AND
-- project_id all set at once (installOutbox.ts) — under the current CASCADE,
-- purging (or, before section 1's fix, even just hard-deleting) a project
-- would destroy every install photo on every window, even windows that
-- themselves survive. Changed to SET NULL so a row anchored to a surviving
-- window/package/service_case degrades to "unlinked from the install event
-- and the job" instead of disappearing; purge_project below still always
-- nulls these explicitly first (so the CASCADE-vs-SET-NULL distinction is
-- belt and suspenders, same reasoning as job_costs above), and explicitly
-- DELETEs the rows that have no surviving anchor before it ever reaches this
-- FK at all.

do $$
declare
  v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.attachments'::regclass
     and confrelid = 'public.projects'::regclass and contype = 'f';
  if v_conname is not null then
    execute format('alter table attachments drop constraint %I', v_conname);
  end if;
end;
$$;
alter table attachments add constraint attachments_project_id_fkey
  foreign key (project_id) references projects(id) on delete set null;

do $$
declare
  v_conname text;
begin
  select conname into v_conname from pg_constraint
   where conrelid = 'public.attachments'::regclass
     and confrelid = 'public.install_events'::regclass and contype = 'f';
  if v_conname is not null then
    execute format('alter table attachments drop constraint %I', v_conname);
  end if;
end;
$$;
alter table attachments add constraint attachments_install_event_id_fkey
  foreign key (install_event_id) references install_events(id) on delete set null;


-- =============================================================================
-- 5. package_marks: OPEN Q3 — the ADR-0004 RESTRICT, resolved without ever
--    dropping a tag's meaning off a surviving package
-- =============================================================================
-- package_marks.mark_id -> project_marks(id) is ON DELETE RESTRICT
-- (20260822000000, "deleting a mark someone tagged packages under should
-- fail loudly, not silently strip the tags off crates in the yard"). Purging
-- a job's project_marks would hit that RESTRICT and abort the whole purge
-- the moment any surviving (detached) package still carries one of its tags
-- — which is the common case, since packages detach and marks purge.
--
-- Resolution: reintroduce package_marks.mark_code (the exact pre-FK shape
-- this same migration replaced in 20260822000000) as a plain snapshot
-- column, and let mark_id go null once its target mark is gone — the box
-- keeps a human-readable "this was mark 16" even though the live FK to the
-- job's canonical mark row no longer exists. mark_id carrying the PRIMARY
-- KEY meant it could never be null, so the PK moves to a surrogate id and a
-- plain (non-PK) unique index keeps the old "no duplicate live tag" rule —
-- a unique index, unlike a primary key, allows any number of NULLs, so many
-- purge-orphaned label rows can coexist per package without colliding.
--
-- ADR-0004 itself (docs/adr/0004-location-is-inherited-not-stored.md) does
-- not spell out the RESTRICT invariant by name — it is 20260822000000's own
-- comment that does ("deleting a mark ... should fail loudly") — so there is
-- no ADR sentence to edit; a short paragraph is appended to the ADR file in
-- this PR instead, documenting this exception where the next reader will
-- actually look for it.

alter table package_marks add column if not exists mark_code text;

alter table package_marks add column if not exists id uuid;
update package_marks set id = gen_random_uuid() where id is null;
alter table package_marks alter column id set not null;
alter table package_marks alter column id set default gen_random_uuid();

alter table package_marks drop constraint if exists package_marks_pkey;
alter table package_marks add primary key (id);
alter table package_marks alter column mark_id drop not null;
create unique index if not exists package_marks_package_mark_uniq
  on package_marks (package_id, mark_id);

comment on column package_marks.mark_code is
  'Snapshot of the mark''s label (the pre-FK shape package_marks carried before 20260822000000), written only when a purge unlinks mark_id — the box keeps a readable "what was in here" even after the canonical project_marks row is gone. Null on every ordinary, still-linked tag.';


-- =============================================================================
-- 6. trash_project / restore_project — owner-only, the void_shift voice
-- =============================================================================

create or replace function public.trash_project(p_project_id uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only the owner can delete a job.' using errcode = '42501';
  end if;

  select * into v_row from projects where id = p_project_id for update;
  if v_row.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'That job is already in the trash.';
  end if;

  update projects
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_project_id
  returning * into v_row;

  -- The Horizon fake-success lesson (cited verbatim in void_shift,
  -- 20260944000000): an UPDATE matching nothing must never be reported back
  -- as though the trash happened. Unreachable today given the row lock
  -- above; kept explicit so a future refactor that drops the lock still
  -- fails loudly instead of lying.
  if v_row.id is null then
    raise exception 'trash did not apply to job % — no row was updated', p_project_id;
  end if;

  return v_row;
end;
$$;

comment on function public.trash_project(uuid) is
  'Owner-only: moves a job to the 30-day trash (deleted_at/deleted_by). Refuses a job already in the trash or that does not exist. Undo via restore_project(); permanent erase via purge_project() after 30 days (nightly sweep) or directly by the owner.';

revoke all on function public.trash_project(uuid) from public, anon;
grant execute on function public.trash_project(uuid) to authenticated;


create or replace function public.restore_project(p_project_id uuid)
returns projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row projects;
begin
  if public.my_role_rank() < 3 then
    raise exception 'Only the owner can undo a deleted job.' using errcode = '42501';
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
     set deleted_at = null, deleted_by = null
   where id = p_project_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'restore did not apply to job % — no row was updated', p_project_id;
  end if;

  return v_row;
end;
$$;

comment on function public.restore_project(uuid) is
  'Owner-only: undoes a trash within the 30-day window (clears deleted_at/deleted_by). Refuses a job not in the trash, and refuses past the 30-day deadline even if the nightly sweep has not run yet — the same instant purge_expired_projects would sweep it.';

revoke all on function public.restore_project(uuid) from public, anon;
grant execute on function public.restore_project(uuid) to authenticated;


-- =============================================================================
-- 7. purge_project — the permanent erase (35-step dependency-safe order)
-- =============================================================================
-- Callable directly by the owner (purge early — the RPC allows it; the UI
-- does not offer it yet) and by the nightly sweep, which runs with no JWT at
-- all (pg_cron's SQL execution has no auth.uid() — the same "no JWT: a
-- migration or the service key, both already trusted above RLS" shape
-- guard_opening_removal already relies on, 20260730210000). Refuses only
-- "does not exist" and "not in the trash" — the sweep is trusted to only
-- ever feed already-expired ids, and a direct owner call may purge whatever
-- is currently in the trash regardless of how long it has been there.

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
  if auth.uid() is not null and public.my_role_rank() < 3 then
    raise exception 'Only the owner can permanently delete a job.' using errcode = '42501';
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
  -- unit_sessions/project_opening_pin_moves all cascade from
  -- project_openings (verified against each table's own migration) — one
  -- delete of the parent takes the whole branch, the same reasoning
  -- delete_test_project already relies on for package_marks/package_events
  -- cascading off packages. project_planset_pages cascades from
  -- project_plansets the same way.
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
  -- unit_redos, unit_sessions and project_opening_pin_moves with it.
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
  'The permanent erase: owner-callable directly, and fed expired ids by purge_expired_projects (nightly pg_cron sweep, no auth.uid() in that context — trusted the same way a migration or the service key is). Refuses a job that does not exist or is not currently in the trash; does NOT re-check the 30-day deadline itself, since the sweep is trusted to only ever pass already-expired ids and a direct owner call may purge early. Runs the full detach-then-purge order the census specifies, including the ADR-0004 package_marks unlink and the attachments dual-anchor split.';

revoke all on function public.purge_project(uuid) from public, anon;
grant execute on function public.purge_project(uuid) to authenticated;


-- =============================================================================
-- 8. purge_expired_projects — the nightly sweep (pg_cron, pure SQL)
-- =============================================================================
-- Copies the summon 5-minute-warning migration's idempotent unschedule-then-
-- schedule pattern (20260918000000) exactly, with one deliberate departure:
-- that job pokes an UNAUTHENTICATED edge function (verify_jwt=false) because
-- the worst an anonymous poke can do is trigger an extra push notification.
-- This sweep is destructive, so it never leaves SQL at all — no pg_net HTTP
-- hop to a function anyone could poke, just a direct call under cron's own
-- trusted, JWT-less execution context (see purge_project's own auth.uid()
-- is null branch).

create or replace function public.purge_expired_projects()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  for v_id in
    select id from projects
     where deleted_at is not null and deleted_at < now() - interval '30 days'
  loop
    -- A nested block, not a bare call: it gives each project its own
    -- implicit savepoint, so one job hitting an unexpected error doesn't
    -- roll back and silently skip every OTHER already-expired job in the
    -- same nightly run. The failure still surfaces (RAISE WARNING reaches
    -- the Postgres log Supabase exposes) rather than being swallowed.
    begin
      perform public.purge_project(v_id);
    exception when others then
      raise warning 'purge_expired_projects: job % failed to purge: %', v_id, sqlerrm;
    end;
  end loop;
end;
$$;

comment on function public.purge_expired_projects() is
  'Nightly sweep (pg_cron, ''purge-expired-projects''): purges every job whose 30-day trash window has actually passed. Each job runs in its own sub-transaction (savepoint) so one failure does not block the rest of the night''s run; failures are logged via RAISE WARNING, never swallowed silently.';

revoke all on function public.purge_expired_projects() from public, anon;
grant execute on function public.purge_expired_projects() to authenticated, service_role;

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('purge-expired-projects');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

select cron.schedule(
  'purge-expired-projects',
  '0 7 * * *',   -- once nightly; the exact minute doesn't matter, past-due is past-due
  $$ select public.purge_expired_projects(); $$
);


-- =============================================================================
-- 9. D3 — the partner wall during the 30-day trash window (AUDIT HOLE 6)
-- =============================================================================
-- stg_calendar and stg_day (20260952000000) are SECURITY DEFINER and never
-- read the projects table at all — a trashed job keeps leaking install
-- windows, deliveries, worked days, and a shared daily log to a granted
-- partner login for the whole 30-day window otherwise. Recreated with an
-- explicit deleted-project filter in all three (stg_job_list already joins
-- projects — re-checked, and it needed the same filter added), mandatory in
-- every one rather than only suspending grants at trash time (the audit's
-- "or" branch): a filter here holds regardless of whether some future write
-- path forgets to touch partner_job_grants.

create or replace function public.stg_job_list()
returns table (
  id uuid,
  name text,
  job_code text,
  status text,
  progress_percent int,
  window_start date,
  window_end date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;

  return query
  select
    p.id,
    p.name,
    p.job_code,
    p.status,
    greatest(
      case when p.status = 'completed' then 100 else 0 end,
      coalesce(
        (
          select round(
            100.0 * count(*) filter (where o.status = 'installed')
            / nullif(count(*), 0)
          )::int
          from project_openings o
          where o.project_id = p.id and o.removed_at is null
        ),
        0
      )
    ) as progress_percent,
    (
      select min(sa.start_date) from schedule_assignments sa
      where sa.kind = 'install' and sa.project_id = p.id
    ) as window_start,
    (
      select max(sa.end_date) from schedule_assignments sa
      where sa.kind = 'install' and sa.project_id = p.id
    ) as window_end
  from projects p
  join partner_job_grants g on g.project_id = p.id
  where g.partner_profile_id = auth.uid()
    and p.deleted_at is null
  order by p.name;
end;
$$;

comment on function public.stg_job_list() is
  'Partner-only: every job granted to the calling builder login, field by field (never select *). Progress is a status floor (completed -> 100) vs. the openings ratio, whichever is greater. Excludes a trashed job (deleted_at is null) — Wave D.';

revoke all on function public.stg_job_list() from public, anon;
grant execute on function public.stg_job_list() to authenticated;


create or replace function public.stg_calendar(p_from date, p_to date)
returns table (
  project_id uuid,
  kind text,
  on_date date,
  from_date date,
  to_date date,
  label text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;

  return query
  select
    sa.project_id,
    'window'::text as kind,
    null::date as on_date,
    sa.start_date as from_date,
    sa.end_date as to_date,
    coalesce(nullif(btrim(sa.note), ''), 'Install window') as label
  from schedule_assignments sa
  join partner_job_grants g
    on g.project_id = sa.project_id and g.partner_profile_id = auth.uid()
  where sa.kind = 'install'
    and sa.start_date <= p_to and sa.end_date >= p_from
    and not exists (select 1 from projects pr where pr.id = sa.project_id and pr.deleted_at is not null)

  union all

  select
    g.project_id,
    'delivery'::text,
    sa.start_date,
    null::date,
    null::date,
    coalesce(nullif(btrim(pd.label), ''), 'Delivery')
  from schedule_assignments sa
  join package_deliveries pd on pd.id = sa.delivery_id
  join partner_job_grants g on g.partner_profile_id = auth.uid()
  where sa.kind = 'delivery'
    and sa.start_date between p_from and p_to
    and exists (
      select 1 from packages pk
      where pk.delivery_id = pd.id and pk.project_id = g.project_id
    )
    and not exists (select 1 from projects pr where pr.id = g.project_id and pr.deleted_at is not null)

  union

  select distinct
    g.project_id,
    'worked'::text,
    (ts.clock_in_at at time zone 'America/Denver')::date,
    null::date,
    null::date,
    null::text
  from time_shifts ts
  join partner_job_grants g
    on g.project_id = ts.project_id and g.partner_profile_id = auth.uid()
  where ts.status <> 'voided'
    and (ts.clock_in_at at time zone 'America/Denver')::date between p_from and p_to
    and not exists (select 1 from projects pr where pr.id = g.project_id and pr.deleted_at is not null)

  union

  select distinct
    g.project_id,
    'worked'::text,
    (us.started_at at time zone 'America/Denver')::date,
    null::date,
    null::date,
    null::text
  from unit_sessions us
  join project_openings po on po.id = us.opening_id
  join partner_job_grants g
    on g.project_id = po.project_id and g.partner_profile_id = auth.uid()
  where (us.started_at at time zone 'America/Denver')::date between p_from and p_to
    and not exists (select 1 from projects pr where pr.id = g.project_id and pr.deleted_at is not null);
end;
$$;

comment on function public.stg_calendar(date, date) is
  'Partner-only: install-window spans, deliveries, and worked-day markers for every granted job in [p_from, p_to]. Deliveries are matched to a job through the packages riding in them. Excludes a trashed job (deleted_at is null) in all four branches — Wave D.';

revoke all on function public.stg_calendar(date, date) from public, anon;
grant execute on function public.stg_calendar(date, date) to authenticated;


create or replace function public.stg_day(p_project uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_crew_names text[];
  v_total_hours numeric;
  v_units_finished int;
  v_worked_n int;
  v_logged_n int;
  v_ratio numeric;
  v_log_row daily_logs;
  v_log jsonb := null;
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;
  -- Same refusal text whether the job was never granted or has since been
  -- trashed — a partner should not be able to tell the two apart from the
  -- error message alone.
  if not exists (
    select 1 from partner_job_grants
    where partner_profile_id = auth.uid() and project_id = p_project
  ) or exists (
    select 1 from projects where id = p_project and deleted_at is not null
  ) then
    raise exception 'that job is not granted to this login';
  end if;

  select coalesce(array_agg(distinct dn), '{}')
    into v_crew_names
  from (
    select pr.display_name as dn
    from time_shifts ts
    join profiles pr on pr.id = ts.profile_id
    where ts.project_id = p_project and ts.status <> 'voided'
      and (ts.clock_in_at at time zone 'America/Denver')::date = p_date
    union
    select pr.display_name
    from unit_sessions us
    join project_openings po on po.id = us.opening_id
    join profiles pr on pr.id = us.profile_id
    where po.project_id = p_project
      and (us.started_at at time zone 'America/Denver')::date = p_date
  ) names;

  select coalesce(sum(
    extract(epoch from (ts.clock_out_at - ts.clock_in_at)) / 3600.0
    - ts.break_seconds / 3600.0
  ), 0)
    into v_total_hours
  from time_shifts ts
  where ts.project_id = p_project and ts.status <> 'voided'
    and ts.clock_out_at is not null
    and (ts.clock_in_at at time zone 'America/Denver')::date = p_date;

  select count(*) into v_units_finished
  from install_events ie
  join project_openings po on po.id = ie.project_opening_id
  where po.project_id = p_project
    and ie.voided_at is null
    and (ie.created_at at time zone 'America/Denver')::date = p_date;

  with worked_days as (
    select distinct (ts.clock_in_at at time zone 'America/Denver')::date as d
    from time_shifts ts
    where ts.project_id = p_project and ts.status <> 'voided'
    union
    select distinct (us.started_at at time zone 'America/Denver')::date as d
    from unit_sessions us
    join project_openings po on po.id = us.opening_id
    where po.project_id = p_project
  )
  select
    count(*),
    count(*) filter (
      where d in (select log_date from daily_logs where project_id = p_project)
    )
    into v_worked_n, v_logged_n
  from worked_days;

  v_ratio := case when v_worked_n = 0 then 1.0 else v_logged_n::numeric / v_worked_n end;

  if v_ratio >= 0.70 then
    select * into v_log_row from daily_logs
    where project_id = p_project and log_date = p_date and customer_visible;
    if found then
      v_log := jsonb_build_object(
        'headline', v_log_row.headline,
        'notes', v_log_row.notes,
        'day_flow', v_log_row.day_flow
      );
    end if;
  end if;

  return jsonb_build_object(
    'worked', coalesce(array_length(v_crew_names, 1), 0) > 0,
    'crew_names', v_crew_names,
    'total_hours', round(v_total_hours, 1),
    'units_finished', v_units_finished,
    'log', v_log
  );
end;
$$;

comment on function public.stg_day(uuid, date) is
  'Partner-only, and only for a job actually granted to the caller AND not trashed (Wave D — same refusal text as "not granted" either way): one day''s system facts plus the daily log, gated the same as before (customer_visible AND >=70% log coverage).';

revoke all on function public.stg_day(uuid, date) from public, anon;
grant execute on function public.stg_day(uuid, date) to authenticated;
