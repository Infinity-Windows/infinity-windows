-- App suggestions (owner ask, 2026-08-25): every role gets a place to say
-- "this is broken" or "the app should do this," and every report lands on
-- the OWNERS' list — nobody else's queue, and deliberately not the field
-- `issues` table: jobsite problems and app problems must never share one
-- list.
--
-- Visibility is the database's job, not the buttons': anyone inserts as
-- themselves; a reader sees their OWN reports (so the tab feels like a
-- record, and they can watch the status change) while owners see all of
-- them. Only owners may update (resolve).

create table if not exists app_feedback (
  id uuid primary key default gen_random_uuid(),
  author uuid references profiles(id) on delete set null,
  kind text not null default 'bug' check (kind in ('bug', 'idea')),
  body text not null check (length(trim(body)) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz
);

create index if not exists app_feedback_status_idx on app_feedback (status, created_at desc);

alter table app_feedback enable row level security;

drop policy if exists app_feedback_select on app_feedback;
create policy app_feedback_select on app_feedback
  for select to authenticated using (
    author = auth.uid()
    or exists (
      select 1 from profiles
      where id = auth.uid() and role in ('owner', 'big_boss')
    )
  );

drop policy if exists app_feedback_insert on app_feedback;
create policy app_feedback_insert on app_feedback
  for insert to authenticated with check (author = auth.uid());

drop policy if exists app_feedback_update on app_feedback;
create policy app_feedback_update on app_feedback
  for update to authenticated using (
    exists (
      select 1 from profiles
      where id = auth.uid() and role in ('owner', 'big_boss')
    )
  ) with check (true);
