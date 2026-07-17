-- Merge: expand the role model to match Infinity (installer / foreman / admin /
-- big_boss), keeping the existing 'lead' value working as a lead-level alias.

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('installer','lead','foreman','admin','big_boss'));

-- Access requests: new crew submit info; an admin approves before sign-in.
create table if not exists access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  requested_role text not null default 'installer'
    check (requested_role in ('installer','foreman','admin')),
  note text,
  status text not null default 'pending'
    check (status in ('pending','approved','denied')),
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table access_requests enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='access_requests' and policyname='authenticated full access') then
    create policy "authenticated full access" on access_requests for all to authenticated using (true) with check (true);
  end if;
  -- Anyone (even anon) can submit a request.
  if not exists (select 1 from pg_policies where tablename='access_requests' and policyname='anon can request') then
    create policy "anon can request" on access_requests for insert to anon with check (true);
  end if;
end;
$$;

-- Optional device PIN for quick unlock (convenience over a real session).
alter table profiles
  add column if not exists pin text;

-- Expand the role-change guard to the new roles; any lead-level user may set.
create or replace function set_profile_role(p_target uuid, p_role text)
returns profiles
language plpgsql
security definer
as $$
declare
  v_caller_role text;
  v_profile profiles;
begin
  if p_role not in ('installer','lead','foreman','admin','big_boss') then
    raise exception 'invalid role %', p_role;
  end if;
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'only a lead-level user can change roles';
  end if;
  update profiles set role = p_role, updated_at = now()
  where id = p_target
  returning * into v_profile;
  return v_profile;
end;
$$;

-- Set/clear a personal PIN (self only).
create or replace function set_my_pin(p_pin text)
returns void
language plpgsql
security definer
as $$
begin
  update profiles set pin = nullif(p_pin, ''), updated_at = now()
  where id = auth.uid();
end;
$$;
