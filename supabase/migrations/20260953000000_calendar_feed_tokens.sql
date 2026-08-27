-- Wave S, S6 (STRETCH): calendar feed links — the table + self-service RPCs
-- ONLY. There is no edge function in this migration.
--
-- The spec's own escape hatch: "If the edge-function plumbing turns out to
-- need secrets/config you cannot verify locally, ship the table + the UI
-- ('Copy subscribe link') behind a 'coming shortly' note and SAY SO in the
-- PR — never ship a link that 404s silently." This sandbox has no live
-- Supabase project to deploy a Deno edge function against or exercise its
-- config/secrets, so serving real iCal text is exactly that unverifiable
-- half. What ships here is the half that IS fully verifiable offline: the
-- schema, the RLS, and two owner-of-their-own-token RPCs. The frontend
-- (S4's StgCalendarTab) shows a disabled "Copy subscribe link" affordance
-- with a plain "Coming shortly" note — never a link, so never a 404.
--
-- Shape is exactly what the spec names: token, partner_profile_id,
-- expires_at, revoked_at, access_count, last_accessed_at — the last three
-- are here so the FUTURE edge function has somewhere to record a hit
-- (access_count/last_accessed_at) and so a token can be time-boxed
-- (expires_at); nothing in this migration writes them except at creation.

create table if not exists calendar_feed_tokens (
  token text primary key default encode(gen_random_bytes(24), 'hex'),
  partner_profile_id uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz,
  revoked_at timestamptz,
  access_count int not null default 0,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table calendar_feed_tokens is
  'Wave S, S6 (stretch, partial): revocable tokens for a future iCal-subscription edge function. The table + self-service RPCs ship now; no edge function reads this table yet — see the migration header. token is the bearer credential (opaque, 24 random bytes, hex) an edge function would look up with zero other auth, so it is never selectable by anyone but the owning partner (own-row RLS) and is never logged in access_count''s absence of any writer yet.';

alter table calendar_feed_tokens enable row level security;

-- Own tokens only — a partner reads/manages their own subscribe links, an
-- owner can see all of them for support ("why can't my builder's calendar
-- update"). Guarded with is_partner_user() consistent with THE WALL's own
-- mechanical instinct even though this table did not exist at sweep time.
create policy "calendar_feed_tokens_select_own_or_owner" on calendar_feed_tokens
  for select to authenticated
  using (
    (public.is_partner_user() and partner_profile_id = auth.uid())
    or (not public.is_partner_user() and public.my_role_rank() >= 3)
  );
-- No insert/update/delete policy — the two RPCs below are the only writers.

revoke all on table calendar_feed_tokens from anon, authenticated;
grant select on table calendar_feed_tokens to authenticated;

create or replace function public.create_calendar_feed_token()
returns calendar_feed_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row calendar_feed_tokens;
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;

  insert into calendar_feed_tokens (partner_profile_id)
  values (auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.create_calendar_feed_token() is
  'Partner-only: mints a fresh revocable calendar-subscription token for the calling login. No expiry set by default. Not yet consumable — no edge function serves it (S6 stretch, shipped partial; see 20260953000000''s header).';

revoke all on function public.create_calendar_feed_token() from public, anon;
grant execute on function public.create_calendar_feed_token() to authenticated;

create or replace function public.revoke_calendar_feed_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_partner_user() then
    raise exception 'not a builder login';
  end if;

  update calendar_feed_tokens
     set revoked_at = now()
   where token = p_token
     and partner_profile_id = auth.uid()
     and revoked_at is null;
end;
$$;

comment on function public.revoke_calendar_feed_token(text) is
  'Partner-only, and only their own token: revokes a calendar-subscription token. A no-op, not an error, if the token does not exist, belongs to someone else, or is already revoked — a partner cannot use this to probe which tokens exist.';

revoke all on function public.revoke_calendar_feed_token(text) from public, anon;
grant execute on function public.revoke_calendar_feed_token(text) to authenticated;
