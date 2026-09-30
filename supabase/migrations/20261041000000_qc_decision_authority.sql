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
  source text not null check (source in ('review', 'legacy_snapshot')),
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
revoke insert, update, delete on public.qc_checks from authenticated;
create policy qc_checks_read_crew on public.qc_checks
  for select to authenticated using (not public.is_partner_user());

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

  if v_actor is null or public.is_partner_user() or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role in ('foreman', 'lead', 'supervisor', 'admin', 'owner', 'big_boss')
      and p.retired_at is null and p.access_revoked_at is null
  ) then
    raise exception 'Only an active foreman, supervisor or owner can review QC.' using errcode = '42501';
  end if;

  perform 1 from public.project_openings o
  where o.id = p_opening_id and o.status = 'installed' and o.removed_at is null
  for update;
  if not found then
    raise exception 'This installed unit is unavailable for QC.' using errcode = '22023';
  end if;

  insert into public.qc_checks(project_opening_id, status, note, checked_by, checked_at)
  values (p_opening_id, p_status, v_note, v_actor, v_at)
  on conflict (project_opening_id) do update
    set status = excluded.status, note = excluded.note,
        checked_by = excluded.checked_by, checked_at = excluded.checked_at;

  insert into public.qc_decision_events
    (id, project_opening_id, status, note, reviewer_id, decided_at, source)
  values (p_decision_id, p_opening_id, p_status, v_note, v_actor, v_at, 'review');

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
