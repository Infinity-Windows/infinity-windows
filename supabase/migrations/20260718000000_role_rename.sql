-- Wave 1: collapse the role model to the four roles Taylor + Ammon use in
-- conversation: installer / foreman / supervisor / owner.
--   lead      -> foreman   (crew-level lead)
--   admin     -> supervisor
--   big_boss  -> owner
-- Data is migrated first, then the CHECK constraint is tightened, then the
-- lead-only RPC guards are re-pointed at the new elevated roles.

-- 1. Migrate existing profile roles.
update profiles set role = case role
  when 'lead' then 'foreman'
  when 'admin' then 'supervisor'
  when 'big_boss' then 'owner'
  else role
end
where role in ('lead', 'admin', 'big_boss');

-- 2. Tighten the role constraint to the new four values.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('installer', 'foreman', 'supervisor', 'owner'));

-- 3. Access requests: migrate any 'admin' request and widen the allowed
--    self-request roles (owner is never self-requested).
update access_requests set requested_role = 'supervisor'
  where requested_role = 'admin';
alter table access_requests drop constraint if exists access_requests_requested_role_check;
alter table access_requests add constraint access_requests_requested_role_check
  check (requested_role in ('installer', 'foreman', 'supervisor'));

-- 4. Role-change guard: validate against the new role set. Any elevated user
--    (foreman/supervisor/owner) may change roles; installers cannot.
create or replace function set_profile_role(p_target uuid, p_role text)
returns profiles
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_profile profiles;
begin
  if p_role not in ('installer', 'foreman', 'supervisor', 'owner') then
    raise exception 'invalid role %', p_role;
  end if;
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can change roles';
  end if;
  update profiles set role = p_role, updated_at = now()
  where id = p_target
  returning * into v_profile;
  return v_profile;
end;
$$;

-- 5. Re-point the previously lead-only guards to the elevated roles so they
--    keep working after the rename (they hard-checked role = 'lead').
create or replace function set_clearance(
  p_installer_id uuid,
  p_window_type_id uuid,
  p_cleared boolean
)
returns void
language plpgsql
security definer
as $$
declare v_caller_role text;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a foreman-level user or above can set clearance';
  end if;
  if p_cleared then
    insert into installer_clearance (installer_id, window_type_id, cleared_by)
    values (p_installer_id, p_window_type_id, auth.uid())
    on conflict (installer_id, window_type_id) do nothing;
  else
    delete from installer_clearance
    where installer_id = p_installer_id and window_type_id = p_window_type_id;
  end if;
end;
$$;

create or replace function set_golden_install(p_type_id uuid, p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can set the golden install';
  end if;
  update window_types
  set golden_install_event_id = p_event_id, golden_locked = true
  where id = p_type_id;
end;
$$;
