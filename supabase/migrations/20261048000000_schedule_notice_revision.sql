-- A cleared schedule digest used to fingerprint assignment ids only, so
-- changing an already-published assignment's date or hours (while its id
-- stayed the same) could remain hidden forever. notice_revision is a
-- server-only counter the Notifications feed folds into that fingerprint
-- instead (app/src/lib/schedule/notices.ts) — existing rows default 0 so
-- every pre-migration cleared digest stays exactly as cleared.
alter table public.schedule_assignments add column if not exists notice_revision integer not null default 0;
alter table public.schedule_assignments add constraint schedule_assignment_notice_revision_nonneg check (notice_revision >= 0);

-- Normalizes notice_revision on every write so it can never be forged by a
-- client UPDATE (even a revision-only one): INSERT sets 1 for a row
-- published outright, 0 otherwise. UPDATE holds it at OLD unless the row is
-- (re)entering 'published' with a changed status or a changed date/time
-- field, in which case it becomes OLD+1 — monotonic, never reset, so an
-- A->B->A round trip still mints two distinct occurrences. Cosmetic fields
-- (color, note, members, published_at, updated_at) never move it; neither
-- does a republish of unchanged timing (the connected workflow's retry and
-- trip-only edits both fall through quiet).
create or replace function public.schedule_assignment_notice_revision() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.notice_revision := case when new.status = 'published' then 1 else 0 end;
    return new;
  end if;
  new.notice_revision := old.notice_revision;
  if new.status = 'published' and (
    new.status is distinct from old.status
    or new.start_date is distinct from old.start_date
    or new.end_date is distinct from old.end_date
    or new.start_time is distinct from old.start_time
    or new.end_time is distinct from old.end_time
  ) then
    new.notice_revision := old.notice_revision + 1;
  end if;
  return new;
end $$;

drop trigger if exists schedule_assignment_notice_revision_trg on public.schedule_assignments;
create trigger schedule_assignment_notice_revision_trg
  before insert or update on public.schedule_assignments
  for each row execute function public.schedule_assignment_notice_revision();

-- Keep the connected-plan source fingerprint blind to this column, the same
-- way it is already blind to a null end_time, so every existing published
-- row (notice_revision defaults to 0) keeps its exact pre-migration
-- fingerprint and remains publishable without a spurious "source changed"
-- refusal. Nothing else in this function changes.
create or replace function public.workflow_snapshot(p_plan uuid) returns jsonb language sql stable security definer
set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'assignments',coalesce((select jsonb_agg((case when a.end_time is null then to_jsonb(a)-'end_time'-'notice_revision' else to_jsonb(a)-'notice_revision' end)||jsonb_build_object('members',
   coalesce((select jsonb_agg(to_jsonb(m) order by m.profile_id) from public.schedule_assignment_members m where m.assignment_id=a.id),'[]'::jsonb)) order by a.id)
   from public.schedule_assignments a join public.workflow_plan_assignments l on l.assignment_id=a.id where l.plan_id=p_plan),'[]'::jsonb),
  'trips',coalesce((select jsonb_agg(jsonb_build_object('trip',to_jsonb(t),
   'crew',coalesce((select jsonb_agg(to_jsonb(c) order by c.profile_id) from public.trip_crew c where c.trip_id=t.id),'[]'::jsonb),
   'flights',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.flights c where c.trip_id=t.id),'[]'::jsonb),
   'lodging',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.lodging c where c.trip_id=t.id),'[]'::jsonb),
   'ground',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.ground_transport c where c.trip_id=t.id),'[]'::jsonb),
   'procedures',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.procedures c where c.trip_id=t.id),'[]'::jsonb),
   'contacts',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.trip_contacts c where c.trip_id=t.id),'[]'::jsonb),
   'attachments',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.trip_attachments c where c.trip_id=t.id),'[]'::jsonb)
   ) order by t.id) from public.trips t join public.workflow_plan_trips l on l.trip_id=t.id where l.plan_id=p_plan),'[]'::jsonb),
  'vehicles',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.vehicle_project_assignments v
   join public.workflow_plan_assignments l on l.assignment_id=v.assignment_id where l.plan_id=p_plan),'[]'::jsonb)
 );
$$;
