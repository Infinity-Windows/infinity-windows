-- One-account design pilot. No authenticated client can edit admission.
-- This migration is staged with the redesign and must not be applied as a
-- substitute for its reviewed release and paid-clock activation checks.
create table if not exists public.redesign_pilot_accounts (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  granted_at timestamptz not null default now()
);
alter table public.redesign_pilot_accounts enable row level security;
revoke all on public.redesign_pilot_accounts from public, anon, authenticated;
grant all on public.redesign_pilot_accounts to service_role;
create unique index if not exists redesign_one_enabled_pilot
on public.redesign_pilot_accounts ((true)) where enabled;

-- Zero grants by default. The reviewed activation script resolves the owner's
-- email once to a UUID, fails if that account is missing/revoked, and then
-- inserts the UUID. Merely applying this schema does not start the pilot.

create or replace function public.my_redesign_pilot_access()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.redesign_pilot_accounts g
    join public.profiles p on p.id = g.profile_id
    where g.profile_id = auth.uid() and g.enabled
      and p.role = 'owner' and p.access_revoked_at is null
      and p.retired_at is null
  );
$$;
revoke all on function public.my_redesign_pilot_access() from public, anon;
grant execute on function public.my_redesign_pilot_access() to authenticated;

-- The old company-wide UI switch must not invite an older installed client to
-- open new screens for the crew while the canary is in progress. The new
-- owner client uses my_redesign_pilot_access() instead of this switch.
alter table public.company_settings
alter column new_design_r1_enabled set default false;
update public.company_settings
set new_design_r1_enabled = false
where id = 1;

-- The clock capability verifies exact hashes for existing routines. Guard
-- their writes with triggers instead of replacing the pinned functions.
create or replace function public._redesign_pilot_choice_guard()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.ui_design = 'new' and not public.my_redesign_pilot_access() then
    raise exception 'This design is available only to the pilot account.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._redesign_pilot_choice_guard() from public, anon, authenticated;
drop trigger if exists redesign_pilot_choice_guard on public.profiles;
create trigger redesign_pilot_choice_guard
before insert or update of ui_design on public.profiles
for each row execute function public._redesign_pilot_choice_guard();

-- An older installed owner client still has the crew-wide master control.
-- Its existing RPC may turn the switch OFF, but this trigger rejects ON until
-- a later reviewed crew release removes the hold.
create or replace function public._redesign_pilot_master_guard()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.new_design_r1_enabled then
    raise exception 'The crew-wide design release is held for owner review.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._redesign_pilot_master_guard() from public, anon, authenticated;
drop trigger if exists redesign_pilot_master_guard on public.company_settings;
create trigger redesign_pilot_master_guard
before insert or update of new_design_r1_enabled on public.company_settings
for each row execute function public._redesign_pilot_master_guard();
