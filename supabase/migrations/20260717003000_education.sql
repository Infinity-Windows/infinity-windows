-- Merge: education. Per-user spaced-repetition progress over the glossary,
-- plus callback root-cause terms that get pushed into daily decks.

create table if not exists learn_progress (
  profile_id uuid not null references profiles(id) on delete cascade,
  term_id text not null,
  box int not null default 0,          -- Leitner box 0..5
  due date not null default current_date,
  again_count int not null default 0,
  got_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (profile_id, term_id)
);

-- Terms flagged by a callback root-cause; surface first in everyone's deck.
create table if not exists learn_priority_terms (
  term_id text primary key,
  reason text,
  created_at timestamptz not null default now()
);

alter table learn_progress enable row level security;
alter table learn_priority_terms enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='learn_progress' and policyname='authenticated full access') then
    create policy "authenticated full access" on learn_progress for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='learn_priority_terms' and policyname='authenticated full access') then
    create policy "authenticated full access" on learn_priority_terms for all to authenticated using (true) with check (true);
  end if;
end;
$$;
