-- Web push (p1-10 follow-up): store each device's Push API subscription so the
-- server can deliver a notification even when the app is fully closed. This is
-- the server side of the SAME { title, body, tag, url } contract the LOCAL
-- notification path already uses (app/src/lib/permissions/notifyLocal.ts).
--
-- ADDITIVE and safe: nothing here changes existing tables. When this migration
-- has not been applied, the client subscribe/upsert simply fails silently and
-- LOCAL notifications keep working.
--
-- One row per browser push endpoint. Keyed by `endpoint` (unique) so a repeat
-- subscribe from the same device upserts instead of duplicating. `profile_id`
-- ties the endpoint to the signed-in user (profiles.id = auth.uid() in this
-- app, matching toolbox_completions / time_shifts).

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text,
  auth text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_profile_idx
  on push_subscriptions (profile_id);

-- Grants: authenticated users manage their own rows; the edge function uses the
-- service role (which also bypasses RLS) to read every subscription when sending.
grant select, insert, update, delete on push_subscriptions to authenticated;
grant all on push_subscriptions to service_role;

alter table push_subscriptions enable row level security;

-- RLS: a user can only see / write / delete their OWN endpoints (scoped by
-- auth.uid()), mirroring the fcm_tokens per-user pattern. The service role
-- reads all (bypasses RLS) so send-push can fan out to every device.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'push_subscriptions' and policyname = 'push_subscriptions_select_own'
  ) then
    create policy "push_subscriptions_select_own" on push_subscriptions
      for select to authenticated using (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'push_subscriptions' and policyname = 'push_subscriptions_insert_own'
  ) then
    create policy "push_subscriptions_insert_own" on push_subscriptions
      for insert to authenticated with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'push_subscriptions' and policyname = 'push_subscriptions_update_own'
  ) then
    create policy "push_subscriptions_update_own" on push_subscriptions
      for update to authenticated
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'push_subscriptions' and policyname = 'push_subscriptions_delete_own'
  ) then
    create policy "push_subscriptions_delete_own" on push_subscriptions
      for delete to authenticated using (profile_id = auth.uid());
  end if;
end;
$$;
