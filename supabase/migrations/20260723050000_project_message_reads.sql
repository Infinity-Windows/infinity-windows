-- Per-user, per-job read cursor for the group chat (from
-- 20260723040000_project_chat). One row per (project, user) records the moment
-- that person last read the job's thread, so the app can show an unread count
-- badge and fold chat into the in-app notifications — without changing who gets
-- a push (that stays in app/src/lib/chat/recipients.ts).
--
-- Additive + idempotent: the app degrades gracefully until this is applied (it
-- falls back to a browser-local read cursor, mirroring the chat/vehicles libs),
-- so nothing crashes pre-migration. Every object is guarded so it is safe to
-- run on top of live data.

create table if not exists project_message_reads (
  project_id uuid not null references projects(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (project_id, profile_id)
);

create index if not exists project_message_reads_profile_idx
  on project_message_reads (profile_id);

grant select, insert, update on project_message_reads to authenticated;
grant all on project_message_reads to service_role;

alter table project_message_reads enable row level security;

-- RLS: a user may only see / write their OWN read cursor (scoped by
-- auth.uid()), mirroring the push_subscriptions per-user pattern.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_message_reads' and policyname = 'project_message_reads_select_own'
  ) then
    create policy "project_message_reads_select_own" on project_message_reads
      for select to authenticated using (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_message_reads' and policyname = 'project_message_reads_insert_own'
  ) then
    create policy "project_message_reads_insert_own" on project_message_reads
      for insert to authenticated with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_message_reads' and policyname = 'project_message_reads_update_own'
  ) then
    create policy "project_message_reads_update_own" on project_message_reads
      for update to authenticated
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;
end;
$$;
