-- Give the finished units their minutes back, and name the ones whose minutes
-- are gone for good (owner report, 2026-09-02).
--
-- 20260964000000 closed the code path. It did not touch the rows that path
-- already wrote. `finish_unit`'s cutoff subquery filtered `install_events` by a
-- bare `opening_id` — a column that table does not have — so Postgres resolved
-- the name against the enclosing `unit_sessions` row instead of failing, and
-- the cutoff became "the newest install filed anywhere on the database". On a
-- busy day that sits a few minutes in the past, every session on the unit being
-- finished started before it, the sum is zero, and `nullif(v_minutes, 0)` files
-- the unit with no minutes and no start time.
--
-- So every finish between 2026-08-20 (the day finish_unit shipped) and the
-- deploy of 20260964000000 could have been filed empty. Estimating and the
-- learning screens read those rows as "nobody recorded this", which is a lie
-- about a crew that did the work — and until this migration ran, nothing named
-- which units they were.
--
-- The sessions themselves were never touched. Sessions are the stored atom
-- (CONTEXT.md, "Session") and every derived figure comes back from them, so
-- most of this is recoverable: recompute each damaged event's round the way the
-- FIXED finish_unit computes it, and write the answer back.
--
-- What this deliberately does NOT do, so it can never invent a number:
--   * Only events with BOTH `minutes` and `started_at` null are considered —
--     that pair is the bug's fingerprint; an event with either one filled was
--     recorded by a human or by a working call and is left alone.
--   * Only events created on or after 2026-08-20. `unit_sessions` did not exist
--     before then, so an older blank event is a hand entry from the pre-clocking
--     days, not this bug's damage.
--   * Voided events are skipped: a deleted record's minutes change nothing, and
--     rewriting one would put a number on a row somebody removed on purpose.
--   * A round with no surviving sessions gets NO minutes. It is written to the
--     list below with `minutes` null, which is the honest answer: this unit's
--     time is gone, and here is its name.
--
-- The recompute adds one bound finish_unit does not need: sessions must have
-- started at or before the event was filed. finish_unit runs AT the finish, so
-- nothing later exists yet; running months afterwards, later rounds on the same
-- unit do exist and must not be swept into an earlier one.
--
-- Idempotent, and undoable by hand: re-running inserts nothing (primary key)
-- and updates nothing (the guard reads `minutes is null`), and every row this
-- migration changed is listed with exactly what it wrote, so
-- `update install_events set minutes = null, started_at = null where id in
-- (select install_event_id from install_event_time_repairs where minutes is
-- not null)` puts the database back.

create table if not exists install_event_time_repairs (
  install_event_id uuid primary key references install_events(id) on delete cascade,
  project_opening_id uuid not null references project_openings(id) on delete cascade,
  event_created_at timestamptz not null,
  minutes int check (minutes >= 0),
  started_at timestamptz,
  session_count int not null,
  repaired_at timestamptz not null default now()
);

comment on table install_event_time_repairs is
  'One row per install_event the 2026-09-02 finish_unit column bug filed with no minutes and no start time. minutes/started_at are what this unit''s own sessions say that round took; minutes null means no session survived and that unit''s time is unrecoverable. Written once by 20260965000000 and never again — the app is not a writer.';
comment on column install_event_time_repairs.minutes is
  'Session-derived minutes written back onto the event, or null when nothing was left to recover. Null rows are the enumerated loss.';
comment on column install_event_time_repairs.session_count is
  'How many ended sessions the round had. 0 means nothing survived to recompute from — the reason minutes is null on that row.';

alter table install_event_time_repairs enable row level security;
drop policy if exists "install_event_time_repairs_read" on install_event_time_repairs;
-- Foreman and up. A unit's raw facts are everyone's (CONTEXT.md, "Record"), but
-- this is a list of where the recorded numbers were wrong, which is the same
-- kind of reading as estimate-vs-actual and belongs on the same shelf. Behind
-- THE WALL (20260950000000) like every other select policy: a builder login has
-- no business in our data-quality bookkeeping.
create policy "install_event_time_repairs_read" on install_event_time_repairs
  for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 1);
-- No write policies: this migration is the only writer there will ever be.

-- Every reference below is alias-qualified on purpose. An unqualified name is
-- exactly what caused the damage being repaired here (scripts/migration_lint.py).
with damaged as (
  select e.id,
         e.project_opening_id,
         e.created_at,
         coalesce(
           (select max(p.created_at) from install_events p
            where p.project_opening_id = e.project_opening_id
              and p.voided_at is null
              and p.created_at < e.created_at),
           '-infinity'::timestamptz) as since
  from install_events e
  where e.minutes is null
    and e.started_at is null
    and e.voided_at is null
    and e.created_at >= timestamptz '2026-08-20'
),
recovered as (
  select d.id, d.project_opening_id, d.created_at, t.minutes, t.started_at, t.session_count
  from damaged d
  left join lateral (
    select coalesce(sum(least(480,
             greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)))), 0)::int as minutes,
           min(started_at) as started_at,
           count(*)::int as session_count
    from unit_sessions
    where opening_id = d.project_opening_id and ended_at is not null
      and started_at > d.since and started_at <= d.created_at
  ) t on true
)
insert into install_event_time_repairs (
  install_event_id, project_opening_id, event_created_at, minutes, started_at, session_count)
select r.id, r.project_opening_id, r.created_at,
       nullif(r.minutes, 0), r.started_at, coalesce(r.session_count, 0)
from recovered r
on conflict (install_event_id) do nothing;

-- Only rows with real minutes are written back. A round whose sessions exist
-- but add up to under a minute keeps its start time out of the event on
-- purpose: an event carrying a start and no minutes is the exact footprint this
-- bug left, and reproducing it would make the damage unreadable again. Those
-- rows are listed above instead, with their session_count to say why.
update install_events e
set minutes = r.minutes,
    started_at = r.started_at
from install_event_time_repairs r
where r.install_event_id = e.id
  and r.minutes is not null
  and e.minutes is null
  and e.started_at is null;
