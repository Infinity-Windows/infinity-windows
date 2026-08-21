-- A note on any opening (owner ask, settled 2026-08-21): the point is to
-- explain why a window took much longer than expected than the estimate -
-- something a session's start/stop timestamps can't say by themselves.
--
-- A record, not a conversation: anyone signed in can read a job's notes, but
-- only the person who wrote one can ever add it, and there is no update or
-- delete policy at all - once posted, a note stands. That mirrors how the
-- Record (CONTEXT.md) already treats everything else on a unit: nothing
-- about its history is ever edited away.

create table if not exists opening_notes (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  author uuid references profiles(id) on delete set null,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists opening_notes_opening_idx
  on opening_notes (opening_id, created_at);

alter table opening_notes enable row level security;

drop policy if exists opening_notes_select_all on opening_notes;
create policy opening_notes_select_all on opening_notes
  for select to authenticated using (true);

-- Only ever as yourself - there is no "post this note as someone else", not
-- even for a foreman, matching how project_messages (20260723040000) gates
-- its own author_id column.
drop policy if exists opening_notes_insert_own on opening_notes;
create policy opening_notes_insert_own on opening_notes
  for insert to authenticated with check (author = auth.uid());
