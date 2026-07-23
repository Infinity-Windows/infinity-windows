-- Per-job group chat: one text-only message thread per project (job). Assigned
-- crew (installers + foreman) and supervisors/owners can read and post; @-name
-- mentions are stored as an array of profile ids on the row so the app can
-- notify the mentioned people (and drive supervisor/owner pushes, which only
-- fire on a mention).
--
-- Additive + idempotent: the app degrades gracefully until this is applied (it
-- falls back to a browser-local store), so every object here is guarded with
-- `if not exists` and is safe to run on top of live data.

create table if not exists project_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  -- Profile ids explicitly @-mentioned in `body`, resolved client-side over the
  -- job roster. Drives mention pushes (incl. supervisors/owners who otherwise
  -- get no push for normal messages).
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists project_messages_project_idx
  on project_messages (project_id, created_at);
create index if not exists project_messages_author_idx
  on project_messages (author_id);

-- Access predicate: supervisors/owners (elevated true role) may see/post on any
-- job's chat; everyone else must be assigned to the job — either on its crew
-- schedule (schedule_assignment_members) or on one of its openings
-- (project_openings.assigned_to). SECURITY DEFINER + pinned search_path so it
-- reads the helper tables regardless of the caller's own RLS.
create or replace function public.can_access_project_chat(p_project_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(
      (select role from profiles where id = p_uid)
        in ('supervisor', 'owner', 'admin', 'big_boss'),
      false
    )
    or exists (
      select 1
      from schedule_assignment_members m
      join schedule_assignments a on a.id = m.assignment_id
      where a.project_id = p_project_id
        and m.profile_id = p_uid
    )
    or exists (
      select 1
      from project_openings o
      where o.project_id = p_project_id
        and o.assigned_to = p_uid
    );
$$;

grant select, insert on project_messages to authenticated;
grant all on project_messages to service_role;

alter table project_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_messages' and policyname = 'project_messages_select_members'
  ) then
    create policy "project_messages_select_members" on project_messages
      for select to authenticated
      using (public.can_access_project_chat(project_id, auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_messages' and policyname = 'project_messages_insert_members'
  ) then
    create policy "project_messages_insert_members" on project_messages
      for insert to authenticated
      with check (
        author_id = auth.uid()
        and public.can_access_project_chat(project_id, auth.uid())
      );
  end if;
end;
$$;

-- Live chat: publish row changes so the app's realtime subscription updates the
-- thread on every device the instant a message lands.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'project_messages'
  ) then
    alter publication supabase_realtime add table project_messages;
  end if;
end;
$$;
