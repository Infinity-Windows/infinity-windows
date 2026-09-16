-- Voice input is available to every current crew role, separately from the
-- foreman-only Ask budget. No audio or transcript is stored in this ledger.
begin;
create table if not exists public.description_dictation_usage (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  primary key (profile_id, day)
);
alter table public.description_dictation_usage enable row level security;
revoke all on public.description_dictation_usage from public, anon, authenticated;
grant all on public.description_dictation_usage to service_role;
create or replace function public.claim_description_dictation(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if not exists (select 1 from profiles where id = p_user_id and retired_at is null and access_revoked_at is null) then return false; end if;
  delete from description_dictation_usage where day < (now() at time zone 'UTC')::date - 7;
  insert into description_dictation_usage(profile_id, day, requests)
    values(p_user_id, (now() at time zone 'UTC')::date, 1)
    on conflict (profile_id, day) do update
      set requests = description_dictation_usage.requests + 1
      where description_dictation_usage.requests < 120
    returning requests into v_count;
  return v_count is not null;
end;
$$;
revoke all on function public.claim_description_dictation(uuid) from public, anon, authenticated;
grant execute on function public.claim_description_dictation(uuid) to service_role;
commit;
