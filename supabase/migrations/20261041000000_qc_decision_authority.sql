-- A QC decision is a foreman-or-higher action, even when called outside the
-- Quality screen. Keep qc_checks as the current-state projection used by the
-- existing queue/rollups, and record every new decision separately.

create table public.qc_decision_events (
  id uuid primary key,
  project_opening_id uuid not null references public.project_openings(id) on delete cascade,
  status text not null check (status in ('passed', 'callback')),
  note text,
  reviewer_id uuid references public.profiles(id) on delete set null,
  decided_at timestamptz not null,
  source text not null check (source in ('review', 'legacy_snapshot', 'legacy_client', 'system')),
  created_at timestamptz not null default now()
);

create index qc_decision_events_opening_time
  on public.qc_decision_events(project_opening_id, decided_at desc, id);

-- Earlier QC rows contain only the latest status and generally have no
-- checked_by. Preserve that known state without inventing a historical actor.
insert into public.qc_decision_events
  (id, project_opening_id, status, note, reviewer_id, decided_at, source)
select gen_random_uuid(), project_opening_id, status, note, checked_by,
       coalesce(checked_at, created_at), 'legacy_snapshot'
from public.qc_checks
where status in ('passed', 'callback');

alter table public.qc_decision_events enable row level security;
revoke all on public.qc_decision_events from public, anon, authenticated;
grant select on public.qc_decision_events to authenticated;
grant all on public.qc_decision_events to service_role;

create policy qc_decision_events_read_leads on public.qc_decision_events
  for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 1);

-- The sandbox guard was installed before this new table existed. Attach it
-- explicitly so a test foreman cannot create audit records on a real job.
create trigger guard_test_account_sandbox_only
  before insert or update or delete on public.qc_decision_events
  for each row execute function public.guard_test_account_sandbox_only('project_opening_id', 'opening');

drop policy if exists "authenticated full access" on public.qc_checks;
revoke delete on public.qc_checks from authenticated;
create policy qc_checks_read_crew on public.qc_checks
  for select to authenticated using (not public.is_partner_user());

-- Older installed app builds still upsert qc_checks directly. Restrict that
-- route to real, current foremen+ instead of breaking their QC button before
-- they receive the new client. New builds use record_qc_decision below.
create function public.qc_actor_can_review() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid()
      and p.role in ('foreman', 'lead', 'supervisor', 'admin', 'owner', 'big_boss')
      and p.retired_at is null and p.access_revoked_at is null
      and not public.is_partner_user()
  );
$$;
revoke all on function public.qc_actor_can_review() from public, anon;
grant execute on function public.qc_actor_can_review() to authenticated;

create policy qc_checks_legacy_insert_lead on public.qc_checks
  for insert to authenticated
  with check (public.qc_actor_can_review() and status in ('passed', 'callback'));
create policy qc_checks_legacy_update_lead on public.qc_checks
  for update to authenticated
  using (public.qc_actor_can_review())
  with check (public.qc_actor_can_review() and status in ('passed', 'callback'));

create function public.qc_stamp_legacy_reviewer() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then
    if not public.qc_actor_can_review() then
      raise exception 'Only an active foreman, supervisor or owner can review QC.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.project_openings o
                   where o.id = new.project_opening_id and o.status = 'installed' and o.removed_at is null) then
      raise exception 'This installed unit is unavailable for QC.' using errcode = '22023';
    end if;
    if tg_op = 'UPDATE' and (new.id is distinct from old.id
       or new.project_opening_id is distinct from old.project_opening_id) then
      raise exception 'A QC review cannot be moved to another unit.' using errcode = '42501';
    end if;
    if length(coalesce(new.note, '')) > 4000 then
      raise exception 'Keep the QC note under 4,000 characters.' using errcode = '22023';
    end if;
    if coalesce(current_setting('app.qc_rpc', true), '') <> '1' then
      -- The old app supplied checked_at from the phone and no checked_by.
      -- Trust neither field. A repeat of the same write is not a new review.
      if tg_op = 'UPDATE' and old.status is not distinct from new.status
         and old.note is not distinct from new.note
         and old.checked_by is not distinct from auth.uid() then
        return old;
      end if;
      new.checked_by := auth.uid();
      new.checked_at := clock_timestamp();
    end if;
  end if;
  return new;
end;
$$;
create trigger qc_stamp_legacy_reviewer
  before insert or update on public.qc_checks
  for each row execute function public.qc_stamp_legacy_reviewer();

create function public.qc_archive_legacy_decision() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('app.qc_rpc', true), '') = '1'
     or new.status not in ('passed', 'callback') then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status
     and old.note is not distinct from new.note
     and old.checked_by is not distinct from new.checked_by then return new; end if;
  insert into public.qc_decision_events
    (id, project_opening_id, status, note, reviewer_id, decided_at, source)
  values (gen_random_uuid(), new.project_opening_id, new.status, new.note,
          new.checked_by, coalesce(new.checked_at, clock_timestamp()),
          case when auth.uid() is null then 'system' else 'legacy_client' end);
  return new;
end;
$$;
create trigger qc_archive_legacy_decision
  after insert or update on public.qc_checks
  for each row execute function public.qc_archive_legacy_decision();

create function public.record_qc_decision(
  p_decision_id uuid,
  p_opening_id uuid,
  p_status text,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.qc_decision_events;
  v_inserted uuid;
  v_at timestamptz := clock_timestamp();
  v_note text := nullif(btrim(p_note), '');
begin
  if p_decision_id is null or p_opening_id is null then
    raise exception 'A QC decision and opening are required.' using errcode = '22023';
  end if;
  if p_status not in ('passed', 'callback') or p_status is null then
    raise exception 'Choose Pass or Callback.' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 4000 then
    raise exception 'Keep the QC note under 4,000 characters.' using errcode = '22023';
  end if;
  if v_actor is null or not public.qc_actor_can_review() then
    raise exception 'Only an active foreman, supervisor or owner can review QC.' using errcode = '42501';
  end if;

  -- A repeated request is a no-op, even if the opening was reviewed again
  -- afterward. A reused ID with different contents is never accepted.
  select * into v_existing from public.qc_decision_events where id = p_decision_id;
  if found then
    if v_existing.project_opening_id is distinct from p_opening_id
       or v_existing.status is distinct from p_status
       or v_existing.note is distinct from v_note
       or v_existing.reviewer_id is distinct from v_actor
       or v_existing.source <> 'review' then
      raise exception 'This QC request ID was already used for another decision.' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  perform 1 from public.project_openings o
  where o.id = p_opening_id and o.status = 'installed' and o.removed_at is null
  for update;
  if not found then
    raise exception 'This installed unit is unavailable for QC.' using errcode = '22023';
  end if;

  -- Claim the request ID before touching the current QC row. Concurrent
  -- retries wait on the opening lock or unique key and then become no-ops.
  insert into public.qc_decision_events
    (id, project_opening_id, status, note, reviewer_id, decided_at, source)
  values (p_decision_id, p_opening_id, p_status, v_note, v_actor, v_at, 'review')
  on conflict (id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    select * into v_existing from public.qc_decision_events where id = p_decision_id;
    if v_existing.project_opening_id is distinct from p_opening_id
       or v_existing.status is distinct from p_status
       or v_existing.note is distinct from v_note
       or v_existing.reviewer_id is distinct from v_actor
       or v_existing.source <> 'review' then
      raise exception 'This QC request ID was already used for another decision.' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  -- Keep the direct-write compatibility trigger from also archiving this RPC
  -- decision; the explicit event above carries its stable request UUID.
  perform set_config('app.qc_rpc', '1', true);
  insert into public.qc_checks(project_opening_id, status, note, checked_by, checked_at)
  values (p_opening_id, p_status, v_note, v_actor, v_at)
  on conflict (project_opening_id) do update
    set status = excluded.status, note = excluded.note,
        checked_by = excluded.checked_by, checked_at = excluded.checked_at;

  -- The QC projection, history, and pending-point resolution commit together.
  -- Existing points rules intentionally do not reopen already-settled rows.
  perform public.resolve_install_points(
    p_opening_id::text,
    case when p_status = 'passed' then 'confirmed' else 'void' end
  );

  return p_decision_id;
end;
$$;

revoke all on function public.record_qc_decision(uuid, uuid, text, text) from public, anon;
grant execute on function public.record_qc_decision(uuid, uuid, text, text) to authenticated;

comment on function public.record_qc_decision(uuid, uuid, text, text) is
  'Foreman+ QC decision with server-verified reviewer, immutable decision event, current status, and atomic pending-points resolution. The request UUID makes exact retries safe.';

-- Recheck every project-scoped table against the current sandbox fence. The
-- explicit trigger above protects this table even before that census runs.
select public.attach_sandbox_guards();
