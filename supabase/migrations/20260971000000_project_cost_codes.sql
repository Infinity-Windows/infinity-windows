-- Cost codes that fit the job you're on (standard-tracking-jobs slice 3, 2026-09-03).
--
-- WHY (owner ask, service billing): a service / tracking job doesn't want the
-- whole company cost-code library at clock-in — it wants the handful that apply
-- (a service call, a warranty visit), plus a general catch-all so nobody is ever
-- stuck with nothing valid to pick. This is the Horizon "project cost codes"
-- shape: a company-wide library with an OPTIONAL per-job subset. A job with no
-- subset behaves exactly as today (the full active list); a job WITH a subset
-- shows only those, and the clock-in picker always folds in the general fallback.
--
-- Precedent followed: project_openings / daily_logs (a project-scoped child
-- table, RPC-only writes, RLS select for crew) and set_project_modes
-- (20260970000000 — a foreman+ SECURITY DEFINER writer).

-- ---------------------------------------------------------------------------
-- 1. The general fallback marker on the company library
-- ---------------------------------------------------------------------------
-- getClockCostCodesForProject (app/src/lib/costCodes.ts) ALWAYS includes a
-- general fallback code, so a job whose subset is, say, just "Service call"
-- still lets a worker charge general time. That fallback has to be a real code
-- the picker can point at; the library shipped with none. is_general marks the
-- one general code — a hidden flag (the management screen never edits it), so a
-- rename or an archive of another code can't accidentally move the fallback.
alter table cost_codes
  add column if not exists is_general boolean not null default false;

comment on column cost_codes.is_general is
  'The one general / catch-all cost code the clock-in picker always folds in as a fallback (getClockCostCodesForProject). Hidden from the management UI so it stays put. Exactly one code should carry this.';

-- Seed the general fallback (code 000 so it reads and sorts first) and the two
-- service codes this slice is about. codes chosen to not collide with the
-- shipped 100/110/200/300/400/900. cost_codes.code has no unique constraint, so
-- a guarded not-exists insert (rather than on conflict) keeps this idempotent
-- and safe to re-run without duplicating a code.
insert into cost_codes (code, label, description, sort_order, is_general)
select v.code, v.label, v.description, v.sort_order, v.is_general
from (values
  ('000', 'General', 'General labor / anything not covered by a specific code', 5, true),
  ('500', 'Service call', 'A service visit on an installed job', 70, false),
  ('600', 'Warranty', 'Warranty work — no charge to the customer', 80, false)
) as v(code, label, description, sort_order, is_general)
where not exists (select 1 from cost_codes cc where cc.code = v.code);

-- If a "000 General" row already existed (seeded by hand, or before this flag)
-- make sure it carries is_general.
update cost_codes set is_general = true where code = '000' and is_general = false;

-- ---------------------------------------------------------------------------
-- 2. project_cost_codes: a job's pickable subset
-- ---------------------------------------------------------------------------
-- The optional per-job subset. Empty for a job means "no subset" — the picker
-- falls back to the whole active library, which is every job that exists today.
create table if not exists project_cost_codes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid not null references cost_codes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, cost_code_id)
);

create index if not exists project_cost_codes_project_idx
  on project_cost_codes (project_id);

-- RLS: crew (any signed-in non-partner) READ their job's subset so the clock-in
-- picker can scope itself; writes go only through the foreman+ RPCs below, which
-- are SECURITY DEFINER and bypass RLS — so there is no write policy at all, the
-- same RPC-only shape daily_logs / timecard_periods use. Partner logins never
-- see it (THE WALL).
alter table project_cost_codes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_cost_codes' and policyname = 'project_cost_codes read'
  ) then
    create policy "project_cost_codes read" on project_cost_codes
      for select to authenticated
      using (not public.is_partner_user());
  end if;
end;
$$;

-- The RPCs are the only writers: revoke the table-level write grants so a plain
-- PostgREST insert/delete can't bypass the foreman+ gate.
revoke insert, update, delete on table project_cost_codes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set / add / remove the job's subset (foreman+)
-- ---------------------------------------------------------------------------
-- Replace the whole subset in one call — what the per-job editor saves. An empty
-- array clears the subset (the job goes back to the full library).
create or replace function public.set_project_cost_codes(
  p_project_id uuid,
  p_cost_code_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can set a job''s cost codes';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'that job does not exist';
  end if;

  delete from project_cost_codes where project_id = p_project_id;

  insert into project_cost_codes (project_id, cost_code_id)
  select p_project_id, cc.id
  from cost_codes cc
  where cc.id = any (coalesce(p_cost_code_ids, '{}'::uuid[]))
  on conflict (project_id, cost_code_id) do nothing;
end;
$$;

comment on function public.set_project_cost_codes(uuid, uuid[]) is
  'Replace a job''s pickable cost-code subset (foreman+). An empty array clears it — the job falls back to the full active library at clock-in. Unknown ids are dropped rather than trusted.';

revoke all on function public.set_project_cost_codes(uuid, uuid[]) from public;
grant execute on function public.set_project_cost_codes(uuid, uuid[]) to authenticated;

create or replace function public.add_project_cost_code(
  p_project_id uuid,
  p_cost_code_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can change a job''s cost codes';
  end if;
  if not exists (select 1 from cost_codes where id = p_cost_code_id) then
    raise exception 'that cost code does not exist';
  end if;

  insert into project_cost_codes (project_id, cost_code_id)
  values (p_project_id, p_cost_code_id)
  on conflict (project_id, cost_code_id) do nothing;
end;
$$;

comment on function public.add_project_cost_code(uuid, uuid) is
  'Add one cost code to a job''s pickable subset (foreman+). Idempotent.';

revoke all on function public.add_project_cost_code(uuid, uuid) from public;
grant execute on function public.add_project_cost_code(uuid, uuid) to authenticated;

create or replace function public.remove_project_cost_code(
  p_project_id uuid,
  p_cost_code_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can change a job''s cost codes';
  end if;

  delete from project_cost_codes
  where project_id = p_project_id and cost_code_id = p_cost_code_id;
end;
$$;

comment on function public.remove_project_cost_code(uuid, uuid) is
  'Remove one cost code from a job''s pickable subset (foreman+). No-op if it was not in the subset.';

revoke all on function public.remove_project_cost_code(uuid, uuid) from public;
grant execute on function public.remove_project_cost_code(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Job photos: soft-delete + a 30-day recoverable trash
-- ---------------------------------------------------------------------------
-- A blurry or wrong job photo should be removable without being gone: a foreman
-- deletes it, it drops off the feed, and there are 30 days to bring it back
-- before the nightly sweep erases it and its file for good. attachments had no
-- soft-delete, so this adds one — the SAME void-then-30-days-then-purge shape as
-- projects' trash (20260959000000), on the row rather than a new model. Only job
-- photos reach it (that is what the RPCs touch); the install-capture before/after
-- proof is untouched.
alter table attachments
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references profiles(id) on delete set null;

comment on column attachments.deleted_at is
  'Set by soft_delete_job_photo(), cleared by restore_job_photo() within 30 days, then purge_expired_job_photos() erases the row and its storage object (nightly pg_cron). The feed hides a non-null row. RPC-only — the column write is revoked below.';

-- deleted_at / deleted_by are written ONLY by the RPCs, so a stale open tab (or a
-- direct PATCH) can't hide a photo without the audit. Column privileges are
-- enforced independently of the open row-level policy, the is_test / allowed_modes
-- precedent (20260933000000 / 20260970000000).
revoke update (deleted_at, deleted_by) on table attachments from anon, authenticated;

create or replace function public.soft_delete_job_photo(p_id uuid)
returns attachments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row attachments;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can remove a job photo';
  end if;

  update attachments
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_id and deleted_at is null
  returning * into v_row;

  -- The Horizon fake-success lesson (void_shift, 20260944000000): an UPDATE that
  -- matched nothing must never report success. Either the id is unknown or it is
  -- already in the trash — say so rather than returning a null row.
  if v_row.id is null then
    raise exception 'that photo does not exist, or is already removed';
  end if;
  return v_row;
end;
$$;

comment on function public.soft_delete_job_photo(uuid) is
  'Foreman+: move a job photo to the 30-day trash (deleted_at/deleted_by). Refuses one already removed. Undo via restore_job_photo(); permanent erase via purge_expired_job_photos() after 30 days.';

revoke all on function public.soft_delete_job_photo(uuid) from public;
grant execute on function public.soft_delete_job_photo(uuid) to authenticated;

create or replace function public.restore_job_photo(p_id uuid)
returns attachments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row attachments;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a foreman or above can restore a job photo';
  end if;

  select * into v_row from attachments where id = p_id for update;
  if v_row.id is null then
    raise exception 'that photo does not exist';
  end if;
  if v_row.deleted_at is null then
    raise exception 'that photo is not in the trash';
  end if;
  -- Exact 30-day promise, regardless of when the nightly sweep last ran — the
  -- same boundary restore_project holds.
  if now() >= v_row.deleted_at + interval '30 days' then
    raise exception 'the 30 days are up — this photo is gone for good';
  end if;

  update attachments
     set deleted_at = null, deleted_by = null
   where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.restore_job_photo(uuid) is
  'Foreman+: undo a job-photo delete within the 30-day window (clears deleted_at/deleted_by). Refuses a photo not in the trash, and refuses past the 30-day deadline even if the nightly sweep has not run yet.';

revoke all on function public.restore_job_photo(uuid) from public;
grant execute on function public.restore_job_photo(uuid) to authenticated;

-- The nightly erase. Runs under cron with no auth.uid() (trusted the same way a
-- migration is — the sandbox guard returns early when auth.uid() is null). Files
-- go first so a crash mid-sweep leaves a harmless orphan file, never a row
-- pointing at a file already gone (purge_project's own ordering). storage_path is
-- "bucket/path"; split it to reach storage.objects.
create or replace function public.purge_expired_job_photos()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from storage.objects o
   using attachments a
   where a.deleted_at is not null
     and a.deleted_at < now() - interval '30 days'
     and o.bucket_id = split_part(a.storage_path, '/', 1)
     and o.name = substr(a.storage_path, strpos(a.storage_path, '/') + 1);

  delete from attachments
   where deleted_at is not null
     and deleted_at < now() - interval '30 days';
end;
$$;

comment on function public.purge_expired_job_photos() is
  'Nightly sweep (pg_cron, ''purge-expired-job-photos''): erases every job photo whose 30-day trash window has passed, file then row. Trusted JWT-less cron context, same as purge_expired_projects.';

revoke all on function public.purge_expired_job_photos() from public, anon;
grant execute on function public.purge_expired_job_photos() to authenticated, service_role;

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('purge-expired-job-photos');
exception when others then
  null; -- first run: nothing scheduled yet
end;
$$;

select cron.schedule(
  'purge-expired-job-photos',
  '30 7 * * *',   -- once nightly, just after the job-trash sweep; past-due is past-due
  $$ select public.purge_expired_job_photos(); $$
);

-- ---------------------------------------------------------------------------
-- 5. Arm the test-login fence on the new project-scoped table
-- ---------------------------------------------------------------------------
-- project_cost_codes is project-scoped (project_id), so a QA test login could
-- otherwise write it on ANY job. attach_sandbox_guards() (20260967000000) puts
-- the guard on it; scripts/test_sandbox_guard.py fails CI if this call is
-- missing, and scripts/verify-sandbox-guard.sh fails the deploy if it did not
-- take. Must be in THIS file — a later migration's arming call has already run
-- by the time this table lands.
select public.attach_sandbox_guards();
