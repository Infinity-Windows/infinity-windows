-- A language the app speaks back in: English or Spanish, per person.
--
-- WHY (standard-tracking-jobs grill, 2026-09-02): most of the install crew reads
-- Spanish more comfortably than English. This slice stands up the language layer
-- so a person picks English or Spanish once, it rides their profile, and every
-- string later slices add is written in both from the start. This migration is
-- the DATA half: the column that holds the choice, and the one guarded writer.
--
-- SHAPE, and why it mirrors the pin/role columns next door:
--   * NOT NULL DEFAULT 'en' — the app always has a language to render in, so no
--     screen has to branch on a null. A brand-new row is English until the
--     person chooses; the first-login picker is what turns the default into a
--     real choice (tracked client-side, since the column cannot tell "defaulted"
--     from "picked English").
--   * CHECK (language in ('en','es')) — the app only speaks these two. A bad
--     value can never land, from any path.
--   * The `authenticated` role gets SELECT (language) so the client can read its
--     own preference, but NOT update(language). Like `role` and `pin_hash`
--     before it (20260729200000_profiles_rls_lockdown.sql), the only writer is a
--     SECURITY DEFINER RPC that scopes the write to auth.uid()'s own row. A
--     person changes only their own language; nobody rewrites anyone else's.
--
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists language text not null default 'en';

-- The constraint is added separately so a re-run does not error on an existing
-- one, and so it stands even if the column already existed from an earlier hand
-- patch.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_language_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_language_check
      check (language in ('en', 'es'));
  end if;
end;
$$;

comment on column public.profiles.language is
  'The language the app renders in for this person: ''en'' or ''es''. Written only through set_my_language(); the authenticated role holds SELECT but not UPDATE on it, matching how role and pin_hash are guarded.';


-- ---------------------------------------------------------------------------
-- 2. Column privileges: readable, but not directly writable
-- ---------------------------------------------------------------------------
-- Section 2 of 20260729200000_profiles_rls_lockdown.sql replaced the table-wide
-- grants with explicit column lists, so a new column is unreadable AND
-- unwritable by default. Add it to the readable list only. UPDATE (language) is
-- deliberately never granted — and revoked explicitly below to say so out loud —
-- so the RPC is the single writer, exactly like set_my_pin / set_profile_role.
grant select (language) on table public.profiles to authenticated;

-- A no-op unless a stray grant ever appears, but it documents the intent and
-- makes the guarantee robust against a future table-level re-grant.
revoke update (language) on table public.profiles from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The one sanctioned writer: your own language, nobody else's
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so it can write a column the caller has no UPDATE privilege
-- on, and scoped to auth.uid()'s own row so it can only ever change the caller's
-- own preference — the same caller-scoping as set_my_pin(). The value is
-- validated here too, so the RPC can never be the path that slips a bad language
-- past the CHECK.
create or replace function public.set_my_language(p_lang text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := lower(coalesce(trim(p_lang), ''));
begin
  if auth.uid() is null then
    raise exception 'sign in before choosing a language' using errcode = '42501';
  end if;

  if v not in ('en', 'es') then
    raise exception 'language must be en or es' using errcode = '22023';
  end if;

  update public.profiles
     set language = v, updated_at = now()
   where id = auth.uid();
end;
$$;

comment on function public.set_my_language(text) is
  'Set the calling user''s own app language (''en'' or ''es''). SECURITY DEFINER and scoped to auth.uid(); the only client-reachable way to write profiles.language, which is revoked from anon and authenticated at the column level.';

-- Supabase's default privileges grant EXECUTE on a new public function to anon
-- as well, so anon must be named in the revoke.
revoke all on function public.set_my_language(text) from public, anon;
grant execute on function public.set_my_language(text) to authenticated;
