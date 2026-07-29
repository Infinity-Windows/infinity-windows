-- Stop storing crew unlock PINs in plain text.
--
-- BEFORE: profiles.pin held the 4-digit PIN verbatim, and every signed-in user
-- could read and overwrite it (see 20260729200000_profiles_rls_lockdown.sql).
-- AFTER: only a per-row salted bcrypt hash exists, in a column no client role
-- can read or write; the PIN is compared server-side inside check_my_pin() and
-- never leaves the database.
--
-- WHY BCRYPT AND NOT PBKDF2. vault_config hashes the shared vault PIN with
-- PBKDF2-SHA256 (100k iterations) in supabase/functions/_shared/pin.ts, because
-- that PIN is verified inside an Edge Function where Web Crypto is the native
-- primitive. This PIN is verified inside a SQL function, and pgcrypto — already
-- installed on production as version 1.3 in the `extensions` schema — has no
-- PBKDF2. Reimplementing PBKDF2 as a 100,000-iteration plpgsql loop was measured
-- and rejected: Postgres has no bytea XOR, so each round needs bit-string
-- conversions, and the whole derivation costs seconds of database CPU per PIN
-- check. bcrypt is one C call and was measured on production at 78 ms at cost
-- 10. Same security properties as the vault PIN — per-row random salt, a
-- deliberately slow KDF, plaintext never stored, compared only server-side —
-- with the primitive that is native to where the comparison happens.
--
-- The 4-digit keyspace, not the hash, is the weak part: 10,000 candidates at
-- 78 ms is ~13 minutes of offline work for someone who has already stolen the
-- table. That is acceptable because this PIN is a convenience lock on top of an
-- already-authenticated Supabase session (see app/src/components/PinGate.tsx),
-- not a credential in its own right. Attempt throttling is recorded as
-- follow-up work rather than pretending a bigger cost factor fixes it.
--
-- Applied while all 6 production profiles had pin IS NULL, so no PIN was
-- migrated, re-issued, or lost, and no crew member had to do anything.


-- ---------------------------------------------------------------------------
-- 1. Refuse to run if there is anything to lose
-- ---------------------------------------------------------------------------
-- Dropping the plain-text column is only free while it is empty. On any
-- database where a PIN has since been set, stop rather than silently deleting
-- it — those crew members would be locked out of the unlock screen with no
-- explanation.

do $$
declare
  n int;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'pin'
  ) then
    execute 'select count(*) from public.profiles where pin is not null' into n;
    if n > 0 then
      raise exception
        'refusing to drop profiles.pin: % row(s) still hold a plain-text PIN. '
        'Have those crew members re-set their PIN through the app first, or '
        'clear the column deliberately.', n;
    end if;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Hash column in, plain-text column out
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists pin_hash text;

comment on column public.profiles.pin_hash is
  'bcrypt hash of the crew device-unlock PIN (pgcrypto crypt/gen_salt(''bf'',10); the salt and cost live inside the string). No client role holds any privilege on this column — only set_my_pin, check_my_pin and my_pin_status touch it, all SECURITY DEFINER.';

alter table public.profiles
  drop column if exists pin;

-- No grant is issued for pin_hash. Section 2 of the previous migration replaced
-- the table-level grants with explicit column lists, so a column that is not
-- named is unreachable; this makes that explicit and survives someone
-- re-granting at the table level later.
revoke select (pin_hash), insert (pin_hash), update (pin_hash), references (pin_hash)
  on table public.profiles from anon, authenticated;
revoke references on table public.profiles from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The three PIN functions, now hash-based
-- ---------------------------------------------------------------------------
-- All three are SECURITY DEFINER with a pinned search_path, act only on
-- auth.uid()'s own row, and are executable by `authenticated` only — never
-- `anon`. `extensions.crypt` and `extensions.gen_salt` are schema-qualified so
-- the pinned search_path cannot be used to substitute a different crypt().

create or replace function public.set_my_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := coalesce(trim(p_pin), '');
begin
  if auth.uid() is null then
    raise exception 'sign in before setting a PIN' using errcode = '42501';
  end if;

  -- Empty means "clear my PIN", which the Roster screen offers explicitly.
  if v = '' then
    update public.profiles
       set pin_hash = null, updated_at = now()
     where id = auth.uid();
    return;
  end if;

  -- Mirrors validateNewPin() in supabase/functions/_shared/pin.ts.
  if length(v) < 4 or length(v) > 10 or v !~ '^[A-Za-z0-9]+$' then
    raise exception 'PIN must be 4-10 letters or numbers' using errcode = '22023';
  end if;

  update public.profiles
     set pin_hash = extensions.crypt(v, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = auth.uid();
end;
$$;

create or replace function public.check_my_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
begin
  select pin_hash into v_hash from public.profiles where id = auth.uid();
  if v_hash is null or coalesce(p_pin, '') = '' then
    return false;
  end if;
  -- Re-derives with the salt and cost embedded in the stored hash. The compared
  -- values are hashes, so a byte-wise comparison leaks nothing about the PIN.
  return extensions.crypt(p_pin, v_hash) = v_hash;
end;
$$;

create or replace function public.my_pin_status()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v boolean;
begin
  select pin_hash is not null into v from public.profiles where id = auth.uid();
  return coalesce(v, false);
end;
$$;

comment on function public.set_my_pin(text) is
  'Set or clear the calling user''s own unlock PIN. Stores a salted bcrypt hash; the plaintext is never written, returned or logged.';
comment on function public.check_my_pin(text) is
  'Verify a PIN attempt for the calling user, server-side. Returns only true/false.';
comment on function public.my_pin_status() is
  'Whether the calling user has a PIN set. Exposes a boolean and nothing else.';

-- anon must be named: Supabase's default privileges grant EXECUTE on new public
-- functions to anon directly, so revoking from PUBLIC alone leaves it callable
-- by a signed-out visitor.
revoke all on function public.set_my_pin(text) from public, anon;
revoke all on function public.check_my_pin(text) from public, anon;
revoke all on function public.my_pin_status() from public, anon;
grant execute on function public.set_my_pin(text) to authenticated;
grant execute on function public.check_my_pin(text) to authenticated;
grant execute on function public.my_pin_status() to authenticated;
