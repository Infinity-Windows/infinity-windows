-- Operational activation, NOT part of automatic migrations. Apply only after
-- the owner reviews the exact pilot build and the rollback-only DB probe passes.
-- The admission table stores the account UUID, never an email. This script
-- resolves the supplied email once and fails unless it finds one live owner.
begin;
do $$
declare v_id uuid;
begin
  select u.id into strict v_id
  from auth.users u join public.profiles p on p.id=u.id
  where lower(u.email)='isaac@forgewd.com'
    and p.role='owner' and p.access_revoked_at is null
    and p.retired_at is null;
  if exists (
    select 1 from public.redesign_pilot_accounts
    where enabled and profile_id<>v_id
  ) then
    raise exception 'Another redesign pilot account is already enabled.';
  end if;
  insert into public.redesign_pilot_accounts(profile_id,enabled)
  values (v_id,true)
  on conflict (profile_id) do update set enabled=true;
end;
$$;
commit;
