-- Monthly core-value reviews (owner-authorized build, 2026-10-03).
--
-- SOURCE AND SCOPE. Ports the exact monthly rubric and assignment/scoring
-- process from the pinned Horizon snapshot
-- (taylorhorizon/horizon-hub-44@94b0d20cd0882ee1173092d2892b97a4a198d946),
-- with the declared corrections from
-- ../outputs/Horizon-Crew-Goals-Reviews-2026-10-03/TRANSFER-INTEGRITY-REVIEW.md
-- and the architecture brief of the same date:
--   * Denver, not Eastern (explicit locale adaptation, not literal parity).
--   * Owners means exact Forge role='owner' — no copied Horizon identities,
--     no supervisor rank, no money grant. Foreman/supervisor map to "lead";
--     installer maps to "worker"; self always overrides class.
--   * Forge's own time_shifts(profile_id, project_id, clock_in_at), not
--     Horizon's time_entries. profiles.active (On site/Off today) is NEVER
--     read here — it is availability, not employment or access.
--   * A review NEVER blocks, edits or backdates paid time. No clock-in wall
--     is ported at all.
--   * Per-value rater-threshold suppression (not window-wide): every
--     combined value needs its OWN three distinct non-self raters.
--   * Every submission commits its header and all eight scores in one
--     transaction — there is no "complete the header, repair the scores
--     later" path, so there is no incomplete submission to aggregate.
--   * SQL scheduling (values_run_due) ships DISABLED. It no-ops unless an
--     owner flips company_settings.values_scheduler_enabled — off by
--     default, exactly as every other release gate in this repo.
--   * Stage 2 (push reminders) is NOT implemented. values_reminder_claims
--     exists as a reserved, empty schema placeholder only — see
--     docs/monthly-values-reviews.md.
--
-- Pure logic lives in app/src/lib/values/valuesEngine.ts and is unit-tested
-- there; this file is SQL's independent implementation of the same rules
-- (deterministic deal, per-value mirror, quarter freeze). There is no
-- promise of identical random person selection between the two — only the
-- same quotas, coverage floor and merge-on-redeal guarantee.

-- ============================================================================
-- 0. Slugs, rubric provenance, period policy snapshots
-- ============================================================================

create or replace function public._values_slugs() returns text[]
language sql immutable
as $$
  select array['fullsend','ownership','integrity','sincerity','tribe','growth','strategic','safety']
$$;

comment on function public._values_slugs() is
  'The eight fixed value slugs, canonical order (20261106000000). Mirrors app/src/lib/values/rubric.ts VALUE_SLUGS exactly; change both together.';
revoke all on function public._values_slugs() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 0b. Eligibility — checked on the CALLER, on every read and write
-- ---------------------------------------------------------------------------
-- Independent review finding (VALUES-SQL-SECURITY-REVIEW.md #1): a still-
-- valid JWT after `access_revoked_at`/`retired_at` is set must not keep
-- reading anything through this feature, whoever's row it is. `my_role_rank()`
-- is a generic ladder shared by the rest of the app; owner-only authority
-- here is pinned to an EXACT, narrow, non-null check instead, so it can
-- never be coupled to a future rank change elsewhere.
create or replace function public._values_eligible(p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select p_uid is not null and exists (
    select 1 from public.profiles
     where id = p_uid
       and retired_at is null
       and access_revoked_at is null
       and not coalesce(is_partner, false)
  )
$$;
revoke all on function public._values_eligible(uuid) from public, anon, authenticated;

create or replace function public._values_is_owner(p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public._values_eligible(p_uid) and exists (
    select 1 from public.profiles where id = p_uid and role = 'owner'
  )
$$;
revoke all on function public._values_is_owner(uuid) from public, anon, authenticated;

-- RLS `USING` clauses run as the QUERYING role, not as this function's
-- owner — even though both helpers above are SECURITY DEFINER, Postgres
-- still checks the caller's own EXECUTE privilege before it will let the
-- caller invoke them at all, and both are deliberately revoked from
-- `authenticated` because they accept AN ARBITRARY profile id (granting
-- EXECUTE on them directly would let any signed-in account probe any other
-- profile's retired/revoked/partner status by calling them outright, e.g.
-- via PostgREST RPC — exactly the broad exposure the brief forbids). Every
-- policy below only ever needs the CALLER's own eligibility, so these two
-- zero-argument wrappers close over auth.uid() internally and are the only
-- thing granted to `authenticated` — they reveal nothing about any uid an
-- argument could otherwise name.
create or replace function public._values_caller_eligible() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select public._values_eligible(auth.uid()) $$;
revoke all on function public._values_caller_eligible() from public, anon;
grant execute on function public._values_caller_eligible() to authenticated;

create or replace function public._values_caller_is_owner() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select public._values_is_owner(auth.uid()) $$;
revoke all on function public._values_caller_is_owner() from public, anon;
grant execute on function public._values_caller_is_owner() to authenticated;

create table if not exists public.values_rubric_versions (
  id int generated always as identity primary key,
  version_label text not null unique,
  source_note text not null,
  created_at timestamptz not null default now()
);

comment on table public.values_rubric_versions is
  'Immutable, append-only record of which rubric wording a period/submission used (20261106000000). The actual text lives client-side (app/src/lib/values/rubric.ts) — this table is provenance, not a copy of the copy.';

insert into public.values_rubric_versions (version_label, source_note)
values (
  'horizon-parity-draft-2026-08-27',
  'Verbatim pinned-source copy (taylorhorizon/horizon-hub-44@94b0d20cd0882ee1173092d2892b97a4a198d946, src/lib/coreValues.ts + valueRundowns.ts). That source marks the briefing/criteria/anchors as drafts for Taylor''s (Horizon''s owner''s) red pen; definitions are verbatim official VTO text. Forge''s owner approved BUILDING this exact text (2026-10-03) but has not separately re-authored or re-approved the wording — see app/src/lib/values/rubric.ts header.'
)
on conflict (version_label) do nothing;

revoke all on table public.values_rubric_versions from public, anon, authenticated;
alter table public.values_rubric_versions enable row level security;
-- No policies at all: provenance metadata, read only by internal functions
-- (SECURITY DEFINER, owned by the migration role) and service_role.

-- A period's PRIVATE policy snapshot: timezone, rubric/algorithm version and
-- the exact weight ladder, frozen the moment the period is first dealt. Never
-- updated afterward — a later retune of the weights is a NEW period's
-- snapshot, never a silent rewrite of an old one's.
create table if not exists public.values_periods (
  period_start date primary key,
  timezone text not null default 'America/Denver',
  rubric_version int not null references public.values_rubric_versions(id),
  algorithm_version int not null default 1,
  weight_version int not null default 1,
  weight_owner numeric not null,
  weight_lead numeric not null,
  weight_worker numeric not null,
  weight_self numeric not null,
  solo_factor numeric not null,
  min_raters int not null default 3,
  created_at timestamptz not null default now()
);

comment on table public.values_periods is
  'One row per scored month, written once by _values_ensure_period and never updated (20261106000000). The weight ladder here is Owner-side knowledge: no SELECT grant to anon/authenticated, no RLS policy at all — only internal SECURITY DEFINER functions and service_role ever read it.';

revoke all on table public.values_periods from public, anon, authenticated;
alter table public.values_periods enable row level security;

-- ============================================================================
-- 1. Assignments, submissions, scores
-- ============================================================================

create table if not exists public.values_assignments (
  id uuid primary key default gen_random_uuid(),
  period_start date not null references public.values_periods(period_start),
  rater_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('dealt', 'crew', 'owner_lead', 'self', 'solo')),
  solo boolean not null default false,
  created_at timestamptz not null default now(),
  unique (period_start, rater_id, subject_id)
);

comment on table public.values_assignments is
  'Who owes a review of whom, for which month (20261106000000). Written only by _values_deal_period (service-side); never redrawn once stored. Subjects have no read policy here on purpose — a subject does not get to see who is reviewing them.';

create index if not exists values_assignments_rater_idx on public.values_assignments (rater_id, period_start);
create index if not exists values_assignments_subject_idx on public.values_assignments (subject_id, period_start);

alter table public.values_assignments enable row level security;
revoke all on public.values_assignments from public, anon, authenticated;
grant select on public.values_assignments to authenticated;

-- The rater may see their OWN assignment row (who/when, not a raw review) —
-- values_my_tasks is the normal door, but direct reads of this one
-- non-sensitive table are not withheld. Eligibility is checked on the
-- CALLER: a revoked/retired account's lingering JWT reads nothing here.
create policy "rater reads own assignments" on public.values_assignments
  for select to authenticated
  using (rater_id = auth.uid() and public._values_caller_eligible()
    and public.is_test_profile(subject_id) = public.is_test_profile(auth.uid()));

-- Owner access is additionally PARTITIONED (independent review: test/live
-- separation is a caller-partition rule, not just an attendance exclusion).
-- A test-flagged owner reads only rows where BOTH participants are also
-- test-flagged; a real owner reads only rows where BOTH are real. The deal
-- engine already never mixes partitions on either side when it writes a row
-- (tmp_values_days is two-sided-filtered), so this is defense in depth
-- against a hand-written/legacy/imported row ever crossing the wall, not a
-- rule that should ever actually exclude a row the deal engine produced.
create policy "owner reads all assignments" on public.values_assignments
  for select to authenticated
  using (
    public._values_caller_is_owner()
    and public.is_test_profile(subject_id) = public.is_test_profile(auth.uid())
    and public.is_test_profile(rater_id) = public.is_test_profile(auth.uid())
  );

create table if not exists public.values_submissions (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  assignment_id uuid not null references public.values_assignments(id) on delete cascade,
  rater_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.profiles(id) on delete cascade,
  rater_class text not null check (rater_class in ('owner', 'crew_leader', 'worker', 'self')),
  solo boolean not null default false,
  comment text check (comment is null or char_length(btrim(comment)) between 1 and 2000),
  request_id uuid not null,
  payload_digest text not null,
  rubric_version int not null references public.values_rubric_versions(id),
  algorithm_version int not null,
  submitted_at timestamptz not null default now(),
  -- The exact, immutable receipt object values_submit() returned at
  -- acceptance (VALUES-RECEIPT-CONTRACT.md §5) — stored literally, not
  -- recomputed, so an exact replay after a later freeze returns the
  -- byte-identical object rather than one re-derived from (by then
  -- possibly differently-interpreted) current state.
  receipt jsonb not null,
  unique (period_start, rater_id, subject_id),
  unique (rater_id, request_id)
);

comment on table public.values_submissions is
  'One accepted review header (20261106000000). Written ONLY by values_submit(), atomically with its eight values_scores children — there is no partial submission to repair. rater_class/solo are server-derived at submit time and never recomputed by a later role change (brief §5). No UPDATE/DELETE policy exists for anyone but service_role; a submission is immutable once accepted.';

create index if not exists values_submissions_subject_idx on public.values_submissions (subject_id, period_start);
create index if not exists values_submissions_rater_idx on public.values_submissions (rater_id, period_start);

alter table public.values_submissions enable row level security;
revoke all on public.values_submissions from public, anon, authenticated;
grant select on public.values_submissions to authenticated;

-- NO policy admits the rater's own rows directly (independent review
-- finding #1: a raw row carries the comment and rater_class, which is more
-- than the narrow receipt the brief promises a rater). A rater's own
-- confirmation is the receipt values_submit() returns at acceptance time and
-- the status values_my_tasks() reports — never a raw table read. Only the
-- owner reads this table, and only while currently eligible and currently
-- role='owner' (re-checked on every query via the function, not cached).
-- Same caller-partition rule as "owner reads all assignments" above.
create policy "owner reads all submissions" on public.values_submissions
  for select to authenticated
  using (
    public._values_caller_is_owner()
    and public.is_test_profile(subject_id) = public.is_test_profile(auth.uid())
    and public.is_test_profile(rater_id) = public.is_test_profile(auth.uid())
  );

-- Deliberately NO policy lets subject_id = auth.uid() read this table either:
-- a scored person sees only the thresholded, server-computed mirror
-- (values_my_summary), never raw received rows, rater identities or
-- comments (brief, "Server data and authority").

create table if not exists public.values_scores (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.values_submissions(id) on delete cascade,
  value_slug text not null check (value_slug = any (public._values_slugs())),
  score int not null check (score between 1 and 10),
  unique (submission_id, value_slug)
);

comment on table public.values_scores is
  'The eight per-value scores behind one submission (20261106000000). Exactly eight rows per submission is enforced by values_submit() at insert time, not by a DB constraint alone — a submission with fewer never exists because the whole insert is one transaction.';

alter table public.values_scores enable row level security;
revoke all on public.values_scores from public, anon, authenticated;
grant select on public.values_scores to authenticated;

-- Same narrowing as values_submissions above: no rater raw-read policy. Only
-- the owner, currently eligible and currently role='owner' — and, same
-- caller-partition rule as the two policies above, only for a submission
-- whose rater AND subject are both in the caller's own test/live partition.
create policy "owner reads all scores" on public.values_scores
  for select to authenticated
  using (
    public._values_caller_is_owner()
    and exists (
      select 1 from public.values_submissions s
      where s.id = values_scores.submission_id
        and public.is_test_profile(s.subject_id) = public.is_test_profile(auth.uid())
        and public.is_test_profile(s.rater_id) = public.is_test_profile(auth.uid())
    )
  );

-- ============================================================================
-- 2. Frozen quarterly ratings
-- ============================================================================

create table if not exists public.values_quarterly_ratings (
  id uuid primary key default gen_random_uuid(),
  quarter_start date not null,
  subject_id uuid not null references public.profiles(id) on delete cascade,
  overall numeric,
  rater_count int not null default 0,
  submission_count int not null default 0,
  algorithm_version int not null default 1,
  frozen_at timestamptz not null default now(),
  unique (quarter_start, subject_id)
);

comment on table public.values_quarterly_ratings is
  'One frozen rating per person per quarter (20261106000000), written once by _values_freeze_quarter and never updated after — a re-run SKIPS an already-frozen subject rather than overwriting. overall is null when no value cleared the rater floor that quarter.';

alter table public.values_quarterly_ratings enable row level security;
revoke all on public.values_quarterly_ratings from public, anon, authenticated;
grant select on public.values_quarterly_ratings to authenticated;

create policy "subject reads own frozen quarters" on public.values_quarterly_ratings
  for select to authenticated
  using (subject_id = auth.uid() and public._values_caller_eligible());

-- Same caller-partition rule: a frozen quarter is also test-or-live by its
-- subject, and an owner only reads their own partition's frozen rows.
create policy "owner reads all frozen quarters" on public.values_quarterly_ratings
  for select to authenticated
  using (
    public._values_caller_is_owner()
    and public.is_test_profile(subject_id) = public.is_test_profile(auth.uid())
  );

create table if not exists public.values_quarterly_values (
  id uuid primary key default gen_random_uuid(),
  rating_id uuid not null references public.values_quarterly_ratings(id) on delete cascade,
  value_slug text not null check (value_slug = any (public._values_slugs())),
  score numeric not null,
  unique (rating_id, value_slug)
);

comment on table public.values_quarterly_values is
  'The eight per-value frozen scores behind one values_quarterly_ratings row (20261106000000). A value absent here never cleared the rater floor that quarter.';

alter table public.values_quarterly_values enable row level security;
revoke all on public.values_quarterly_values from public, anon, authenticated;
grant select on public.values_quarterly_values to authenticated;

create policy "read via owning rating" on public.values_quarterly_values
  for select to authenticated
  using (
    exists (
      select 1 from public.values_quarterly_ratings r
      where r.id = values_quarterly_values.rating_id
        and (
          (r.subject_id = auth.uid() and public._values_caller_eligible())
          or (
            public._values_caller_is_owner()
            and public.is_test_profile(r.subject_id) = public.is_test_profile(auth.uid())
          )
        )
    )
  );

-- ============================================================================
-- 3. Stage 2 placeholder — reserved schema only, no delivery worker
-- ============================================================================
-- NOT WIRED UP IN THIS BUILD. Push reminders are the next review slice,
-- explicitly documented as not implemented (architecture brief, "Push is
-- next review slice"). This table exists so the eventual bounded delivery
-- worker (separate SYSTEM_ACTORS-registered function, service-only claim/
-- finish RPCs, no request-supplied recipient/body/period) has a home that
-- does not require a second migration to invent. Nothing reads or writes it
-- yet; it is covered by the purge cascade below regardless.
create table if not exists public.values_reminder_claims (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  period_start date not null,
  kind text not null check (kind in ('month_end', 'month_start')),
  dedupe_key text not null unique,
  claimed_at timestamptz,
  sent_at timestamptz,
  lease_until timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.values_reminder_claims is
  'RESERVED, UNUSED in this build (20261106000000) — Stage 2 push reminders are a separate, not-yet-implemented slice (docs/monthly-values-reviews.md). Schema only, so the eventual delivery worker needs no new migration for its table.';

alter table public.values_reminder_claims enable row level security;
revoke all on public.values_reminder_claims from public, anon, authenticated;
-- No policies: service-only, and currently nothing calls it at all.

-- ============================================================================
-- 4. The owner's scheduling switch — off by default
-- ============================================================================

alter table public.company_settings add column if not exists values_scheduler_enabled boolean not null default false;

comment on column public.company_settings.values_scheduler_enabled is
  'Owner-only master switch for the monthly values-review scheduler (20261106000000). OFF by default, exactly like new_design_r1_enabled and paid_time_from_start_day_on — values_run_due() no-ops entirely while this is false. Parent release gates decide real activation; see docs/monthly-values-reviews.md.';

create or replace function public.set_values_scheduler_enabled(p_enabled boolean)
returns public.company_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.company_settings;
begin
  if not public._values_is_owner(auth.uid()) then
    raise exception 'Only an owner can turn the monthly values-review scheduler on or off.'
      using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Say whether the scheduler is on or off.' using errcode = '22023';
  end if;
  update public.company_settings
     set values_scheduler_enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
   where id = 1
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.set_values_scheduler_enabled(boolean) is
  'Owner only: turn the monthly values-review deal/freeze scheduler on or off for everyone at once (20261106000000).';

revoke all on function public.set_values_scheduler_enabled(boolean) from public, anon;
grant execute on function public.set_values_scheduler_enabled(boolean) to authenticated;

-- ============================================================================
-- 5. Calendar helpers (SQL's independent copy of valuesEngine.ts's rules)
-- ============================================================================

create or replace function public._values_tz() returns text
language sql immutable
as $$ select 'America/Denver' $$;

create or replace function public._values_launch() returns date
language sql immutable
as $$ select '2026-10-01'::date $$;

create or replace function public._values_day(p_at timestamptz) returns date
language sql stable
as $$ select (p_at at time zone public._values_tz())::date $$;

create or replace function public._values_period_of(p_day date) returns date
language sql immutable
as $$ select date_trunc('month', p_day)::date $$;

create or replace function public._values_days_in_period(p_period date) returns int
language sql immutable
as $$ select extract(day from ((p_period + interval '1 month') - interval '1 day'))::int $$;

-- Opens on day (daysInPeriod - 7 + 1) of the month — the final seven Denver
-- calendar days, whatever weekday the month ends on.
create or replace function public._values_window_opens_on(p_period date) returns date
language sql immutable
as $$ select p_period + (public._values_days_in_period(p_period) - 7) $$;

create or replace function public._values_window_open(p_at timestamptz) returns boolean
language sql stable
as $$
  select public._values_day(p_at) >= public._values_window_opens_on(public._values_period_of(public._values_day(p_at)))
$$;

create or replace function public._values_active_period(p_at timestamptz) returns date
language sql stable
as $$
  select case
    when public._values_window_open(p_at) then public._values_period_of(public._values_day(p_at))
    else (public._values_period_of(public._values_day(p_at)) - interval '1 month')::date
  end
$$;

create or replace function public._values_period_scorable(p_period date) returns boolean
language sql immutable
as $$ select p_period >= public._values_launch() $$;

create or replace function public._values_quarter_of(p_period date) returns date
language sql immutable
as $$ select date_trunc('quarter', p_period)::date $$;

create or replace function public._values_quarter_end_exclusive(p_quarter date) returns date
language sql immutable
as $$ select (p_quarter + interval '3 months')::date $$;

-- Denver 00:00 on the 10th of the month after the quarter closes.
create or replace function public._values_quarter_closed(p_quarter date, p_at timestamptz) returns boolean
language sql stable
as $$
  select public._values_day(p_at) >= ((public._values_quarter_end_exclusive(p_quarter) + interval '9 days')::date)
$$;

-- The EXACT instant of that cutoff, as a timestamptz (independent review
-- finding #3/#5): Denver local midnight on the 10th, converted properly —
-- never a client-supplied time, never a bare date comparison that ignores
-- the hour a submission actually landed.
create or replace function public._values_quarter_cutoff_at(p_quarter date) returns timestamptz
language sql immutable
as $$
  select ((public._values_quarter_end_exclusive(p_quarter) + interval '9 days')::date)::timestamp
    at time zone 'America/Denver'
$$;

create or replace function public._values_role_class(p_role text) returns text
language sql immutable
as $$
  select case p_role
    when 'owner' then 'owner'
    when 'supervisor' then 'crew_leader'
    when 'foreman' then 'crew_leader'
    else 'worker'
  end
$$;

revoke all on function public._values_tz() from public, anon, authenticated;
revoke all on function public._values_launch() from public, anon, authenticated;
revoke all on function public._values_day(timestamptz) from public, anon, authenticated;
revoke all on function public._values_period_of(date) from public, anon, authenticated;
revoke all on function public._values_days_in_period(date) from public, anon, authenticated;
revoke all on function public._values_window_opens_on(date) from public, anon, authenticated;
revoke all on function public._values_window_open(timestamptz) from public, anon, authenticated;
revoke all on function public._values_active_period(timestamptz) from public, anon, authenticated;
revoke all on function public._values_period_scorable(date) from public, anon, authenticated;
revoke all on function public._values_quarter_of(date) from public, anon, authenticated;
revoke all on function public._values_quarter_end_exclusive(date) from public, anon, authenticated;
revoke all on function public._values_quarter_closed(date, timestamptz) from public, anon, authenticated;
revoke all on function public._values_quarter_cutoff_at(date) from public, anon, authenticated;
revoke all on function public._values_role_class(text) from public, anon, authenticated;

-- ============================================================================
-- 6. Period policy snapshot + the mirror (aggregation) engine
-- ============================================================================

create or replace function public._values_ensure_period(p_period date) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rubric int;
begin
  select id into v_rubric from public.values_rubric_versions order by id desc limit 1;
  insert into public.values_periods (
    period_start, timezone, rubric_version, algorithm_version,
    weight_owner, weight_lead, weight_worker, weight_self, solo_factor, min_raters
  ) values (
    p_period, public._values_tz(), v_rubric, 1,
    1.0, 0.9, 0.65, 0.15, 0.5, 3
  )
  on conflict (period_start) do nothing;
end;
$$;

comment on function public._values_ensure_period(date) is
  'Write a period''s private policy snapshot exactly once (20261106000000). The weight ladder here (owner 1.0, lead 0.9, worker 0.65, self 0.15, solo×0.5) is the architecture brief''s exact values; a later retune changes this function''s literals for NEW periods only — existing periods'' rows never change.';

revoke all on function public._values_ensure_period(date) from public, anon, authenticated;

-- The mirror: a per-value weighted average with an independent rater
-- threshold per value (TRANSFER-INTEGRITY-REVIEW.md §3 — the declared
-- privacy correction). Self scores ALWAYS count toward the combined average
-- at their own (small) weight; `self` is also reported separately.
--
-- COMPLETE SUBMISSIONS ONLY (independent review finding #9): values_submit()
-- guarantees eight-or-nothing for anything it writes, but this function does
-- not trust that invariant blindly — a legacy import, a service-side fixture,
-- or a future correction route could in principle leave a header with fewer
-- than eight children, and Horizon's own bug was exactly a header saved
-- without its children. `complete_submissions` below restricts every read to
-- submissions that actually carry all eight, independent of how they got
-- here.
--
-- CUTOFF (independent review finding #3): when `p_cutoff` is given (the
-- freeze path), a submission accepted at or after that instant is excluded
-- — never just filtered by which calendar period it names. Denver wall time,
-- not a client-supplied value; see _values_quarter_cutoff_at.
create or replace function public._values_mirror(
  p_subject uuid, p_since date, p_until date, p_min_raters int, p_cutoff timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with complete_submissions as (
    select s.id, s.rater_id, s.rater_class, s.solo, s.period_start
    from public.values_submissions s
    where s.subject_id = p_subject
      and (p_since is null or s.period_start >= p_since)
      and (p_until is null or s.period_start < p_until)
      and (p_cutoff is null or s.submitted_at < p_cutoff)
      and (select count(*) from public.values_scores sc2 where sc2.submission_id = s.id) = 8
      -- CALLER/TEST PARTITION (independent review: test/live separation is a
      -- partition rule, not only an attendance-time exclusion). The deal
      -- engine already never pairs a test rater with a real subject or vice
      -- versa, but this aggregate must not trust that invariant blindly any
      -- more than it trusts the eight-scores one above it — a hand-written
      -- or legacy row that somehow crossed the wall must still never feed a
      -- subject's combined number.
      and public.is_test_profile(s.rater_id) = public.is_test_profile(p_subject)
  ),
  rows as (
    select
      sc.value_slug,
      cs.rater_id,
      cs.rater_class,
      cs.solo,
      sc.score,
      (case cs.rater_class
         when 'owner' then vp.weight_owner
         when 'crew_leader' then vp.weight_lead
         when 'worker' then vp.weight_worker
         when 'self' then vp.weight_self
         else 0
       end) * (case when cs.solo then vp.solo_factor else 1 end) as w
    from complete_submissions cs
    join public.values_scores sc on sc.submission_id = cs.id
    join public.values_periods vp on vp.period_start = cs.period_start
  ),
  per_slug as (
    select
      value_slug,
      count(distinct rater_id) filter (where rater_class <> 'self') as raters,
      sum(score) filter (where rater_class = 'self') as self_sum,
      count(*) filter (where rater_class = 'self') as self_n,
      sum(w * score) as weighted_sum,
      sum(w) as weight_total
    from rows
    group by value_slug
  )
  select coalesce(
    jsonb_object_agg(
      value_slug,
      jsonb_build_object(
        'average',
          case when coalesce(raters, 0) >= p_min_raters and coalesce(weight_total, 0) > 0
            then round((weighted_sum / weight_total)::numeric, 2)
            else null end,
        'self',
          case when coalesce(self_n, 0) > 0 then round((self_sum::numeric / self_n), 2) else null end,
        'raters', coalesce(raters, 0)
      )
    ),
    '{}'::jsonb
  )
  from per_slug;
$$;

comment on function public._values_mirror(uuid, date, date, int, timestamptz) is
  'One subject''s weighted per-value average, self average and distinct non-self rater count over [p_since, p_until), counting only COMPLETE (exactly eight scores) submissions accepted before p_cutoff when given (20261106000000). p_min_raters=1 removes suppression (owner view); the crew-facing callers always pass 3. p_since/p_until/p_cutoff null means unbounded. Internal only — never granted to authenticated; weights never leave this function.';

revoke all on function public._values_mirror(uuid, date, date, int, timestamptz) from public, anon, authenticated;

-- ============================================================================
-- 7. Crew-facing RPCs
-- ============================================================================

create or replace function public.values_my_tasks()
returns table (
  assignment_id uuid,
  period_start date,
  subject_id uuid,
  subject_name text,
  reason text,
  solo boolean,
  status text,
  submitted_at timestamptz,
  -- The rubric version THIS assignment's period is using — the client must
  -- send this back on submit so a mismatch (the questions changed since the
  -- form opened) is caught server-side rather than silently answering stale
  -- wording (independent review finding #5).
  rubric_version int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Explicit, recognizable denial for an ineligible caller (consistent with
  -- values_my_summary/values_submit), not a silently empty result set that
  -- an offline/degrading client could mistake for "nothing owed" when the
  -- real reason is a revoked/retired account.
  if not public._values_eligible(auth.uid()) then
    raise exception 'Sign in to see your values reviews.' using errcode = '42501';
  end if;

  return query
  select
    a.id,
    a.period_start,
    a.subject_id,
    coalesce(p.display_name, '?'),
    a.reason,
    a.solo,
    case when s.id is not null then 'submitted' else 'pending' end,
    s.submitted_at,
    coalesce(vp.rubric_version, (select id from public.values_rubric_versions order by id desc limit 1))
  from public.values_assignments a
  join public.profiles p on p.id = a.subject_id
  left join public.values_submissions s on s.assignment_id = a.id
    and (select count(*) from public.values_scores sc where sc.submission_id = s.id) = 8
  left join public.values_periods vp on vp.period_start = a.period_start
  where a.rater_id = auth.uid()
    -- A subject who has since been retired/revoked withholds the
    -- outstanding task (retirement cancels; revocation suspends): a still-eligible rater is never asked to complete a
    -- review of someone no longer with the company (independent review
    -- finding #7). The assignment ROW is preserved (nothing is deleted); it
    -- does not show as owed while the subject is ineligible. A SUBMITTED one still shows, since
    -- that history must be preserved regardless of the subject's status.
    and (s.id is not null or public._values_eligible(a.subject_id))
    -- CALLER/TEST PARTITION: a row that somehow crossed the test/live wall
    -- (never written by the deal engine itself, which is two-sided-filtered)
    -- is always withheld, including submitted history. Retention does not
    -- override the caller partition boundary.
    and public.is_test_profile(a.subject_id) = public.is_test_profile(auth.uid())
  order by (s.id is not null), a.period_start desc, p.display_name;
end;
$$;

comment on function public.values_my_tasks() is
  'The caller''s own review assignments, minimal subject names only (20261106000000). No subject override, no raw scores, no weights. Pending first, so a person always sees what they owe at the top. A pending task whose SUBJECT has since been retired/revoked is withheld (effective cancellation); an already-submitted one still shows.';

revoke all on function public.values_my_tasks() from public, anon;
grant execute on function public.values_my_tasks() to authenticated;

create or replace function public.values_my_owed_count()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
  from public.values_assignments a
  where a.rater_id = auth.uid()
    and public._values_eligible(auth.uid())
    and public._values_eligible(a.subject_id)
    and public.is_test_profile(a.subject_id) = public.is_test_profile(auth.uid())
    and not exists (select 1 from public.values_submissions s where s.assignment_id = a.id
      and (select count(*) from public.values_scores sc where sc.submission_id = s.id) = 8);
$$;

comment on function public.values_my_owed_count() is
  'How many reviews the caller currently owes — the Settings card badge (20261106000000). No names, no scores.';

revoke all on function public.values_my_owed_count() from public, anon;
grant execute on function public.values_my_owed_count() to authenticated;

create or replace function public.values_my_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_window_start date;
  v_today date;
begin
  if not public._values_eligible(v_uid) then
    raise exception 'Sign in to see your values review.' using errcode = '42501';
  end if;
  v_today := public._values_day(now());
  v_window_start := (public._values_period_of(v_today) - interval '3 months')::date;
  return jsonb_build_object(
    'subjectId', v_uid,
    'windowStart', v_window_start,
    'windowEnd', v_today,
    'mirror', public._values_mirror(v_uid, v_window_start, null, 3),
    'allTime', public._values_mirror(v_uid, null, null, 3),
    'quarters', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'quarterStart', r.quarter_start,
        'overall', r.overall,
        'raterCount', r.rater_count,
        'values', (
          select coalesce(jsonb_object_agg(qv.value_slug, qv.score), '{}'::jsonb)
          from public.values_quarterly_values qv where qv.rating_id = r.id
        )
      ) order by r.quarter_start desc), '[]'::jsonb)
      from public.values_quarterly_ratings r
      where r.subject_id = v_uid
    )
  );
end;
$$;

comment on function public.values_my_summary() is
  'The caller''s own finished numbers: rolling mirror (explicit date range, never a misleading "3 months" label), all-time mirror, and every frozen quarter (20261106000000). No subject override accepted — always auth.uid(). No raw rater identities, comments or weights.';

revoke all on function public.values_my_summary() from public, anon;
grant execute on function public.values_my_summary() to authenticated;

-- ============================================================================
-- 8. values_submit — the atomic, idempotent, conflict-safe write
-- ============================================================================

-- p_scores is a JSON ARRAY of {"slug":..., "score":...} objects, not an
-- object keyed by slug (independent review finding #11): `jsonb_each_text`
-- on an object silently collapses a duplicate key before this function ever
-- sees it, and erases the JSON number/string distinction. An array preserves
-- both a real duplicate and the original JSON type, so both are rejected
-- here instead of silently accepted or impossible to detect.
create or replace function public.values_submit(
  p_assignment_id uuid,
  p_request_id uuid,
  p_rubric_version int,
  p_scores jsonb,
  p_comment text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment public.values_assignments;
  v_period public.values_periods;
  v_existing_by_request public.values_submissions;
  v_existing_by_slot public.values_submissions;
  -- ASCII-space-only trim (VALUES-RECEIPT-CONTRACT.md §1) — btrim's second
  -- argument pins the trim character set explicitly rather than relying on
  -- its space-only default; null propagates through btrim/nullif untouched,
  -- so a null p_comment needs no separate coalesce.
  v_comment text := nullif(btrim(p_comment, ' '), '');
  v_digest text;
  v_canonical text;
  v_score_lines text;
  -- Accumulates the eight validated {slug: score} pairs for the canonical
  -- digest, built only from entries already proven unique/known/in-range —
  -- never from raw client JSON.
  v_validated jsonb := '{}'::jsonb;
  v_rater_class text;
  v_submission_id uuid;
  v_slugs text[] := public._values_slugs();
  v_elem jsonb;
  v_slug text;
  v_raw text;
  v_score int;
  v_seen_slugs text[] := '{}';
  v_quarter date;
  v_cutoff timestamptz;
  v_accepted_at timestamptz;
  v_eligibility text;
  v_receipt jsonb;
begin
  if v_uid is null then
    raise exception 'Sign in before submitting a values review.' using errcode = '42501';
  end if;
  if not public._values_eligible(v_uid) then
    raise exception 'This account no longer has access to submit reviews.' using errcode = '42501';
  end if;
  if p_assignment_id is null or p_request_id is null then
    raise exception 'This review is missing its id and cannot be sent. Open it again.' using errcode = '22023';
  end if;
  if p_rubric_version is null then
    raise exception 'This review is missing which version of the questions it showed. Open it again.' using errcode = '22023';
  end if;
  if p_scores is null or jsonb_typeof(p_scores) <> 'array' or jsonb_array_length(p_scores) <> 8 then
    raise exception 'All eight values need a score before you can submit.' using errcode = '22023';
  end if;
  if v_comment is not null and char_length(v_comment) > 2000 then
    raise exception 'That comment is too long — 2000 characters at most.' using errcode = '22023';
  end if;

  -- One submit at a time per rater, so two near-simultaneous sends (a tap and
  -- a queued retry) cannot both pass the lookups below and double-insert.
  perform pg_advisory_xact_lock(hashtextextended('values_submit:' || v_uid::text, 0));

  -- Validate structure and type STRICTLY before building anything from it:
  -- a score must be a genuine JSON number (not the string "7"), a slug a
  -- genuine JSON string, each slug known and seen at most once. Build the
  -- canonical "slug:score" pairs as we go for a deterministic digest input.
  for v_elem in select * from jsonb_array_elements(p_scores) loop
    if jsonb_typeof(v_elem) is distinct from 'object' then
      raise exception 'Each value needs exactly slug and score.' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(v_elem)) <> 2
       or jsonb_typeof(v_elem->'slug') is distinct from 'string'
       or jsonb_typeof(v_elem->'score') is distinct from 'number' then
      raise exception 'Each value needs a slug and a whole-number score.' using errcode = '22023';
    end if;
    v_slug := v_elem->>'slug';
    v_raw := v_elem->>'score';
    if not (v_slug = any (v_slugs)) then
      raise exception 'Unknown value "%" in this review.', v_slug using errcode = '22023';
    end if;
    if v_slug = any (v_seen_slugs) then
      raise exception 'Value "%" was scored twice in this review.', v_slug using errcode = '22023';
    end if;
    v_seen_slugs := array_append(v_seen_slugs, v_slug);
    -- A genuine JSON number can still be "5.5" or "-1" or "10.0" — the raw
    -- text form is checked against a bare 1-or-2-digit pattern so a
    -- fractional score is refused outright, never rounded.
    if v_raw !~ '^[0-9]{1,2}$' then
      raise exception 'Every value needs a whole-number score from 1 to 10.' using errcode = '22023';
    end if;
    v_score := v_raw::int;
    if v_score < 1 or v_score > 10 then
      raise exception 'Every value needs a whole-number score from 1 to 10.' using errcode = '22023';
    end if;
    v_validated := v_validated || jsonb_build_object(v_slug, v_score);
  end loop;
  if array_length(v_seen_slugs, 1) is distinct from 8 then
    raise exception 'All eight values need a score before you can submit.' using errcode = '22023';
  end if;

  -- CANONICAL DIGEST — exactly VALUES-RECEIPT-CONTRACT.md §2/§3, not an ad
  -- hoc delimiter format: encoding version tag, assignment, REQUEST id and
  -- rubric version (all three belong to the digest — independent review
  -- finding #5 named the request id specifically), then the eight value
  -- lines sorted by ASCII slug (COLLATE "C", never locale-sensitive default
  -- ordering), then the comment as `null` or `hex:<utf8 hex>` so no
  -- delimiter in a comment can ever be mistaken for a field boundary. Every
  -- line, including the last, ends in a single LF. Postgres's BUILT-IN
  -- pg_catalog.sha256 (no pgcrypto/extension-schema dependency — independent
  -- review finding #10) over the UTF-8 bytes of that exact text.
  select string_agg(key || '=' || value || chr(10), '' order by key collate "C")
    into v_score_lines
    from jsonb_each_text(v_validated);

  v_canonical :=
    'forge-values-submit/v1' || chr(10) ||
    'assignment=' || p_assignment_id::text || chr(10) ||
    'request=' || p_request_id::text || chr(10) ||
    'rubric=' || p_rubric_version::text || chr(10) ||
    v_score_lines ||
    'comment=' || case when v_comment is null then 'null'
      else 'hex:' || encode(convert_to(v_comment, 'UTF8'), 'hex') end || chr(10);

  v_digest := encode(pg_catalog.sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- IDEMPOTENT REPLAY: the same rater, the same request id, ever again —
  -- looked up by (rater_id, request_id) ALONE first (that pair is what the
  -- table's own unique constraint protects), not also filtered by
  -- assignment id, so a request id reused against a DIFFERENT assignment is
  -- caught here as an explicit, friendly conflict rather than falling
  -- through to the insert and raising a raw, unhandled constraint violation
  -- (VALUES-RECEIPT-CONTRACT.md §5: "reuse against a different assignment is
  -- conflict, never a new answer"). The SAME assignment + SAME digest is the
  -- only path that returns the ORIGINAL, immutable, PERSISTED receipt
  -- object — stored verbatim, never recomputed, so it is byte-identical
  -- before and after a later freeze.
  select * into v_existing_by_request
    from public.values_submissions
   where rater_id = v_uid and request_id = p_request_id;
  if v_existing_by_request.id is not null then
    -- A stored receipt is still a read: a partition change cannot grant
    -- access to historical opposite-partition identity on replay.
    if public.is_test_profile(v_uid) <> public.is_test_profile(v_existing_by_request.subject_id) then
      raise exception 'This review crosses the test/live account boundary and cannot be submitted.' using errcode = '42501';
    end if;
    if v_existing_by_request.assignment_id <> p_assignment_id then
      raise exception 'This request id was already used for a different review. Reopen the review to get a new one.'
        using errcode = '23505';
    end if;
    if v_existing_by_request.payload_digest = v_digest then
      return jsonb_build_object('receipt', v_existing_by_request.receipt, 'replay', true);
    end if;
    raise exception 'This request was already submitted with different answers. Reopen the review to try again.'
      using errcode = '23505';
  end if;

  select * into v_assignment from public.values_assignments where id = p_assignment_id for update;
  if v_assignment.id is null or v_assignment.rater_id <> v_uid then
    raise exception 'This review is not assigned to your account.' using errcode = '42501';
  end if;
  -- The subject must still be a current, eligible account — lifecycle
  -- denial while inaccessible (independent review finding #7): a retired/revoked subject
  -- can no longer be newly reviewed, even by a still-eligible rater holding
  -- an old assignment row (values_my_tasks already withholds it as "owed",
  -- this is the server-side enforcement of the same rule).
  if not public._values_eligible(v_assignment.subject_id) then
    raise exception 'This review is currently unavailable because the person does not have review access.'
      using errcode = '42501';
  end if;
  -- CALLER/TEST PARTITION: a test (QA/sandbox) rater and a real subject, or
  -- vice versa, never submit against each other — even against a row that
  -- somehow crossed the wall (the deal engine itself never writes one). A
  -- test rater reviewing a test subject, or a real rater reviewing a real
  -- subject, is unaffected (same-partition QA self-probes remain possible).
  if public.is_test_profile(v_uid) <> public.is_test_profile(v_assignment.subject_id) then
    raise exception 'This review crosses the test/live account boundary and cannot be submitted.'
      using errcode = '42501';
  end if;

  -- GOVERNING PERIOD LOCK (independent review finding #3), acquired before
  -- the slot check and before acceptedAt is captured, and the SAME lock key
  -- _values_freeze_quarter takes for every period in a quarter before it
  -- reads anything — a freeze in flight for this period's quarter and a
  -- submit for this period can never interleave.
  perform pg_advisory_xact_lock(hashtextextended('values_period:' || v_assignment.period_start::text, 0));

  if not public._values_eligible(v_uid) or not public._values_eligible(v_assignment.subject_id)
     or public.is_test_profile(v_uid) <> public.is_test_profile(v_assignment.subject_id) then
    raise exception 'Review access changed while waiting. Reopen this review.' using errcode = '42501';
  end if;

  -- COMPETING REQUEST FOR A COMPLETED ASSIGNMENT: a different request id
  -- arriving for an assignment that already has ANY accepted submission —
  -- never merged, never silently accepted as a second answer.
  select * into v_existing_by_slot
    from public.values_submissions
   where period_start = v_assignment.period_start
     and rater_id = v_assignment.rater_id
     and subject_id = v_assignment.subject_id;
  if v_existing_by_slot.id is not null then
    raise exception 'This review was already submitted for this person this month.' using errcode = '23505';
  end if;

  perform public._values_ensure_period(v_assignment.period_start);
  select * into v_period from public.values_periods where period_start = v_assignment.period_start;

  if p_rubric_version <> v_period.rubric_version then
    raise exception 'The values questions were updated since this review opened. Reopen it to see the current wording before submitting.'
      using errcode = '22023';
  end if;

  v_rater_class := case when v_assignment.rater_id = v_assignment.subject_id
    then 'self'
    else public._values_role_class((select role from public.profiles where id = v_uid))
  end;

  -- Captured AFTER the governing lock, so a transaction that waited for the
  -- lock across the cutoff instant is judged by when it actually runs, not a
  -- stale transaction-start time (independent review finding #5). `now()`
  -- is transaction-start time for the whole transaction in PostgreSQL — it
  -- would still read as of before the lock wait even placed AFTER it.
  -- `clock_timestamp()` is the one function that advances during a
  -- transaction and actually reflects wall time once the lock is held.
  v_accepted_at := clock_timestamp();
  v_quarter := public._values_quarter_of(v_assignment.period_start);
  v_cutoff := public._values_quarter_cutoff_at(v_quarter);
  v_eligibility := case when v_accepted_at < v_cutoff then 'eligible_before_cutoff' else 'late_after_cutoff' end;
  -- The id is generated here, not left to the column default, so it can be
  -- embedded in the receipt object stored in THIS SAME row (VALUES-RECEIPT-
  -- CONTRACT.md §5's immutable nested receipt, not a flat ad hoc shape).
  v_submission_id := gen_random_uuid();
  v_receipt := jsonb_build_object(
    'encodingVersion', 'forge-values-submit/v1',
    'submissionId', v_submission_id,
    'assignmentId', v_assignment.id,
    'requestId', p_request_id,
    'rubricVersion', v_period.rubric_version,
    'digest', v_digest,
    'acceptedAt', v_accepted_at,
    'quarterStart', v_quarter,
    'cutoffAt', v_cutoff,
    'quarterEligibility', v_eligibility
  );

  insert into public.values_submissions (
    id, period_start, assignment_id, rater_id, subject_id, rater_class, solo,
    comment, request_id, payload_digest, rubric_version, algorithm_version, submitted_at, receipt
  ) values (
    v_submission_id, v_assignment.period_start, v_assignment.id, v_assignment.rater_id, v_assignment.subject_id,
    v_rater_class, v_assignment.solo, v_comment, p_request_id, v_digest,
    v_period.rubric_version, v_period.algorithm_version, v_accepted_at, v_receipt
  );

  -- Aliased `elem` here, not `v_elem` — `v_elem` is already a declared
  -- plpgsql variable from the validation loop above, and reusing it as a
  -- FROM-clause alias makes every reference to it ambiguous (42702).
  insert into public.values_scores (submission_id, value_slug, score)
  select v_submission_id, elem->>'slug', (elem->>'score')::int from jsonb_array_elements(p_scores) as elem;

  return jsonb_build_object('receipt', v_receipt, 'replay', false);
end;
$$;

comment on function public.values_submit(uuid, uuid, int, jsonb, text) is
  'The one way to file a monthly values review (20261106000000). Commits the header and all eight scores in one transaction; validates exactly eight known slugs (each exactly {slug,score} with a genuine string slug and numeric integer score, via a JSON ARRAY payload — not an object, which silently collapses duplicate keys), integer 1-10 each, and a <=2000-char optional comment. p_rubric_version must match the assignment''s period or the submission is refused (the client must be looking at the rubric it is answering about). Rater class/solo are SERVER-derived; never trusted from the client. Acquires the per-rater lock, then the assignment row, then the PERIOD lock shared with _values_freeze_quarter, before accepting a wall-clock acceptedAt and computing an IMMUTABLE quarterEligibility (eligible_before_cutoff | late_after_cutoff) that never changes after a later freeze. Returns {receipt, replay} per VALUES-RECEIPT-CONTRACT.md: the digest is the exact canonical forge-values-submit/v1 encoding (assignment/request/rubric/eight ASCII-sorted score lines/hex-or-null comment, pg_catalog.sha256), and the receipt object is persisted verbatim in the row and returned unchanged — never recomputed — on exact replay. Same request id + same payload replays that stored receipt; a changed payload under the same request id, or a different request id for an already-completed assignment, raises 23505.';

revoke all on function public.values_submit(uuid, uuid, int, jsonb, text) from public, anon;
grant execute on function public.values_submit(uuid, uuid, int, jsonb, text) to authenticated;

-- ============================================================================
-- 9. Owner-only report
-- ============================================================================

create or replace function public.values_owner_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_period date;
  v_cutoff_now timestamptz;
begin
  -- Checked on EVERY call, not cached — a revoked owner loses this instantly.
  -- Exact role='owner' + currently eligible, not a generic rank floor
  -- (independent review finding #1).
  if not public._values_is_owner(v_uid) then
    raise exception 'Owner access only.' using errcode = '42501';
  end if;
  v_period := greatest(public._values_active_period(now()), public._values_launch());
  v_cutoff_now := public._values_quarter_cutoff_at(public._values_quarter_of(v_period));

  return jsonb_build_object(
    'periodStart', v_period,
    'schedulerEnabled', (select values_scheduler_enabled from public.company_settings where id = 1),
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', pr.id,
        'name', pr.display_name,
        'mirror', public._values_mirror(pr.id, (v_period - interval '3 months')::date, null, 1),
        'owedCount', (
          select count(*) from public.values_assignments a
          where a.subject_id = pr.id and a.period_start = v_period
            and public.is_test_profile(a.rater_id) = public.is_test_profile(pr.id)
            and not exists (select 1 from public.values_submissions s where s.assignment_id = a.id
              and (select count(*) from public.values_scores sc where sc.submission_id = s.id) = 8)
        ),
        -- ADDITIVE lifecycle coverage (VALUES-OWNER-CONTRACT.md) — every
        -- field below is new; nothing above is renamed or removed.
        -- `asRater.*` describes this person's OWN workload as a rater this
        -- period; `suspended`/`retired` describe this person's OWN account
        -- state right now; `coverage.*` describes them as a SUBJECT this
        -- period, against the brief's two-received-reviews floor.
        'asRater', jsonb_build_object(
          -- Every a2/a3/s2/s4 join below additionally requires the OTHER
          -- side of the pair to share pr's (and therefore the caller's,
          -- since the outer FROM below is already partitioned) test/live
          -- partition — defense in depth against a hand-written/legacy row
          -- that crossed the wall, same rule as the RLS policies and
          -- _values_mirror above.
          'assigned', (
            select count(*) from public.values_assignments a2
            where a2.rater_id = pr.id and a2.period_start = v_period
              and public.is_test_profile(a2.subject_id) = public.is_test_profile(pr.id)
          ),
          'accepted', (
            select count(*) from public.values_assignments a2
            join public.values_submissions s2 on s2.assignment_id = a2.id
              and (select count(*) from public.values_scores sc where sc.submission_id = s2.id) = 8
            where a2.rater_id = pr.id and a2.period_start = v_period
              and public.is_test_profile(a2.subject_id) = public.is_test_profile(pr.id)
          ),
          'late', (
            select count(*) from public.values_assignments a2
            join public.values_submissions s2 on s2.assignment_id = a2.id
              and (select count(*) from public.values_scores sc where sc.submission_id = s2.id) = 8
            where a2.rater_id = pr.id and a2.period_start = v_period and s2.submitted_at >= v_cutoff_now
              and public.is_test_profile(a2.subject_id) = public.is_test_profile(pr.id)
          ),
          -- Retirement cancels unanswered work; temporary lost access
          -- suspends it. Accepted history is independent of either flag.
          -- All three unanswered buckets are disjoint and partitioned.
          'pending', (
            select count(*) from public.values_assignments a2
            where a2.rater_id = pr.id and a2.period_start = v_period
              and public.is_test_profile(a2.subject_id) = public.is_test_profile(pr.id)
              and not exists (select 1 from public.values_submissions s3 where s3.assignment_id = a2.id
                and (select count(*) from public.values_scores sc where sc.submission_id = s3.id) = 8)
              and public._values_eligible(pr.id) and public._values_eligible(a2.subject_id)
          ),
          'canceled', (
            select count(*) from public.values_assignments a2
            join public.profiles subject on subject.id = a2.subject_id
            where a2.rater_id = pr.id and a2.period_start = v_period
              and public.is_test_profile(a2.subject_id) = public.is_test_profile(pr.id)
              and not exists (select 1 from public.values_submissions s3 where s3.assignment_id = a2.id
                and (select count(*) from public.values_scores sc where sc.submission_id = s3.id) = 8)
              and (pr.retired_at is not null or subject.retired_at is not null)
          ),
          'suspended', (
            select count(*) from public.values_assignments a2
            join public.profiles subject on subject.id = a2.subject_id
            where a2.rater_id = pr.id and a2.period_start = v_period
              and public.is_test_profile(a2.subject_id) = public.is_test_profile(pr.id)
              and not exists (select 1 from public.values_submissions s3 where s3.assignment_id = a2.id
                and (select count(*) from public.values_scores sc where sc.submission_id = s3.id) = 8)
              and pr.retired_at is null and subject.retired_at is null
              and not (public._values_eligible(pr.id) and public._values_eligible(a2.subject_id))
          )
        ),
        'suspended', (pr.access_revoked_at is not null),
        'retired', (pr.retired_at is not null),
        'coverage', jsonb_build_object(
          'expectedReceived', 2,
          'actualReceived', (
            select count(*) from public.values_assignments a3
            join public.values_submissions s4 on s4.assignment_id = a3.id
              and (select count(*) from public.values_scores sc where sc.submission_id = s4.id) = 8
            where a3.subject_id = pr.id and a3.period_start = v_period and s4.rater_class <> 'self'
              and public.is_test_profile(s4.rater_id) = public.is_test_profile(pr.id)
          ),
          'missingCoverage', (
            (select count(*) from public.values_assignments a3
             join public.values_submissions s4 on s4.assignment_id = a3.id
              and (select count(*) from public.values_scores sc where sc.submission_id = s4.id) = 8
             where a3.subject_id = pr.id and a3.period_start = v_period and s4.rater_class <> 'self'
               and public.is_test_profile(s4.rater_id) = public.is_test_profile(pr.id)) < 2
          )
        ),
        'received', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'raterName', rp.display_name,
            'raterClass', s.rater_class,
            'solo', s.solo,
            'periodStart', s.period_start,
            'comment', s.comment,
            'scores', (select coalesce(jsonb_object_agg(sc.value_slug, sc.score), '{}'::jsonb)
                       from public.values_scores sc where sc.submission_id = s.id)
          ) order by s.period_start desc), '[]'::jsonb)
          from public.values_submissions s
          join public.profiles rp on rp.id = s.rater_id
          where s.subject_id = pr.id and s.rater_class <> 'self'
            and public.is_test_profile(rp.id) = public.is_test_profile(pr.id)
        )
      ) order by pr.display_name), '[]'::jsonb)
      from public.profiles pr
      where (
        exists (select 1 from public.values_assignments a where a.subject_id = pr.id
          and public.is_test_profile(a.rater_id) = public.is_test_profile(pr.id))
           or exists (select 1 from public.values_submissions s2 where s2.subject_id = pr.id
             and public.is_test_profile(s2.rater_id) = public.is_test_profile(pr.id))
      )
      -- CALLER/TEST PARTITION: a test-flagged owner's report lists only
      -- test-flagged people; a real owner's lists only real people. This is
      -- the report's own "raw owner RLS" boundary, not just a filter on
      -- display — a test owner never learns a real subject even exists
      -- here, and vice versa.
      and public.is_test_profile(pr.id) = public.is_test_profile(v_uid)
    )
  );
end;
$$;

comment on function public.values_owner_report() is
  'Named, raw review data for the owner only (20261106000000). Re-checks owner authority on every call (never a cached grant). Never exposed to a crew-facing payload, a notification, an export, AI context or diagnostics/log scrubbing per the brief — this function''s result must stay off every one of those paths.';

revoke all on function public.values_owner_report() from public, anon;
grant execute on function public.values_owner_report() to authenticated;

-- ============================================================================
-- 10. The deal (service-only)
-- ============================================================================

create or replace function public._values_deal_period(p_period date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dealt int := 0;
  v_rec record;
  v_running int;
begin
  if not public._values_period_scorable(p_period) then
    return jsonb_build_object('periodStart', p_period, 'dealt', 0, 'skipped', 'not scorable');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('values_deal:' || p_period::text, 0));
  perform public._values_ensure_period(p_period);

  create temp table if not exists tmp_values_days (user_id uuid, project_id uuid, day date);
  create temp table if not exists tmp_values_pairs (a uuid, b uuid);
  -- UNIQUE (rater_id, subject_id) (independent review finding #8): every
  -- insert below uses ON CONFLICT DO NOTHING against it, so the SAME pair
  -- queued twice from two different generation steps (an owner's "every
  -- active lead" pass and their "own coworkers" pass can target the same
  -- person) is one row, not two — a duplicate row would otherwise inflate a
  -- subject's received count and let the floor pass believe they are
  -- covered when only one real rater exists.
  create temp table if not exists tmp_values_new (
    rater_id uuid, subject_id uuid, reason text, solo boolean,
    seq int generated always as identity, unique (rater_id, subject_id)
  );
  create temp table if not exists tmp_values_running (subject_id uuid primary key, n int not null default 0);
  -- A snapshot of who already held a row BEFORE this run, taken once, up
  -- front. The merge loop below must judge "is this rater new?" against this
  -- snapshot, never against the live table as it fills in during the SAME
  -- run — querying live would make a worker's own SECOND base pick look like
  -- "an existing rater's fresh pick" the moment their first pick landed,
  -- which is not what the merge rule means.
  create temp table if not exists tmp_values_prior_raters (rater_id uuid primary key);
  truncate tmp_values_days;
  truncate tmp_values_pairs;
  truncate tmp_values_new;
  truncate tmp_values_running;
  truncate tmp_values_prior_raters;
  insert into tmp_values_prior_raters
    select distinct rater_id from public.values_assignments where period_start = p_period;

  -- Distinct (person, project, Denver day) from real, accessible, non-test
  -- crew accounts, excluding voided/rejected/needs-finish evidence (that gets
  -- flagged for owner coverage review elsewhere, never silently used here).
  -- `status = any(...)` deliberately does NOT include 'rejected'/'needs_finish':
  -- open shifts DO count (the brief says so explicitly).
  -- Partition match is TWO-SIDED (independent review finding #6): the
  -- PERSON must not be a test account, AND the PROJECT must not be a
  -- testing project — a real crew member's shift on a practice job is not
  -- real review evidence either.
  insert into tmp_values_days (user_id, project_id, day)
  select distinct ts.profile_id, ts.project_id, public._values_day(ts.clock_in_at)
  from public.time_shifts ts
  join public.profiles pr on pr.id = ts.profile_id
  join public.projects pj on pj.id = ts.project_id
  where ts.status in ('open', 'submitted', 'approved')
    and ts.project_id is not null
    and pr.retired_at is null
    and pr.access_revoked_at is null
    and not coalesce(pr.is_partner, false)
    and not public.is_test_profile(pr.id)
    and not coalesce(pj.is_test, false)
    and pr.role in ('installer', 'foreman', 'supervisor', 'owner')
    and public._values_period_of(public._values_day(ts.clock_in_at)) = p_period;

  insert into tmp_values_pairs (a, b)
  select distinct d1.user_id, d2.user_id
  from tmp_values_days d1
  join tmp_values_days d2 on d1.project_id = d2.project_id and d1.day = d2.day and d1.user_id <> d2.user_id;

  -- Owner → every active lead (owner_lead) + owner's own coworkers (crew),
  -- if the owner clocked too.
  for v_rec in
    select pr.id as owner_id from public.profiles pr
    where pr.role = 'owner' and pr.retired_at is null and pr.access_revoked_at is null
      and not coalesce(pr.is_partner, false) and not public.is_test_profile(pr.id)
  loop
    insert into tmp_values_new (rater_id, subject_id, reason, solo)
    select v_rec.owner_id, lead.id, 'owner_lead', false
    from public.profiles lead
    where lead.role in ('foreman', 'supervisor') and lead.retired_at is null and lead.access_revoked_at is null
      and not coalesce(lead.is_partner, false) and not public.is_test_profile(lead.id)
      and exists (select 1 from tmp_values_days d where d.user_id = lead.id)
    on conflict (rater_id, subject_id) do nothing;

    insert into tmp_values_new (rater_id, subject_id, reason, solo)
    select v_rec.owner_id, p.b, 'crew', false
    from tmp_values_pairs p
    where p.a = v_rec.owner_id
    on conflict (rater_id, subject_id) do nothing;
  end loop;

  -- Lead → coworkers (crew) + self, for every lead who clocked.
  for v_rec in
    select lead_id from (
      select distinct pr.id as lead_id from public.profiles pr
      join tmp_values_days d on d.user_id = pr.id
      where pr.role in ('foreman', 'supervisor') and pr.retired_at is null and pr.access_revoked_at is null
        and not coalesce(pr.is_partner, false) and not public.is_test_profile(pr.id)
    ) s
    order by lead_id
  loop
    insert into tmp_values_new (rater_id, subject_id, reason, solo)
    select v_rec.lead_id, p.b, 'crew', false from tmp_values_pairs p where p.a = v_rec.lead_id
    on conflict (rater_id, subject_id) do nothing;
    insert into tmp_values_new (rater_id, subject_id, reason, solo) values (v_rec.lead_id, v_rec.lead_id, 'self', false)
    on conflict (rater_id, subject_id) do nothing;
  end loop;

  -- Worker base deal: up to two coworkers (least-dealt-to-this-subject
  -- first, period-seeded tiebreak), or up to two of last month's coworkers
  -- at solo weight when nobody shared a site this period, plus self.
  --
  -- The outer worker order is wrapped in a derived table (independent
  -- review finding #2): `SELECT DISTINCT pr.id ... ORDER BY md5(...)` is
  -- refused outright by PostgreSQL with 42P10, because the ORDER BY
  -- expression is not the exact expression in the DISTINCT select list — a
  -- real planner error this function used to hit on every call with any
  -- worker rows at all. Deduplicating in the inner query and sorting the
  -- OUTER, non-DISTINCT result is unrestricted.
  for v_rec in
    select worker_id from (
      select distinct pr.id as worker_id from public.profiles pr
      join tmp_values_days d on d.user_id = pr.id
      where pr.role = 'installer' and pr.retired_at is null and pr.access_revoked_at is null
        and not coalesce(pr.is_partner, false) and not public.is_test_profile(pr.id)
    ) s
    order by md5(p_period::text || worker_id::text)
  loop
    if exists (select 1 from tmp_values_pairs where a = v_rec.worker_id) then
      -- "received" counts what is already stored for real AND what this
      -- very run has already queued for that subject so far (including
      -- earlier workers' picks in this same loop) — a live count, not the
      -- snapshot-only one this function used to read here, which could
      -- never see this run's own in-progress picks (independent review
      -- finding #8).
      insert into tmp_values_new (rater_id, subject_id, reason, solo)
      select v_rec.worker_id, cand.b, 'dealt', false
      from (
        select p.b,
          coalesce(r.n, 0) + (select count(*) from tmp_values_new n where n.subject_id = p.b and n.reason <> 'self') as received
        from tmp_values_pairs p
        left join tmp_values_running r on r.subject_id = p.b
        where p.a = v_rec.worker_id
        order by received, md5(p_period::text || v_rec.worker_id::text || p.b::text)
        limit 2
      ) cand(b, received)
      on conflict (rater_id, subject_id) do nothing;
    else
      -- Solo: up to two of last month's coworkers, at solo weight
      -- (_values_recent_coworkers computes that pool from time_shifts
      -- directly — see its own definition below).
      insert into tmp_values_new (rater_id, subject_id, reason, solo)
      select v_rec.worker_id, mate, 'solo', true
      from unnest(public._values_recent_coworkers(v_rec.worker_id, p_period)) with ordinality as t(mate, ord)
      order by ord
      limit 2
      on conflict (rater_id, subject_id) do nothing;
    end if;
    insert into tmp_values_new (rater_id, subject_id, reason, solo) values (v_rec.worker_id, v_rec.worker_id, 'self', false)
    on conflict (rater_id, subject_id) do nothing;
  end loop;

  -- Running received-count, seeded from what is ALREADY stored this period
  -- (so the floor pass below is correct on a re-run, not just a first run).
  insert into tmp_values_running (subject_id, n)
  select subject_id, count(*) from public.values_assignments
  where period_start = p_period and rater_id <> subject_id
  group by subject_id
  on conflict (subject_id) do update set n = excluded.n;

  -- Floor top-up: anyone active, not an owner, still short of 2 received
  -- (counting both what is stored AND what this pass already queued),
  -- picked up by the least-burdened coworker who actually worked beside them.
  -- Same DISTINCT/ORDER BY fix as the worker loop above (finding #2).
  for v_rec in
    select subject_id from (
      select distinct d.user_id as subject_id
      from tmp_values_days d
      where not exists (
        select 1 from public.profiles pr where pr.id = d.user_id and pr.role = 'owner'
      )
    ) s
    order by md5(p_period::text || 'floor' || subject_id::text)
  loop
    select coalesce(n, 0) into v_running from tmp_values_running where subject_id = v_rec.subject_id;
    v_running := coalesce(v_running, 0)
      + (select count(*) from tmp_values_new where subject_id = v_rec.subject_id and reason <> 'self');
    if v_running >= 2 then continue; end if;

    insert into tmp_values_new (rater_id, subject_id, reason, solo)
    select cand.rater_id, v_rec.subject_id, 'dealt', false
    from (
      select p.a as rater_id
      from tmp_values_pairs p
      where p.b = v_rec.subject_id
        and not exists (
          select 1 from public.values_assignments va
          where va.period_start = p_period and va.rater_id = p.a and va.subject_id = v_rec.subject_id
        )
        and not exists (
          select 1 from tmp_values_new n
          where n.rater_id = p.a and n.subject_id = v_rec.subject_id
        )
      order by (
        select count(*) from tmp_values_new n2 where n2.rater_id = p.a and n2.reason <> 'self'
      ), md5(p_period::text || p.a::text || v_rec.subject_id::text)
      limit (2 - v_running)
    ) cand;
    -- A one-person site cannot reach the floor; nothing is invented.
  end loop;

  -- MERGE RULE (assignmentsToStore semantics): a rater who already holds ANY
  -- row this period is never dealt a fresh base pick again; a subject still
  -- short of the floor may still collect one, from any rater. Processed in a
  -- single deterministic pass so "short" reflects earlier inserts in THIS
  -- pass too.
  for v_rec in select * from tmp_values_new order by seq loop
    continue when exists (
      select 1 from public.values_assignments
      where period_start = p_period and rater_id = v_rec.rater_id and subject_id = v_rec.subject_id
    );
    if v_rec.rater_id <> v_rec.subject_id then
      select coalesce(n, 0) into v_running from tmp_values_running where subject_id = v_rec.subject_id;
      v_running := coalesce(v_running, 0);
      -- Skip exactly when the subject is NOT short of the floor AND the
      -- rater is NOT new (judged against the pre-run snapshot) — i.e. insert
      -- when either is true, per the merge rule.
      if v_running >= 2 and exists (select 1 from tmp_values_prior_raters where rater_id = v_rec.rater_id) then
        continue;
      end if;
    end if;
    insert into public.values_assignments (period_start, rater_id, subject_id, reason, solo)
    values (p_period, v_rec.rater_id, v_rec.subject_id, v_rec.reason, v_rec.solo)
    on conflict (period_start, rater_id, subject_id) do nothing;
    if found then
      v_dealt := v_dealt + 1;
      if v_rec.rater_id <> v_rec.subject_id then
        insert into tmp_values_running (subject_id, n) values (v_rec.subject_id, 1)
          on conflict (subject_id) do update set n = tmp_values_running.n + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('periodStart', p_period, 'dealt', v_dealt);
end;
$$;

comment on function public._values_deal_period(date) is
  'Deal (or top up) one month''s assignments (20261106000000) — SQL''s independent port of app/src/lib/values/valuesEngine.ts''s dealAssignments/assignmentsToStore rules. Service-only: never granted to authenticated/anon. Idempotent under re-run (advisory-locked per period); no promise of identical person selection vs. the TS engine, only the same quotas/floor/merge rules.';

revoke all on function public._values_deal_period(date) from public, anon, authenticated;

-- The previous month's coworkers for a solo worker's fallback pool.
--
-- FULL ELIGIBILITY + PARTITION MATCH on the CANDIDATE side (independent
-- review finding #6): the prior version joined raw time_shifts rows with no
-- profile or project checks at all, so a solo worker could be handed a
-- test, partner, retired or revoked former coworker, or one drawn from a
-- practice project. Mirrors the exact same filters the main attendance
-- query (tmp_values_days, above) applies.
create or replace function public._values_recent_coworkers(p_user uuid, p_period date)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct d2.profile_id order by d2.profile_id), '{}'::uuid[])
  from public.time_shifts d1
  join public.time_shifts d2
    on d2.project_id = d1.project_id
   and public._values_day(d2.clock_in_at) = public._values_day(d1.clock_in_at)
   and d2.profile_id <> d1.profile_id
  join public.profiles cand on cand.id = d2.profile_id
  join public.projects pj1 on pj1.id = d1.project_id
  join public.projects pj2 on pj2.id = d2.project_id
  where d1.profile_id = p_user
    and d1.status in ('open', 'submitted', 'approved')
    and d2.status in ('open', 'submitted', 'approved')
    and public._values_period_of(public._values_day(d1.clock_in_at)) = (p_period - interval '1 month')::date
    and cand.retired_at is null
    and cand.access_revoked_at is null
    and not coalesce(cand.is_partner, false)
    and not public.is_test_profile(cand.id)
    and cand.role in ('installer', 'foreman', 'supervisor', 'owner')
    and not coalesce(pj1.is_test, false)
    and not coalesce(pj2.is_test, false)
$$;

revoke all on function public._values_recent_coworkers(uuid, date) from public, anon, authenticated;

-- ============================================================================
-- 11. Freeze
-- ============================================================================
-- Snapshot provenance columns (independent review finding #4): a frozen
-- rating must be able to say, on its own, exactly what policy and cutoff
-- produced it, without trusting that `algorithm_version=1` alone is enough
-- to reproduce or audit the number later.
alter table public.values_quarterly_ratings add column if not exists cutoff timestamptz;
alter table public.values_quarterly_ratings add column if not exists rubric_version int references public.values_rubric_versions(id);
-- A single scalar algorithm_version was always a potential lie for a
-- mixed-version quarter (a rubric/algorithm retune mid-quarter leaves
-- different values_periods rows disagreeing) — nullable so "uniform across
-- every period this quarter actually used" is the only thing it ever
-- silently implies; see policy_versions below for the always-accurate form.
alter table public.values_quarterly_ratings alter column algorithm_version drop not null;
-- SAFE per-period policy provenance (independent review: "safe" meaning no
-- private weight ladder here — see values_periods' own comment; the weight
-- numbers live only in values_quarterly_accounting below, which is
-- owner-only). One array entry per DISTINCT period this quarter's
-- assignments actually touched, so a rubric/algorithm change mid-quarter is
-- represented as an array of differing entries rather than forced into one
-- possibly-wrong scalar. rubric_version/algorithm_version above remain the
-- single value ONLY when every period in the quarter agreed; a genuinely
-- mixed quarter leaves them null and this array is the only truthful source.
alter table public.values_quarterly_ratings add column if not exists policy_versions jsonb not null default '[]'::jsonb;

comment on column public.values_quarterly_ratings.cutoff is
  'The exact Denver collection-cutoff instant this freeze used (20261106000000) — a submission accepted at or after this moment was excluded, whatever period it named.';
comment on column public.values_quarterly_ratings.rubric_version is
  'Which rubric version''s weights/slugs this freeze used (20261106000000) — provenance, not a copy of the rubric text. NULL when the quarter''s periods did not all agree — see policy_versions.';
comment on column public.values_quarterly_ratings.policy_versions is
  'One entry per distinct period this quarter touched: {periodStart, timezone, rubricVersion, algorithmVersion, weightVersion, minRaters} (20261106000000) — SAFE fields only, never the private weight ladder (values_periods'' own comment). The always-accurate record of which policy/version produced this freeze, even across a mid-quarter rubric change; rubric_version/algorithm_version above are a convenience scalar, valid only when every entry here agrees.';

-- Private arithmetic must not live on subject-readable quarterly_ratings:
-- unsuppressed numerator/denominator would bypass the three-rater floor.
create table if not exists public.values_quarterly_accounting (
  rating_id uuid primary key references public.values_quarterly_ratings(id) on delete cascade,
  cutoff timestamptz not null,
  policy_snapshots jsonb not null,
  value_totals jsonb not null
);
comment on table public.values_quarterly_accounting is
  'Immutable owner-only aggregate math and complete period policies. Eight per-value weighted numerators/denominators, historical nonself counts, submission counts and self totals; never an individual contribution vector. Contributor purge does not recompute these totals; subject purge cascades the entire rating.';
alter table public.values_quarterly_accounting enable row level security;
revoke all on public.values_quarterly_accounting from public, anon, authenticated;
grant select on public.values_quarterly_accounting to authenticated;
create policy "owner reads frozen accounting" on public.values_quarterly_accounting
  for select to authenticated using (
    public._values_caller_is_owner() and exists (
      select 1 from public.values_quarterly_ratings r
      where r.id = values_quarterly_accounting.rating_id
        and public.is_test_profile(r.subject_id) = public.is_test_profile(auth.uid())
    )
  );

-- Identifying source provenance expires with the raw review. This explicit
-- purge exception removes the manifest row, not another subject's frozen math.
create table if not exists public.values_quarterly_manifest (
  id uuid primary key default gen_random_uuid(),
  rating_id uuid not null references public.values_quarterly_ratings(id) on delete cascade,
  submission_id uuid not null references public.values_submissions(id) on delete cascade,
  rater_id uuid not null references public.profiles(id) on delete cascade,
  included boolean not null default true,
  exclusion_reason text check (exclusion_reason in ('late', 'incomplete'))
);
comment on table public.values_quarterly_manifest is
  'Same-partition source references and inclusion reasons only. Authorized source/rater purge deletes the row; no copied raw scores/weight/class/comment/receipt survive. Frozen aggregate accounting is retained separately. A missing manifest after purge means provenance erased, not a changed historical denominator.';
create index if not exists values_quarterly_manifest_rating_idx on public.values_quarterly_manifest (rating_id);
alter table public.values_quarterly_manifest enable row level security;
revoke all on public.values_quarterly_manifest from public, anon, authenticated;
grant select on public.values_quarterly_manifest to authenticated;
create policy "owner reads manifest" on public.values_quarterly_manifest
  for select to authenticated using (
    public._values_caller_is_owner()
    and public.is_test_profile(rater_id) = public.is_test_profile(auth.uid())
    and exists (
      select 1 from public.values_quarterly_ratings r
      where r.id = values_quarterly_manifest.rating_id
        and public.is_test_profile(r.subject_id) = public.is_test_profile(auth.uid())
    )
  );

create or replace function public._values_freeze_quarter(p_quarter date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject uuid;
  v_period date;
  v_frozen int := 0;
  v_skipped int := 0;
  v_rating jsonb;
  v_rating_id uuid;
  v_sub_count int;
  v_rater_count int;
  v_quarter_end date := public._values_quarter_end_exclusive(p_quarter);
  v_cutoff timestamptz := public._values_quarter_cutoff_at(p_quarter);
  v_rubric int;
  v_algorithm int;
  v_policy_versions jsonb;
  v_policy_snapshots jsonb;
  v_distinct_rubrics int;
  v_distinct_algorithms int;
begin
  -- GOVERNING LOCK (independent review finding #3): the SAME per-period lock
  -- values_submit() takes, acquired here for EVERY period in the quarter, in
  -- deterministic ascending order, BEFORE reading anything. A submit in
  -- flight for any of these periods blocks this freeze until it commits or
  -- rolls back, and a freeze in flight blocks a new submit for any of these
  -- periods the same way — the two can never interleave on the same period.
  v_period := p_quarter;
  while v_period < v_quarter_end loop
    perform pg_advisory_xact_lock(hashtextextended('values_period:' || v_period::text, 0));
    v_period := (v_period + interval '1 month')::date;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('values_freeze:' || p_quarter::text, 0));

  -- QUARTER-WIDE POLICY PROVENANCE (independent review: a single "latest
  -- rubric ever inserted" scalar is a fake answer for a mixed-version
  -- quarter — it can disagree with what any period in THIS quarter actually
  -- snapshotted at deal/submit time). Built once from every values_periods
  -- row this quarter's own assignments touched, SAFE fields only (no weight
  -- ladder — that stays owner-only, in private accounting below). The convenience
  -- scalars are set ONLY when every period agreed; a genuinely mixed
  -- quarter leaves them null rather than picking one arbitrarily.
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'periodStart', vp.period_start,
      'timezone', vp.timezone,
      'rubricVersion', vp.rubric_version,
      'algorithmVersion', vp.algorithm_version,
      'weightVersion', vp.weight_version,
      'minRaters', vp.min_raters
    ) order by vp.period_start), '[]'::jsonb),
    count(distinct vp.rubric_version),
    count(distinct vp.algorithm_version)
    into v_policy_versions, v_distinct_rubrics, v_distinct_algorithms
  from public.values_periods vp
  where vp.period_start >= p_quarter and vp.period_start < v_quarter_end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'periodStart', vp.period_start, 'timezone', vp.timezone,
    'rubricVersion', vp.rubric_version, 'algorithmVersion', vp.algorithm_version,
    'weightVersion', vp.weight_version, 'minRaters', vp.min_raters,
    'weightOwner', vp.weight_owner, 'weightLead', vp.weight_lead,
    'weightWorker', vp.weight_worker, 'weightSelf', vp.weight_self,
    'soloFactor', vp.solo_factor, 'cutoff', v_cutoff
  ) order by vp.period_start), '[]'::jsonb) into v_policy_snapshots
  from public.values_periods vp
  where vp.period_start >= p_quarter and vp.period_start < v_quarter_end;

  v_rubric := case when v_distinct_rubrics = 1
    then (select vp.rubric_version from public.values_periods vp
          where vp.period_start >= p_quarter and vp.period_start < v_quarter_end limit 1)
    else null end;
  v_algorithm := case when v_distinct_algorithms = 1
    then (select vp.algorithm_version from public.values_periods vp
          where vp.period_start >= p_quarter and vp.period_start < v_quarter_end limit 1)
    else null end;

  -- ENUMERATE FROM ASSIGNMENTS, not submissions (independent review finding
  -- #4): someone assigned reviews who received zero still gets a frozen
  -- null result, atomically with everyone else, rather than being silently
  -- left out and then picked up by a later run on whatever late answer
  -- happens to arrive first.
  for v_subject in
    select distinct subject_id from public.values_assignments
    where period_start >= p_quarter and period_start < v_quarter_end
  loop
    if exists (
      select 1 from public.values_quarterly_ratings
      where quarter_start = p_quarter and subject_id = v_subject
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- COMPLETE submissions, accepted BEFORE the exact cutoff instant, in the
    -- subject's own test/live partition only (independent review finding
    -- #3, and the caller-partition rule above) — _values_mirror's own
    -- complete-submission and partition filters apply here too, for free.
    v_rating := public._values_mirror(v_subject, p_quarter, v_quarter_end, 3, v_cutoff);
    select count(*) into v_sub_count from public.values_submissions s
      where s.subject_id = v_subject and s.period_start >= p_quarter and s.period_start < v_quarter_end
        and s.submitted_at < v_cutoff
        and public.is_test_profile(s.rater_id) = public.is_test_profile(v_subject)
        and (select count(*) from public.values_scores sc where sc.submission_id = s.id) = 8;
    select count(distinct s.rater_id) into v_rater_count from public.values_submissions s
      where s.subject_id = v_subject and s.period_start >= p_quarter and s.period_start < v_quarter_end
        and s.submitted_at < v_cutoff
        and s.rater_class <> 'self'
        and public.is_test_profile(s.rater_id) = public.is_test_profile(v_subject)
        and (select count(*) from public.values_scores sc where sc.submission_id = s.id) = 8;

    insert into public.values_quarterly_ratings (
      quarter_start, subject_id, overall, rater_count, submission_count, algorithm_version, cutoff, rubric_version,
      policy_versions
    )
    values (
      p_quarter, v_subject,
      (select avg((val->>'average')::numeric) from jsonb_each(v_rating) as t(slug, val) where val->>'average' is not null),
      v_rater_count, v_sub_count, v_algorithm, v_cutoff, v_rubric,
      v_policy_versions
    )
    on conflict (quarter_start, subject_id) do nothing
    returning id into v_rating_id;

    if v_rating_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.values_quarterly_values (rating_id, value_slug, score)
    select v_rating_id, slug, (val->>'average')::numeric
    from jsonb_each(v_rating) as t(slug, val)
    where val->>'average' is not null;

    -- Aggregate-only explanatory math, including zero and suppressed values.
    -- Exactly the same complete/cutoff/partition inputs as the visible mirror.
    insert into public.values_quarterly_accounting (rating_id, cutoff, policy_snapshots, value_totals)
    with contribution_rows as (
      select sc.value_slug, sc.score, s.rater_id, s.rater_class,
        (case s.rater_class when 'owner' then vp.weight_owner
          when 'crew_leader' then vp.weight_lead when 'worker' then vp.weight_worker
          when 'self' then vp.weight_self else 0 end)
          * (case when s.solo then vp.solo_factor else 1 end) as w
      from public.values_submissions s
      join public.values_scores sc on sc.submission_id = s.id
      join public.values_periods vp on vp.period_start = s.period_start
      where s.subject_id = v_subject and s.period_start >= p_quarter and s.period_start < v_quarter_end
        and s.submitted_at < v_cutoff
        and public.is_test_profile(s.rater_id) = public.is_test_profile(v_subject)
        and (select count(*) from public.values_scores c where c.submission_id = s.id) = 8
    ), totals as (
      select sl.slug,
        coalesce(sum(c.w * c.score), 0) as numerator, coalesce(sum(c.w), 0) as denominator,
        count(distinct c.rater_id) filter (where c.rater_class <> 'self') as raters,
        count(c.score) as submissions,
        coalesce(sum(c.score) filter (where c.rater_class = 'self'), 0) as self_sum,
        count(c.score) filter (where c.rater_class = 'self') as self_count
      from unnest(public._values_slugs()) sl(slug)
      left join contribution_rows c on c.value_slug = sl.slug
      group by sl.slug
    )
    select v_rating_id, v_cutoff, v_policy_snapshots,
      jsonb_object_agg(slug, jsonb_build_object(
        'weightedNumerator', numerator, 'weightedDenominator', denominator,
        'nonSelfRaters', raters, 'submissions', submissions,
        'selfSum', self_sum, 'selfCount', self_count
      )) from totals;

    -- Cross-partition source identities are omitted altogether. Same-
    -- partition late/incomplete evidence remains owner-only until its purge.
    insert into public.values_quarterly_manifest (
      rating_id, submission_id, rater_id, included, exclusion_reason
    )
    select v_rating_id, s.id, s.rater_id,
      calc.is_complete and s.submitted_at < v_cutoff,
      case when not calc.is_complete then 'incomplete'
           when s.submitted_at >= v_cutoff then 'late' else null end
    from public.values_submissions s
    cross join lateral (
      select (select count(*) from public.values_scores sc where sc.submission_id = s.id) = 8 as is_complete
    ) calc
    where s.subject_id = v_subject and s.period_start >= p_quarter and s.period_start < v_quarter_end
      and public.is_test_profile(s.rater_id) = public.is_test_profile(v_subject);

    v_frozen := v_frozen + 1;
  end loop;

  return jsonb_build_object('quarterStart', p_quarter, 'cutoff', v_cutoff, 'frozen', v_frozen, 'skipped', v_skipped);
end;
$$;

comment on function public._values_freeze_quarter(date) is
  'Freeze one quarter''s ratings (20261106000000) — idempotent by SKIPPING an already-frozen subject, never by overwriting. Service-only. Enumerates every ASSIGNED subject (not just those with submissions), so a zero-submission subject still freezes atomically with everyone else. Only submissions accepted before the exact Denver cutoff instant, with all eight scores, in the subject''s own test/live partition, are counted; same-partition late/incomplete evidence lands in a purgeable manifest, while cross-partition identities are omitted. Owner-only accounting freezes aggregate math and full period policies without raw contribution copies. policy_versions records every distinct period''s SAFE policy (never the weight ladder); the rubric_version/algorithm_version scalars are null when the quarter''s periods disagreed. Takes the same per-period advisory lock values_submit() does, for every period in the quarter, before reading anything.';

revoke all on function public._values_freeze_quarter(date) from public, anon, authenticated;

-- ============================================================================
-- 12. values_run_due — parameterless, service-only, disabled by default
-- ============================================================================

create or replace function public.values_run_due()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_now timestamptz := now();
  v_period date;
  v_deals jsonb := '[]'::jsonb;
  v_d jsonb;
  v_q date;
  v_last_q date;
  v_freezes jsonb := '[]'::jsonb;
  v_f jsonb;
begin
  select values_scheduler_enabled into v_enabled from public.company_settings where id = 1;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('skipped', 'scheduler disabled');
  end if;

  -- CATCH-UP DEALING (independent review finding #7): every month from
  -- launch through the current one gets a deal/top-up pass, not only
  -- "today's" period — a worker whose first shift of the month falls in the
  -- window's last days, or a scheduler outage spanning the whole open week,
  -- is caught up here instead of being missed outright. _values_deal_period
  -- is a cheap no-op on a month nothing changed, and assignmentsToStore's
  -- merge rule (see its own comment) makes repeated calls additive-safe. A
  -- month whose quarter has already closed is skipped — dealing into an
  -- already-frozen quarter cannot change its result and would only queue
  -- pointless late assignments.
  v_period := public._values_launch();
  while v_period <= public._values_active_period(v_now) loop
    if public._values_period_scorable(v_period)
       and not public._values_quarter_closed(public._values_quarter_of(v_period), v_now)
    then
      v_d := public._values_deal_period(v_period);
      v_deals := v_deals || jsonb_build_array(v_d);
    end if;
    v_period := (v_period + interval '1 month')::date;
  end loop;

  v_q := public._values_quarter_of(public._values_launch());
  v_last_q := public._values_quarter_of(public._values_day(v_now));
  while v_q <= v_last_q loop
    if public._values_quarter_closed(v_q, v_now) then
      v_f := public._values_freeze_quarter(v_q);
      v_freezes := v_freezes || jsonb_build_array(v_f);
    end if;
    v_q := (v_q + interval '3 months')::date;
  end loop;

  return jsonb_build_object('deals', v_deals, 'freezes', v_freezes);
end;
$$;

comment on function public.values_run_due() is
  'Parameterless, idempotent, service-only (20261106000000). Derives all timing from the database; takes no period argument, no client time, no secret. No-ops entirely unless company_settings.values_scheduler_enabled is true (owner-only switch, off by default). Not granted to anon/authenticated/service_role — reachable only by pg_cron calling it directly in SQL, never through PostgREST. No public HTTP endpoint exists for this. Deals/tops-up every open (not yet quarter-closed) scorable month on every run, not only the current one (catch-up), then freezes every closed, unfrozen quarter.';

revoke all on function public.values_run_due() from public, anon, authenticated, service_role;

-- Hourly poke, exactly like pipeline-sweep: cheap and harmless when the
-- scheduler is off (the function returns in one cheap SELECT), and correct
-- in both halves of the year without naming "the month's last week" in any
-- particular UTC offset.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'values-reviews-run-due') then
    perform cron.schedule(
      'values-reviews-run-due',
      '17 * * * *',
      $c$ select public.values_run_due(); $c$
    );
  end if;
end $$;

-- ============================================================================
-- 13. person_record_counts — add the new profile-referencing tables
-- ============================================================================
-- Restated in full (not patched) so the probe-list/SQL-key test
-- (purgeWords.test.ts, "the SQL and the probe list agree") can read the
-- complete current set from the LAST migration that defines this function —
-- exactly the pattern 20261055000000 itself used. Every key below this
-- migration's own seven is copied verbatim from 20261055000000.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'hex_learning_reviews.author_id', (select count(*) from hex_learning_reviews where author_id = p_id),
    'hex_learning_reviews.reviewer_id', (select count(*) from hex_learning_reviews where reviewer_id = p_id),
    'hex_learning_reviews.decided_by', (select count(*) from hex_learning_reviews where decided_by = p_id),
    'hex_learning_review_events.actor_id', (select count(*) from hex_learning_review_events where actor_id = p_id),
    'hex_learning_reviews.withdrawn_by', (select count(*) from hex_learning_reviews where withdrawn_by = p_id),
    'hex_learning_deliveries.last_caller', (select count(*) from hex_learning_deliveries where last_caller = p_id),
    'hex_learning_withdrawals.last_caller', (select count(*) from hex_learning_withdrawals where last_caller = p_id),
    'ai_field_requests.profile_id', (select count(*) from ai_field_requests where profile_id = p_id),
    'ai_field_actions.profile_id', (select count(*) from ai_field_actions where profile_id = p_id),
    'daily_log_contributions.actor_id', (select count(*) from daily_log_contributions where actor_id = p_id),
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_clock_actions.profile_id',
      (select count(*) from time_clock_actions where profile_id = p_id),
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'semimonthly_timecard_periods.profile_id',
      (select count(*) from semimonthly_timecard_periods where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  ) || jsonb_build_object(
    -- Monthly core-value reviews (20261106000000). All seven profile-reference CASCADE columns
    -- (see the table definitions above) — losing them with the account would
    -- lose a record of review work given or received.
    'values_assignments.rater_id', (select count(*) from values_assignments where rater_id = p_id),
    'values_assignments.subject_id', (select count(*) from values_assignments where subject_id = p_id),
    'values_submissions.rater_id', (select count(*) from values_submissions where rater_id = p_id),
    'values_submissions.subject_id', (select count(*) from values_submissions where subject_id = p_id),
    'values_quarterly_ratings.subject_id', (select count(*) from values_quarterly_ratings where subject_id = p_id),
    'values_quarterly_manifest.rater_id', (select count(*) from values_quarterly_manifest where rater_id = p_id),
    'values_reminder_claims.profile_id', (select count(*) from values_reminder_claims where profile_id = p_id)
  );
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;
