-- Notification dismissals (owner call, 2026-08-11): the in-app feed is
-- derived from live state, so rows had no way to go away — a mention or a
-- published-schedule row sat for weeks. This table remembers, PER PERSON,
-- which notification versions they've cleared. The client keys each row by
-- its identity PLUS a content fingerprint, so "clear" is permanent for that
-- occurrence but a genuinely new event (new punches, new mention, changed
-- service badge) gets a new key and reappears. Stored server-side so a
-- cleared feed stays cleared across devices and reinstalls.

create table if not exists notification_dismissals (
  profile_id uuid not null references profiles(id) on delete cascade,
  key text not null,
  created_at timestamptz not null default now(),
  primary key (profile_id, key)
);

alter table notification_dismissals enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'notification_dismissals' and policyname = 'own rows'
  ) then
    create policy "own rows" on notification_dismissals
      for all to authenticated
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;
end;
$$;
