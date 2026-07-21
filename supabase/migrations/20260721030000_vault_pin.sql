-- Owner-set vault PIN: an authorization gate on who may add quality info to
-- the Infinity AI vault. This is a shared PIN, set/changed by the OWNER only,
-- and required on every vault mutation (add / refresh / remove / approve) in
-- ADDITION to the existing supervisor+ role gate. Read/query access (Ask
-- Infinity) is unchanged and never gated.
--
-- Security model: only a salted PBKDF2 hash is ever stored. The plaintext PIN
-- never touches the database. Clients must NEVER be able to read the hash, so
-- vault_config carries RLS with no permissive policy for anon/authenticated —
-- all reads/writes go through Edge Functions on the service-role key (which
-- bypasses RLS). A tiny SECURITY DEFINER RPC lets the client learn only the
-- boolean "is a PIN set?" without exposing the hash.
--
-- Additive + idempotent + graceful-degradation: safe to run on live data, and
-- the app treats a missing table/RPC as "no PIN configured" (owner sees a
-- setup state) rather than crashing.

-- Single-row config table (id is pinned to 1).
create table if not exists vault_config (
  id int primary key default 1 check (id = 1),
  pin_hash text,
  pin_salt text,
  pin_iterations int,
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- RLS on, with NO permissive policy for anon/authenticated: the hash columns
-- are unreadable and unwritable from the client. Edge Functions use the
-- service-role key, which bypasses RLS, for the actual read/verify/write.
alter table vault_config enable row level security;

-- keep updated_at fresh on writes.
create or replace function set_vault_config_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vault_config_updated_at on vault_config;
create trigger vault_config_updated_at
  before update on vault_config
  for each row execute function set_vault_config_updated_at();

-- Boolean-only exposure: does a vault PIN exist? SECURITY DEFINER so it can
-- read vault_config despite RLS, but it returns only true/false — never the
-- hash. Any signed-in user may call it (drives the Knowledge page setup state).
create or replace function vault_pin_is_set()
returns boolean
language sql
security definer
set search_path = public
stable as $$
  select exists (
    select 1 from vault_config
    where id = 1 and pin_hash is not null and pin_hash <> ''
  );
$$;

grant execute on function vault_pin_is_set() to authenticated, anon;
