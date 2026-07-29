-- Every question asked of Ask Infinity, and whether our own written knowledge
-- answered it.
--
-- This is the cheapest way to find out what to write next, in the crew's own
-- words, instead of guessing: a foreman reads the misses and adds the five
-- sentences that would have answered them. docs/ask-infinity-token-free.md
-- calls it the single highest-value item on the list, so it ships first.
--
-- Scope note: this migration only creates its own table, function and policies.
-- It does not touch `profiles` or any existing policy.
--
-- Additive + idempotent: the app degrades to not logging at all if this hasn't
-- been applied, so every object here is guarded and safe to re-run on live data.

create table if not exists ask_question_log (
  id uuid primary key default gen_random_uuid(),
  -- Who asked. Always the caller — enforced by the insert policy below.
  asker_id uuid not null references profiles(id) on delete cascade,
  question text not null,
  -- Did our own knowledge answer it? False is the interesting case.
  answered boolean not null default false,
  -- 'answers' = the brain had something, 'miss' = nothing written down yet,
  -- 'live' = a question about a job rather than about the craft.
  outcome text not null default 'miss'
    check (outcome in ('answers', 'live', 'miss')),
  -- What it matched, so a foreman can see whether the brain found the right
  -- thing or something irrelevant. Titles are stored alongside the ids so the
  -- log reads on its own without resolving anything.
  matched_ids text[] not null default '{}',
  matched_titles text[] not null default '{}',
  -- Whether the phone had signal. Tells us how much of the field is offline.
  online boolean,
  asked_at timestamptz not null default now(),
  -- Foreman triage: mark a miss as dealt with once the answer is written.
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id) on delete set null
);

-- The list a foreman actually reads: newest misses first.
create index if not exists ask_question_log_unanswered_idx
  on ask_question_log (answered, asked_at desc);
create index if not exists ask_question_log_asker_idx
  on ask_question_log (asker_id, asked_at desc);

-- Who may read the log: foreman and above. SECURITY DEFINER with a pinned
-- search_path so it can read `profiles` regardless of the caller's own RLS,
-- without this migration changing anything about `profiles` itself.
create or replace function public.can_read_ask_log(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from profiles where id = p_uid)
      in ('foreman', 'supervisor', 'owner', 'admin', 'big_boss'),
    false
  );
$$;

grant select, insert on ask_question_log to authenticated;
grant update on ask_question_log to authenticated;
grant all on ask_question_log to service_role;

alter table ask_question_log enable row level security;

do $$
begin
  -- Anyone signed in may log their own question, and only their own.
  if not exists (
    select 1 from pg_policies
    where tablename = 'ask_question_log' and policyname = 'ask_question_log_insert_own'
  ) then
    create policy "ask_question_log_insert_own" on ask_question_log
      for insert to authenticated
      with check (asker_id = auth.uid());
  end if;

  -- Reading the log is a foreman's job — it is a list of what crew don't know.
  if not exists (
    select 1 from pg_policies
    where tablename = 'ask_question_log' and policyname = 'ask_question_log_select_foreman'
  ) then
    create policy "ask_question_log_select_foreman" on ask_question_log
      for select to authenticated
      using (public.can_read_ask_log(auth.uid()));
  end if;

  -- Marking a miss reviewed is also foreman+.
  if not exists (
    select 1 from pg_policies
    where tablename = 'ask_question_log' and policyname = 'ask_question_log_review_foreman'
  ) then
    create policy "ask_question_log_review_foreman" on ask_question_log
      for update to authenticated
      using (public.can_read_ask_log(auth.uid()))
      with check (public.can_read_ask_log(auth.uid()));
  end if;
end;
$$;
