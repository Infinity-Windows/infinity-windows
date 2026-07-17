-- Merge: points / gamification ledger.
create table if not exists points_ledger (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null,
  points int not null,
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists points_ledger_profile_idx on points_ledger (profile_id, created_at desc);

alter table points_ledger enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='points_ledger' and policyname='authenticated full access') then
    create policy "authenticated full access" on points_ledger for all to authenticated using (true) with check (true);
  end if;
end;
$$;
