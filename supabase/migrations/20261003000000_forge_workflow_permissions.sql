-- Enforce the existing Schedule/Travel UI boundaries at the database edge.
-- No business rows are rewritten. Crew job-level vehicle links remain editable;
-- links belonging to a scheduled crew block follow Schedule's supervisor rule.

create or replace function public.travel_can_read_trip(p_trip uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and not public.is_partner_user() and (
    public.travel_is_supervisor() or exists (
      select 1 from public.trips t join public.trip_crew c on c.trip_id = t.id
      where t.id = p_trip and t.status = 'published' and c.profile_id = auth.uid()
    )
  );
$$;
revoke all on function public.travel_can_read_trip(uuid) from public, anon;
grant execute on function public.travel_can_read_trip(uuid) to authenticated, service_role;

-- Definer lookup avoids recursive RLS on trip_attachments. A boarding pass
-- follows the passenger's flight, including when a stale/malformed attachment
-- points across trips. Managers retain access so they can repair old metadata.
create or replace function public.travel_can_read_attachment(p_attachment uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and not public.is_partner_user() and exists (
    select 1 from public.trip_attachments a where a.id = p_attachment and (
      public.travel_is_supervisor() or (
        public.travel_can_read_trip(a.trip_id)
        and split_part(a.storage_path, '/', 1) = a.trip_id::text
        and (a.flight_id is null or exists (
          select 1 from public.flights f where f.id = a.flight_id and f.trip_id = a.trip_id
            and (f.profile_id is null or f.profile_id = auth.uid())
        ))
        and (a.lodging_id is null or exists (
          select 1 from public.lodging l where l.id = a.lodging_id and l.trip_id = a.trip_id
        ))
      )
    )
  );
$$;
revoke all on function public.travel_can_read_attachment(uuid) from public, anon;
grant execute on function public.travel_can_read_attachment(uuid) to authenticated, service_role;

-- Keep read-only calendar consumers working, including foreman boards and
-- job context lookups. Mutation is checked against the REAL database profile.
drop policy if exists "authenticated full access" on public.schedule_assignments;
drop policy if exists "schedule internal read" on public.schedule_assignments;
create policy "schedule internal read" on public.schedule_assignments for select to authenticated
  using (not public.is_partner_user());
drop policy if exists "schedule supervisor write" on public.schedule_assignments;
create policy "schedule supervisor write" on public.schedule_assignments for all to authenticated
  using (not public.is_partner_user() and public.travel_is_supervisor())
  with check (not public.is_partner_user() and public.travel_is_supervisor());

drop policy if exists "authenticated full access" on public.schedule_assignment_members;
drop policy if exists "schedule members internal read" on public.schedule_assignment_members;
create policy "schedule members internal read" on public.schedule_assignment_members for select to authenticated
  using (not public.is_partner_user());
drop policy if exists "schedule members supervisor write" on public.schedule_assignment_members;
create policy "schedule members supervisor write" on public.schedule_assignment_members for all to authenticated
  using (not public.is_partner_user() and public.travel_is_supervisor())
  with check (not public.is_partner_user() and public.travel_is_supervisor());

drop policy if exists "authenticated full access" on public.schedule_events;
drop policy if exists "schedule events internal read" on public.schedule_events;
create policy "schedule events internal read" on public.schedule_events for select to authenticated
  using (not public.is_partner_user());
drop policy if exists "schedule events supervisor write" on public.schedule_events;
create policy "schedule events supervisor write" on public.schedule_events for all to authenticated
  using (not public.is_partner_user() and public.travel_is_supervisor())
  with check (not public.is_partner_user() and public.travel_is_supervisor());

drop policy if exists "authenticated full access" on public.vehicle_project_assignments;
drop policy if exists "vehicle links internal read" on public.vehicle_project_assignments;
create policy "vehicle links internal read" on public.vehicle_project_assignments for select to authenticated
  using (not public.is_partner_user());
drop policy if exists "vehicle links scoped write" on public.vehicle_project_assignments;
create policy "vehicle links scoped write" on public.vehicle_project_assignments for all to authenticated
  using (not public.is_partner_user() and (assignment_id is null or public.travel_is_supervisor()))
  with check (not public.is_partner_user() and (assignment_id is null or public.travel_is_supervisor()));

drop policy if exists "trips read" on public.trips;
create policy "trips read" on public.trips for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_trip(id));
drop policy if exists "trip_crew read" on public.trip_crew;
create policy "trip_crew read" on public.trip_crew for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_trip(trip_id));
drop policy if exists "flights read" on public.flights;
create policy "flights read" on public.flights for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_trip(trip_id)
    and (public.travel_is_supervisor() or profile_id is null or profile_id = auth.uid()));
drop policy if exists "lodging read" on public.lodging;
create policy "lodging read" on public.lodging for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_trip(trip_id));
drop policy if exists "ground read" on public.ground_transport;
create policy "ground read" on public.ground_transport for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_trip(trip_id));
drop policy if exists "procedures read" on public.procedures;
create policy "procedures read" on public.procedures for select to authenticated
  using (not public.is_partner_user() and (trip_id is null or public.travel_can_read_trip(trip_id)));
drop policy if exists "contacts read" on public.trip_contacts;
create policy "contacts read" on public.trip_contacts for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_trip(trip_id));
drop policy if exists "attachments read" on public.trip_attachments;
create policy "attachments read" on public.trip_attachments for select to authenticated
  using (not public.is_partner_user() and public.travel_can_read_attachment(id));

-- Storage must check the metadata's RLS too: hiding a boarding-pass row is
-- insufficient if the object can still be fetched/signed by another crew member.
drop policy if exists "trip attachments read" on storage.objects;
create policy "trip attachments read" on storage.objects for select to authenticated
  using (bucket_id = 'trip-attachments' and not public.is_partner_user() and exists (
    select 1 from public.trip_attachments a where a.storage_path = objects.name
      and public.travel_can_read_attachment(a.id)
  ));
drop policy if exists "trip attachments write" on storage.objects;
create policy "trip attachments write" on storage.objects for all to authenticated
  using (bucket_id = 'trip-attachments' and not public.is_partner_user() and public.travel_is_supervisor())
  with check (bucket_id = 'trip-attachments' and not public.is_partner_user() and public.travel_is_supervisor());

-- This SECURITY DEFINER entry point bypasses table RLS; preserve its existing
-- delivery transaction, but require the same explicit internal manager role.
CREATE OR REPLACE FUNCTION public.schedule_delivery(p_delivery uuid, p_when timestamp with time zone, p_member_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role text;
  v_label text;
  v_assignment uuid;
  v_member uuid;
begin
  select role into v_role from profiles where id = auth.uid();
  if public.is_partner_user() or v_role is null or v_role not in ('supervisor', 'owner', 'admin', 'big_boss') then
    raise exception 'Only a supervisor or above can put a delivery on the schedule.'
      using errcode = '42501';
  end if;
  if p_when is null then
    raise exception 'Pick the date and time the truck comes.';
  end if;
  select label into v_label from package_deliveries where id = p_delivery;
  if v_label is null then
    raise exception 'That delivery is gone.';
  end if;

  update package_deliveries set expected_at = p_when where id = p_delivery;

  select id into v_assignment from schedule_assignments
  where delivery_id = p_delivery;

  if v_assignment is null then
    insert into schedule_assignments
      (kind, delivery_id, project_id, start_date, end_date, start_time,
       status, note, created_by, published_at)
    values
      ('delivery', p_delivery, null, p_when::date, p_when::date, p_when::time,
       'published', 'Meet the truck — ' || v_label, auth.uid(), now())
    returning id into v_assignment;
  else
    update schedule_assignments
    set start_date = p_when::date,
        end_date = p_when::date,
        start_time = p_when::time,
        status = 'published',
        note = 'Meet the truck — ' || v_label,
        published_at = coalesce(published_at, now())
    where id = v_assignment;
  end if;

  delete from schedule_assignment_members where assignment_id = v_assignment;
  foreach v_member in array coalesce(p_member_ids, array[]::uuid[])
  loop
    insert into schedule_assignment_members (assignment_id, profile_id, role)
    values (v_assignment, v_member, 'installer')
    on conflict do nothing;
  end loop;

  return v_assignment;
end;
$function$
;
