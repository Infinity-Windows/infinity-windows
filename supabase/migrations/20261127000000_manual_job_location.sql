-- Manual job location. Coordinates are an independent pin, never geocoded from address.
alter table public.projects
  add column latitude double precision,
  add column longitude double precision,
  add constraint projects_location_pair_check check ((latitude is null) = (longitude is null)),
  add constraint projects_latitude_range_check check (latitude is null or (latitude >= -90 and latitude <= 90)),
  add constraint projects_longitude_range_check check (longitude is null or (longitude >= -180 and longitude <= 180));

-- Existing projects grants are column-scoped (since 20260959000000). Do not
-- grant the new columns: a direct client INSERT/PATCH cannot set a pin.
revoke insert (latitude, longitude), update (latitude, longitude)
  on table public.projects from public, anon, authenticated;

create function public.set_project_location(
  p_project_id uuid,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_expected_address text,
  p_expected_latitude double precision,
  p_expected_longitude double precision
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
  v_address text := nullif(btrim(p_address), '');
begin
  if v_uid is null or public.is_partner_user()
     or not public._is_lead(v_uid)
     or not exists (
       select 1 from public.profiles pr
       where pr.id = v_uid
         and pr.retired_at is null and pr.access_revoked_at is null
     ) then
    raise exception 'Only a current foreman or above can edit a job location.' using errcode = '42501';
  end if;

  if (p_latitude is null) <> (p_longitude is null) then
    raise exception 'Enter both latitude and longitude, or clear both.' using errcode = '22023';
  end if;
  if p_latitude is not null and not (p_latitude >= -90 and p_latitude <= 90)
     or p_longitude is not null and not (p_longitude >= -180 and p_longitude <= 180) then
    raise exception 'Enter valid latitude and longitude.' using errcode = '22023';
  end if;

  select * into v_project from public.projects where id = p_project_id for update;
  if not found or v_project.deleted_at is not null
     or not (
       v_project.is_test = false
       or public._is_supervisor(v_uid)
       or (public.is_test_profile(v_uid) and public.is_sandbox_project(p_project_id))
     )
     or (public.is_test_profile(v_uid) and not public.is_sandbox_project(p_project_id)) then
    raise exception 'Choose an existing job you can edit.' using errcode = '42501';
  end if;

  -- A lost response can make the phone repeat an already applied save with its
  -- old snapshot. The same final values are safe to acknowledge without writing.
  if v_project.address is not distinct from v_address
     and v_project.latitude is not distinct from p_latitude
     and v_project.longitude is not distinct from p_longitude then
    return;
  end if;

  if v_project.address is distinct from p_expected_address
     or v_project.latitude is distinct from p_expected_latitude
     or v_project.longitude is distinct from p_expected_longitude then
    raise exception 'This job location changed. Reopen the editor and try again.' using errcode = '40001';
  end if;

  update public.projects
     set address = v_address, latitude = p_latitude, longitude = p_longitude
   where id = p_project_id;
end;
$$;

revoke all on function public.set_project_location(uuid,text,double precision,double precision,text,double precision,double precision)
  from public, anon;
grant execute on function public.set_project_location(uuid,text,double precision,double precision,text,double precision,double precision)
  to authenticated;

insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-08-job-location', date '2026-10-08', array[0,1,2,3], 'improvement',
  'Add a job address or GPS pin', 'Agrega la dirección o ubicación GPS de una obra',
  'Foremen can add an address, GPS coordinates, or both to a job. The crew can see the location and get directions from the job.',
  'Los capataces pueden agregar una dirección, coordenadas GPS o ambas a una obra. El equipo puede ver la ubicación y obtener indicaciones desde la obra.',
  '/projects'
)
on conflict (id) do nothing;
