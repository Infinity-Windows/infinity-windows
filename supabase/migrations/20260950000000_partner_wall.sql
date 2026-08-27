-- Wave S, S1: the partner wall.
--
-- Owner decisions, ALL settled (grill Q9 + Round 2, 2026-08-26/27 — cited,
-- never re-decided): builders/GCs get logins, branded STG Windows & Doors,
-- seeing what 1st Light sees at Horizon (Q9). Q12: EXPLICIT per-login job
-- grants, no builder-orgs table in v1. Q13: OWNER-ONLY creates/invites
-- builder logins and grants jobs. Q14: photos and log text alike stay
-- hidden until a supervisor shares that day's log; system facts (dates,
-- progress, worked-days, names + total hours) are never gated. Q15: even a
-- shared log stays hidden on a job until 70% of its worked days have logs.
-- Recorded calls: partners live OUTSIDE the crew role ladder and can never
-- reach a crew screen — server-enforced, not just hidden nav.
--
-- THE WALL. A builder login is an `authenticated` Supabase user. Nearly
-- every crew table's select policy says `to authenticated using (true)`-ish
-- — before this migration, a partner could hand-query REST and read
-- packages, shifts, logs, profiles, wide open. This migration is that wall:
--
--   1. profiles.is_partner — a column, not a role. Column-revoked from
--      client writes (the is_test-on-profiles precedent, 20260730120000).
--   2. is_partner_user() — SECURITY DEFINER, current uid's flag, built like
--      _is_supervisor (20260810000000) and my_role_rank (20260729200000).
--   3. THE SWEEP: every table in `public` carrying a live SELECT-or-ALL
--      policy that grants to `authenticated`, gets `not
--      public.is_partner_user() and (...)` folded into that policy's USING
--      (and, for a FOR ALL policy, its WITH CHECK too — the sweep's own
--      text only says "using", but a FOR ALL policy's CHECK is the write
--      side of the exact same hole: leaving it open would let a partner
--      INSERT/UPDATE a crew table blind, which is worse than reading it).
--      Every policy keeps its exact name, command, roles and original
--      predicate — the only change is the guard folded around it. Two
--      tables are deliberately EXEMPT (`partner_wall_exempt_tables` in
--      scripts/partner_wall_lib.py is the canonical, hand-maintained list
--      this comment and that file's test both read from):
--        - projects: partners need their granted rows readable — see #4.
--        - daily_logs: partners never read the table at all, under any
--          predicate; the projection RPC (S3) is the only door, and
--          daily_logs' own policy (my_role_rank() >= 1) already excludes
--          the installer-ranked partner floor before the wall is even
--          asked — see #7 for why the role value doesn't do the real work.
--   4. projects gets a third OR clause: a partner sees a job's row when it
--      is one of theirs, so the app shell can name granted jobs — nothing
--      more (their opening/shift/log data still never resolves, because
--      THOSE tables are swept and give partners nothing regardless of
--      which project they mention).
--   5. Crew ROUTES redirect (frontend, S4) — server-side, this migration,
--      is the real wall; the redirect is manners.
--   6. e2e (S4) covers the redirect negative. scripts/test_partner_wall.py
--      covers this migration: it re-derives, by replaying every migration
--      in this repo exactly the way `supabase_merge_lib.parse_migrations`
--      derives table shape, which tables carry a live client-facing SELECT
--      policy today, and fails if any of them — outside the two exempt
--      tables above — lacks the `is_partner_user()` guard. A future
--      migration that adds a table and a naive `using (true)` select policy
--      makes that test fail on ITS OWN, with no edit to this file required
--      — that is the whole point: a future table cannot silently skip the
--      wall by nobody remembering to update a hand-written list here.
--
-- Read first (per the spec): CONTEXT.md, 20260933000000 (the is_test
-- precedent this migration's column follows), 20260729200000 (profiles
-- lockdown, which is why profiles needs column-level grants at all), wave
-- L's daily_logs migration (20260949000000) and lib/dailyLogCoverage.ts
-- (the coverage ratio S3's stg_day implements in SQL).


-- ============================================================================
-- 1. profiles.is_partner
-- ============================================================================
-- Exact shape of the is_test-on-profiles precedent (20260730120000): add,
-- comment, grant select back (so anyone who can already see a row — i.e.
-- everyone except a partner reading past their own wall, since RLS still
-- gates row visibility regardless of this column grant — can tell a partner
-- row from a crew row; /account/builders' listing depends on this), revoke
-- insert/update from both client roles (only trg_guard_profile_insert, which
-- runs as the table owner and so bypasses grants entirely, may ever set it).

alter table public.profiles
  add column if not exists is_partner boolean not null default false;

comment on column public.profiles.is_partner is
  'A builder/GC login (STG Windows & Doors view) — never a crew member. Sees only /stg and only jobs granted in partner_job_grants; every crew table is walled off to it regardless of role or rank (see is_partner_user() and the sweep in this migration). Set only by trg_guard_profile_insert, from partner_invites, on first sign-in; no client role may write it directly.';

grant select (is_partner) on table public.profiles to authenticated;
revoke insert (is_partner), update (is_partner) on table public.profiles from anon, authenticated;


-- ============================================================================
-- 2. is_partner_user(): the caller's own flag
-- ============================================================================
-- Built exactly like _is_supervisor(uuid) (20260810000000) and my_role_rank()
-- (20260729200000): SQL, STABLE, SECURITY DEFINER, search_path pinned so it
-- can never be tricked into resolving `profiles` through anything but the
-- schema it was written against. SECURITY DEFINER matters twice over here:
-- it is what lets this run inside a policy ON profiles itself without RLS
-- recursion (same reason my_role_rank() is a definer), and it is what lets
-- the CLIENT call it directly — `supabase.rpc('is_partner_user')` — to
-- decide whether to route to /stg (S4), since a partner cannot read their
-- own profiles row once the sweep lands (the row is invisible to them, same
-- as every other row) and so cannot answer that question with a plain
-- select no matter what is granted on the column.
--
-- Zero-arg on purpose, unlike is_test_profile(p_uid) — THE WALL is explicit
-- that this reads "current uid's flag", never an arbitrary other user's, so
-- there is no argument for a policy or a client call to misuse.

create or replace function public.is_partner_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select is_partner from public.profiles where id = auth.uid()), false);
$$;

comment on function public.is_partner_user() is
  'True when the calling user is a partner (builder/GC) login. SECURITY DEFINER so it can run inside a policy on profiles itself without RLS recursion, and so a partner can call it directly to learn their own status when reading their own profiles row is otherwise walled off. Used by every policy the partner-wall sweep touches, and callable by the client for the /stg route guard (S4).';

revoke all on function public.is_partner_user() from public, anon;
grant execute on function public.is_partner_user() to authenticated, service_role;


-- ============================================================================
-- 3. THE SWEEP
-- ============================================================================
-- Mechanical: every table below had a policy with `for select` or `for all`,
-- granting to `authenticated`, live as of the last migration that touched it
-- (verified by replaying every `create policy` / `drop policy` — literal AND
-- the handful built with `execute format(...)` over an array loop — in
-- migration order; scripts/test_partner_wall.py does this same replay as a
-- standing test, not just a one-time check while writing this file). Each
-- policy keeps its name, its command, its roles, and its original predicate
-- verbatim; only `not public.is_partner_user() and (...)` is added around
-- it (and around WITH CHECK too, for a FOR ALL policy — see the header).
-- 101 tables. Two exemptions (projects, daily_logs) are handled in their own
-- sections below, not here.

-- ---- access_requests ----
drop policy if exists "authenticated full access" on access_requests;
create policy "authenticated full access" on access_requests
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- ai_spend_alerts, ai_spend_limits, ai_spend_months, ai_usage_days,
-- ai_usage_events ---- already office-rank gated (ai_role_rank() >= 2, which
-- a partner's pinned installer rank never satisfies); swept anyway, because
-- the sweep is mechanical and does not carve out "already redundant" cases.
drop policy if exists "ai_spend_alerts_select_office" on ai_spend_alerts;
create policy "ai_spend_alerts_select_office" on ai_spend_alerts
  for select to authenticated
  using (not public.is_partner_user() and (public.ai_role_rank(auth.uid()) >= 2));

drop policy if exists "ai_spend_limits_select_office" on ai_spend_limits;
create policy "ai_spend_limits_select_office" on ai_spend_limits
  for select to authenticated
  using (not public.is_partner_user() and (public.ai_role_rank(auth.uid()) >= 2));

drop policy if exists "ai_spend_months_select_office" on ai_spend_months;
create policy "ai_spend_months_select_office" on ai_spend_months
  for select to authenticated
  using (not public.is_partner_user() and (public.ai_role_rank(auth.uid()) >= 2));

drop policy if exists "ai_usage_days_select_office" on ai_usage_days;
create policy "ai_usage_days_select_office" on ai_usage_days
  for select to authenticated
  using (not public.is_partner_user() and (public.ai_role_rank(auth.uid()) >= 2));

drop policy if exists "ai_usage_events_select_office" on ai_usage_events;
create policy "ai_usage_events_select_office" on ai_usage_events
  for select to authenticated
  using (not public.is_partner_user() and (public.ai_role_rank(auth.uid()) >= 2));

-- ---- app_feedback ----
drop policy if exists "app_feedback_select" on app_feedback;
create policy "app_feedback_select" on app_feedback
  for select to authenticated
  using (not public.is_partner_user() and (author = auth.uid() or exists ( select 1 from profiles where id = auth.uid() and role in ('owner', 'big_boss') )));

-- ---- ask_question_log ----
drop policy if exists "ask_question_log_select_foreman" on ask_question_log;
create policy "ask_question_log_select_foreman" on ask_question_log
  for select to authenticated
  using (not public.is_partner_user() and (public.can_read_ask_log(auth.uid())));

-- ---- attachments ----
drop policy if exists "authenticated full access" on attachments;
create policy "authenticated full access" on attachments
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- capability_badges ----
drop policy if exists "badges_select" on capability_badges;
create policy "badges_select" on capability_badges
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- change_orders ----
drop policy if exists "authenticated full access" on change_orders;
create policy "authenticated full access" on change_orders
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- checkout_reasons ----
drop policy if exists "crew read" on checkout_reasons;
create policy "crew read" on checkout_reasons
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- cost_codes ----
drop policy if exists "authenticated full access" on cost_codes;
create policy "authenticated full access" on cost_codes
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- crew_invites ----
drop policy if exists "crew_invites_select_supervisor" on crew_invites;
create policy "crew_invites_select_supervisor" on crew_invites
  for select to authenticated
  using (not public.is_partner_user() and (public.my_role_rank() >= 2));

-- ---- cycle_counts ----
drop policy if exists "authenticated full access" on cycle_counts;
create policy "authenticated full access" on cycle_counts
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- flash_run_assignments ----
drop policy if exists "flash_run_assignments_read" on flash_run_assignments;
create policy "flash_run_assignments_read" on flash_run_assignments
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- flights ----
drop policy if exists "flights read" on flights;
create policy "flights read" on flights
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "flights write" on flights;
create policy "flights write" on flights
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- ground_transport ----
drop policy if exists "ground read" on ground_transport;
create policy "ground read" on ground_transport
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "ground write" on ground_transport;
create policy "ground write" on ground_transport
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- incidents ----
drop policy if exists "authenticated full access" on incidents;
create policy "authenticated full access" on incidents
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- install_events ----
drop policy if exists "authenticated full access" on install_events;
create policy "authenticated full access" on install_events
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- installer_clearance ----
drop policy if exists "authenticated full access" on installer_clearance;
create policy "authenticated full access" on installer_clearance
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- issues ----
drop policy if exists "issues_select_live" on issues;
create policy "issues_select_live" on issues
  for select to authenticated
  using (not public.is_partner_user() and (opening_id is null or exists ( select 1 from project_openings o where o.id = issues.opening_id and o.removed_at is null )));

-- ---- job_costs ----
drop policy if exists "authenticated full access" on job_costs;
create policy "authenticated full access" on job_costs
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- job_notes ----
drop policy if exists "authenticated full access" on job_notes;
create policy "authenticated full access" on job_notes
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- knowledge_chunks ----
drop policy if exists "authenticated full access" on knowledge_chunks;
create policy "authenticated full access" on knowledge_chunks
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- knowledge_docs ----
drop policy if exists "authenticated full access" on knowledge_docs;
create policy "authenticated full access" on knowledge_docs
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- learn_priority_terms ----
drop policy if exists "authenticated full access" on learn_priority_terms;
create policy "authenticated full access" on learn_priority_terms
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- learn_progress ----
drop policy if exists "authenticated full access" on learn_progress;
create policy "authenticated full access" on learn_progress
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- learning_videos ----
drop policy if exists "crew read" on learning_videos;
create policy "crew read" on learning_videos
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- locations ----
drop policy if exists "authenticated full access" on locations;
create policy "authenticated full access" on locations
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- lodging ----
drop policy if exists "lodging read" on lodging;
create policy "lodging read" on lodging
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "lodging write" on lodging;
create policy "lodging write" on lodging
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- monday_jobs ----
drop policy if exists "lead read" on monday_jobs;
create policy "lead read" on monday_jobs
  for select to authenticated
  using (not public.is_partner_user() and (_is_lead(auth.uid())));

-- ---- movements ----
drop policy if exists "movements crew read" on movements;
create policy "movements crew read" on movements
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- notification_dismissals ----
drop policy if exists "own rows" on notification_dismissals;
create policy "own rows" on notification_dismissals
  for all to authenticated
  using (not public.is_partner_user() and (profile_id = auth.uid()))
  with check (not public.is_partner_user() and (profile_id = auth.uid()));

-- ---- opening_notes ----
drop policy if exists "opening_notes_select_all" on opening_notes;
create policy "opening_notes_select_all" on opening_notes
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- opening_phases ----
drop policy if exists "authenticated read" on opening_phases;
create policy "authenticated read" on opening_phases
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- overtime_rules ----
drop policy if exists "crew read" on overtime_rules;
create policy "crew read" on overtime_rules
  for select to authenticated
  using (not public.is_partner_user() and (true));
drop policy if exists "supervisor write" on overtime_rules;
create policy "supervisor write" on overtime_rules
  for all to authenticated
  using (not public.is_partner_user() and (_is_supervisor(auth.uid())))
  with check (not public.is_partner_user() and (_is_supervisor(auth.uid())));

-- ---- package_deliveries, package_marks, packages ---- named explicitly in
-- THE WALL's own intro text as an example of what a partner could read.
drop policy if exists "crew read" on package_deliveries;
create policy "crew read" on package_deliveries
  for select to authenticated
  using (not public.is_partner_user() and (true));

drop policy if exists "crew read" on package_marks;
create policy "crew read" on package_marks
  for select to authenticated
  using (not public.is_partner_user() and (true));

drop policy if exists "crew read" on packages;
create policy "crew read" on packages
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- part_type_options ----
drop policy if exists "part_type_options_select" on part_type_options;
create policy "part_type_options_select" on part_type_options
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- points_ledger ----
drop policy if exists "authenticated full access" on points_ledger;
create policy "authenticated full access" on points_ledger
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- procedures ----
drop policy if exists "procedures read" on procedures;
create policy "procedures read" on procedures
  for select to authenticated
  using (not public.is_partner_user() and (trip_id is null or travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "procedures write" on procedures;
create policy "procedures write" on procedures
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- profiles ---- named explicitly in THE WALL's own intro text. Note
-- this blocks a partner from reading ANY profiles row, including their OWN
-- — that is deliberate (see is_partner_user()'s own comment above for how
-- the client still learns partner-ness), not an oversight.
drop policy if exists "profiles_select_authenticated" on profiles;
create policy "profiles_select_authenticated" on profiles
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- project_mark_elevation_views ----
drop policy if exists "mark_elevation_views_select_authed" on project_mark_elevation_views;
create policy "mark_elevation_views_select_authed" on project_mark_elevation_views
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- project_mark_specs ----
drop policy if exists "mark_specs_select_authed" on project_mark_specs;
create policy "mark_specs_select_authed" on project_mark_specs
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- project_marks ----
drop policy if exists "crew read" on project_marks;
create policy "crew read" on project_marks
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- project_message_reads ----
drop policy if exists "project_message_reads_select_own" on project_message_reads;
create policy "project_message_reads_select_own" on project_message_reads
  for select to authenticated
  using (not public.is_partner_user() and (profile_id = auth.uid()));

-- ---- project_messages ----
drop policy if exists "project_messages_select_members" on project_messages;
create policy "project_messages_select_members" on project_messages
  for select to authenticated
  using (not public.is_partner_user() and (public.can_access_project_chat(project_id, auth.uid())));

-- ---- project_opening_pin_moves ----
drop policy if exists "pin_moves_select_authenticated" on project_opening_pin_moves;
create policy "pin_moves_select_authenticated" on project_opening_pin_moves
  for select to authenticated
  using (not public.is_partner_user() and (exists ( select 1 from project_openings o where o.id = project_opening_pin_moves.opening_id and o.removed_at is null )));

-- ---- project_openings ----
drop policy if exists "openings_select_live" on project_openings;
create policy "openings_select_live" on project_openings
  for select to authenticated
  using (not public.is_partner_user() and (removed_at is null));

-- ---- project_plan_outlines ----
drop policy if exists "authenticated full access" on project_plan_outlines;
create policy "authenticated full access" on project_plan_outlines
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- project_planset_pages ----
drop policy if exists "authenticated full access" on project_planset_pages;
create policy "authenticated full access" on project_planset_pages
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- project_plansets ----
drop policy if exists "authenticated full access" on project_plansets;
create policy "authenticated full access" on project_plansets
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- project_spec_discrepancies ----
drop policy if exists "spec_discrepancies_select_authed" on project_spec_discrepancies;
create policy "spec_discrepancies_select_authed" on project_spec_discrepancies
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- project_windows ----
drop policy if exists "authenticated full access" on project_windows;
create policy "authenticated full access" on project_windows
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- push_subscriptions ----
drop policy if exists "push_subscriptions_select_own" on push_subscriptions;
create policy "push_subscriptions_select_own" on push_subscriptions
  for select to authenticated
  using (not public.is_partner_user() and (profile_id = auth.uid()));

-- ---- qc_checks ----
drop policy if exists "authenticated full access" on qc_checks;
create policy "authenticated full access" on qc_checks
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- safety_acks ----
drop policy if exists "authenticated full access" on safety_acks;
create policy "authenticated full access" on safety_acks
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- safety_talks ----
drop policy if exists "authenticated full access" on safety_talks;
create policy "authenticated full access" on safety_talks
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- schedule_assignment_members ----
drop policy if exists "authenticated full access" on schedule_assignment_members;
create policy "authenticated full access" on schedule_assignment_members
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- schedule_assignments ---- named explicitly in THE WALL's own intro
-- text ("shifts") alongside time_shifts.
drop policy if exists "authenticated full access" on schedule_assignments;
create policy "authenticated full access" on schedule_assignments
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- schedule_events ----
drop policy if exists "authenticated full access" on schedule_events;
create policy "authenticated full access" on schedule_events
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- service_cases ----
drop policy if exists "authenticated full access" on service_cases;
create policy "authenticated full access" on service_cases
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- storage_containers ----
drop policy if exists "crew read" on storage_containers;
create policy "crew read" on storage_containers
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- studio_projects ----
drop policy if exists "crew read" on studio_projects;
create policy "crew read" on studio_projects
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- studio_units ----
drop policy if exists "read units" on studio_units;
create policy "read units" on studio_units
  for select to authenticated
  using (not public.is_partner_user() and (true));
drop policy if exists "supervisor manage" on studio_units;
create policy "supervisor manage" on studio_units
  for all to authenticated
  using (not public.is_partner_user() and (_is_supervisor(auth.uid())))
  with check (not public.is_partner_user() and (_is_supervisor(auth.uid())));

-- ---- summon_declines ----
drop policy if exists "summon_declines_read" on summon_declines;
create policy "summon_declines_read" on summon_declines
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- summon_helpers ----
drop policy if exists "summon_helpers_read" on summon_helpers;
create policy "summon_helpers_read" on summon_helpers
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- summons ----
drop policy if exists "summons_read" on summons;
create policy "summons_read" on summons
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- supplies ----
drop policy if exists "supplies crew read" on supplies;
create policy "supplies crew read" on supplies
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- supply_orders ----
drop policy if exists "authenticated full access" on supply_orders;
create policy "authenticated full access" on supply_orders
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- takeoff_items ----
drop policy if exists "takeoff_items_read" on takeoff_items;
create policy "takeoff_items_read" on takeoff_items
  for select to authenticated
  using (not public.is_partner_user() and (exists ( select 1 from takeoffs t where t.id = takeoff_id and ( public.is_foreman_plus(auth.uid()) or t.for_profile_id = auth.uid() or t.created_by = auth.uid() ) )));

-- ---- takeoffs ----
drop policy if exists "takeoffs_read" on takeoffs;
create policy "takeoffs_read" on takeoffs
  for select to authenticated
  using (not public.is_partner_user() and (public.is_foreman_plus(auth.uid()) or for_profile_id = auth.uid() or created_by = auth.uid()));

-- ---- task_sessions ----
drop policy if exists "authenticated full access" on task_sessions;
create policy "authenticated full access" on task_sessions
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- time_shift_edits ----
drop policy if exists "supervisor read" on time_shift_edits;
create policy "supervisor read" on time_shift_edits
  for select to authenticated
  using (not public.is_partner_user() and (_is_supervisor(auth.uid())));

-- ---- time_shifts ---- named explicitly in THE WALL's own intro text
-- ("shifts").
drop policy if exists "authenticated full access" on time_shifts;
create policy "authenticated full access" on time_shifts
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- timecard_periods ----
drop policy if exists "own or lead read" on timecard_periods;
create policy "own or lead read" on timecard_periods
  for select to authenticated
  using (not public.is_partner_user() and (profile_id = auth.uid() or _is_lead(auth.uid())));

-- ---- toolbox_completions ----
drop policy if exists "authenticated full access" on toolbox_completions;
create policy "authenticated full access" on toolbox_completions
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- toolbox_talk_assignments ----
drop policy if exists "lead manage" on toolbox_talk_assignments;
create policy "lead manage" on toolbox_talk_assignments
  for all to authenticated
  using (not public.is_partner_user() and (_is_lead(auth.uid())))
  with check (not public.is_partner_user() and (_is_lead(auth.uid())));
drop policy if exists "read assignments" on toolbox_talk_assignments;
create policy "read assignments" on toolbox_talk_assignments
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- toolbox_talk_library ----
drop policy if exists "read talks" on toolbox_talk_library;
create policy "read talks" on toolbox_talk_library
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- tools ----
drop policy if exists "authenticated full access" on tools;
create policy "authenticated full access" on tools
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- trip_attachments ----
drop policy if exists "attachments read" on trip_attachments;
create policy "attachments read" on trip_attachments
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "attachments write" on trip_attachments;
create policy "attachments write" on trip_attachments
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- trip_contacts ----
drop policy if exists "contacts read" on trip_contacts;
create policy "contacts read" on trip_contacts
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "contacts write" on trip_contacts;
create policy "contacts write" on trip_contacts
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- trip_crew ----
drop policy if exists "trip_crew read" on trip_crew;
create policy "trip_crew read" on trip_crew
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(trip_id) or travel_is_supervisor()));
drop policy if exists "trip_crew write" on trip_crew;
create policy "trip_crew write" on trip_crew
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- trips ----
drop policy if exists "trips read" on trips;
create policy "trips read" on trips
  for select to authenticated
  using (not public.is_partner_user() and (travel_is_trip_member(id) or travel_is_supervisor()));
drop policy if exists "trips write" on trips;
create policy "trips write" on trips
  for all to authenticated
  using (not public.is_partner_user() and (travel_is_supervisor()))
  with check (not public.is_partner_user() and (travel_is_supervisor()));

-- ---- unit_redos ----
drop policy if exists "unit_redos_read" on unit_redos;
create policy "unit_redos_read" on unit_redos
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- unit_sessions ----
drop policy if exists "unit_sessions_read" on unit_sessions;
create policy "unit_sessions_read" on unit_sessions
  for select to authenticated
  using (not public.is_partner_user() and (true));

-- ---- vehicle_devices ----
drop policy if exists "authenticated full access" on vehicle_devices;
create policy "authenticated full access" on vehicle_devices
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicle_drive_sessions ----
drop policy if exists "owner supervisor drive sessions" on vehicle_drive_sessions;
create policy "owner supervisor drive sessions" on vehicle_drive_sessions
  for all to authenticated
  using (not public.is_partner_user() and ((select role from profiles where id = auth.uid()) in ('owner','big_boss','supervisor','admin')))
  with check (not public.is_partner_user() and ((select role from profiles where id = auth.uid()) in ('owner','big_boss','supervisor','admin')));

-- ---- vehicle_drivers ----
drop policy if exists "authenticated full access" on vehicle_drivers;
create policy "authenticated full access" on vehicle_drivers
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicle_financials ----
drop policy if exists "owner only financials" on vehicle_financials;
create policy "owner only financials" on vehicle_financials
  for all to authenticated
  using (not public.is_partner_user() and ((select role from profiles where id = auth.uid()) = 'owner'))
  with check (not public.is_partner_user() and ((select role from profiles where id = auth.uid()) = 'owner'));

-- ---- vehicle_locations_history ----
drop policy if exists "authenticated full access" on vehicle_locations_history;
create policy "authenticated full access" on vehicle_locations_history
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicle_locations_latest ----
drop policy if exists "authenticated full access" on vehicle_locations_latest;
create policy "authenticated full access" on vehicle_locations_latest
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicle_project_assignments ----
drop policy if exists "authenticated full access" on vehicle_project_assignments;
create policy "authenticated full access" on vehicle_project_assignments
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicle_service_records ----
drop policy if exists "authenticated full access" on vehicle_service_records;
create policy "authenticated full access" on vehicle_service_records
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicle_service_schedules ----
drop policy if exists "authenticated full access" on vehicle_service_schedules;
create policy "authenticated full access" on vehicle_service_schedules
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- vehicles ----
drop policy if exists "authenticated full access" on vehicles;
create policy "authenticated full access" on vehicles
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- window_id_counters ----
drop policy if exists "authenticated full access" on window_id_counters;
create policy "authenticated full access" on window_id_counters
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- window_types ----
drop policy if exists "authenticated full access" on window_types;
create policy "authenticated full access" on window_types
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));

-- ---- windows ----
drop policy if exists "authenticated full access" on windows;
create policy "authenticated full access" on windows
  for all to authenticated
  using (not public.is_partner_user() and (true))
  with check (not public.is_partner_user() and (true));


-- ============================================================================
-- 4. partner_job_grants: which jobs a partner login may see
-- ============================================================================
-- Q12: explicit per-login job grants, no builder-orgs table in v1. Q13:
-- owner-only. House rule, same as daily_logs/timecard_periods/capability_
-- badges: zero insert/update/delete policies — grant_partner_job and
-- revoke_partner_job (SECURITY DEFINER) are the only writers, so there is
-- no direct-write path that could skip the owner-rank check. SELECT is
-- owner-rank too (not merely supervisor+): this table says exactly which
-- outside parties can see which jobs, and Q13 frames the whole area —
-- inviting, granting, and (S5) the screen that shows this table — as
-- owner-only throughout. Guarded with is_partner_user() too even though an
-- owner can never also be a partner — belt-and-suspenders, matching the
-- rest of this migration's own mechanical instinct rather than a special
-- case for a table THE WALL's sweep never touches (it didn't exist before
-- this migration, so it was never in the sweep's enumeration).

create table if not exists partner_job_grants (
  id uuid primary key default gen_random_uuid(),
  partner_profile_id uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  granted_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (partner_profile_id, project_id)
);

comment on table partner_job_grants is
  'Q12: explicit per-login job grants — the owner grants specific jobs to each builder login, one row per (partner, job). Written only by grant_partner_job / revoke_partner_job (owner-only). Read by: projects'' own select policy (a partner sees a granted job''s row), the S3 projection RPCs (SECURITY DEFINER, bypass this table''s own RLS to check a grant), and the owner''s /account/builders screen (owner-rank select policy below).';

alter table partner_job_grants enable row level security;

create policy "partner_job_grants_select_owner" on partner_job_grants
  for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 3);
-- No insert/update/delete policy — grant_partner_job/revoke_partner_job only.

revoke all on table partner_job_grants from anon, authenticated;
grant select on table partner_job_grants to authenticated;

create or replace function public.grant_partner_job(p_partner uuid, p_project uuid)
returns partner_job_grants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row partner_job_grants;
begin
  if public.my_role_rank() < 3 then
    raise exception 'only the owner can grant a job to a builder login'
      using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_partner and is_partner) then
    raise exception 'that login is not a builder (partner) login';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'that job does not exist';
  end if;

  insert into partner_job_grants (partner_profile_id, project_id, granted_by)
  values (p_partner, p_project, auth.uid())
  on conflict (partner_profile_id, project_id)
    do update set granted_by = excluded.granted_by
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.grant_partner_job(uuid, uuid) is
  'Owner-only: grants one job to one builder login (Q12/Q13). Idempotent — granting an already-granted job just refreshes granted_by.';

revoke all on function public.grant_partner_job(uuid, uuid) from public, anon;
grant execute on function public.grant_partner_job(uuid, uuid) to authenticated;

create or replace function public.revoke_partner_job(p_partner uuid, p_project uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.my_role_rank() < 3 then
    raise exception 'only the owner can revoke a builder login''s job'
      using errcode = '42501';
  end if;

  delete from partner_job_grants
   where partner_profile_id = p_partner and project_id = p_project;
end;
$$;

comment on function public.revoke_partner_job(uuid, uuid) is
  'Owner-only: revokes one job from one builder login (Q13). A no-op, not an error, when the pair was never granted.';

revoke all on function public.revoke_partner_job(uuid, uuid) from public, anon;
grant execute on function public.revoke_partner_job(uuid, uuid) to authenticated;


-- ============================================================================
-- 5. partner_invites: the allow-list a first sign-in is checked against
-- ============================================================================
-- Deliberately minimal — no code, no token, no redemption link (contrast
-- crew_invites, 20260730010000, which needs all of that because it also
-- MINTS the crew login through an edge function on the service-role key).
-- This table only answers one question at first-sign-in time: "did the
-- owner say this email may be a builder login?" How that person's Supabase
-- Auth account itself comes to exist — an admin-API invite from the
-- dashboard, most likely — is outside this table's job and outside this
-- migration; see the PR description for the operational note to the owner.
-- Consumed on use (see trg_guard_profile_insert below): once a profile is
-- created for an invited email, the row is deleted, so partner_invites
-- holds exactly the "pending, not yet signed in" set S5 lists, with no
-- separate status column required.

create table if not exists partner_invites (
  email text primary key,
  invited_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table partner_invites is
  'Emails the owner has allow-listed to become a builder (partner) login on first sign-in (Q13). Consumed — deleted — the moment that sign-in creates the profiles row; see trg_guard_profile_insert. Written only by add_partner_invite / remove_partner_invite (owner-only).';

alter table partner_invites enable row level security;

create policy "partner_invites_select_owner" on partner_invites
  for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 3);
-- No insert/update/delete policy — add_partner_invite/remove_partner_invite only.

revoke all on table partner_invites from anon, authenticated;
grant select on table partner_invites to authenticated;

create or replace function public.add_partner_invite(p_email text)
returns partner_invites
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_row partner_invites;
begin
  if public.my_role_rank() < 3 then
    raise exception 'only the owner can invite a builder login'
      using errcode = '42501';
  end if;
  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'give a real email address';
  end if;

  insert into partner_invites (email, invited_by)
  values (v_email, auth.uid())
  on conflict (email) do update set invited_by = excluded.invited_by
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.add_partner_invite(text) is
  'Owner-only: allow-lists an email to become a builder login on its first sign-in (Q13). Idempotent, case/whitespace-insensitive.';

revoke all on function public.add_partner_invite(text) from public, anon;
grant execute on function public.add_partner_invite(text) to authenticated;

create or replace function public.remove_partner_invite(p_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.my_role_rank() < 3 then
    raise exception 'only the owner can revoke a builder invite'
      using errcode = '42501';
  end if;

  delete from partner_invites where email = lower(btrim(coalesce(p_email, '')));
end;
$$;

comment on function public.remove_partner_invite(text) is
  'Owner-only: revokes a not-yet-claimed builder invite (Q13). A no-op, not an error, when the email was never invited or has already signed in (and so was already consumed).';

revoke all on function public.remove_partner_invite(text) from public, anon;
grant execute on function public.remove_partner_invite(text) to authenticated;


-- ============================================================================
-- 6. projects: the grant exception
-- ============================================================================
-- projects is exempt from the mechanical sweep above (see the header) because
-- a partner DOES need to read the row for each job they were granted — just
-- that row, and nothing beyond what the existing columns already expose (job
-- name, code, status; nothing crew-only lives on `projects` itself). Adds a
-- third OR arm to the is_test policy from 20260933000000 without touching
-- its first two; a partner still gets nothing from a job they were not
-- granted, and still gets nothing at all from every OTHER table the sweep
-- above locked — this is the one deliberate, narrow crack in the wall, and
-- it opens onto nothing but a project's own row. Placed here, after
-- partner_job_grants exists (section 4) rather than back in the sweep
-- (section 3), because its USING clause references that table by name —
-- creating this policy any earlier would fail at migration time with
-- "relation partner_job_grants does not exist".
drop policy if exists "projects_select_visible" on projects;
create policy "projects_select_visible" on projects
  for select to authenticated using (
    is_test = false or _is_supervisor(auth.uid())
    or (
      public.is_partner_user()
      and exists (
        select 1 from partner_job_grants g
        where g.project_id = projects.id and g.partner_profile_id = auth.uid()
      )
    )
  );


-- ============================================================================
-- 7. trg_guard_profile_insert: a first sign-in from an invited email
-- ============================================================================
-- Extends the trigger from 20260729200000 (the self-insert branch only —
-- the supervisor-creating-another-row branch above it is untouched). Checks
-- partner_invites BEFORE the existing role check, and returns early: an
-- invited email always becomes is_partner=true with role pinned 'installer'
-- and skips the role-must-be-installer check below (which would otherwise
-- reach the identical outcome anyway, since 'installer' is the only value
-- that check accepts from a non-founder email — the early return exists so
-- the is_partner stamp and the invite-consuming delete happen in the one
-- place that knows this is a partner sign-in, not to change what role ends
-- up on the row).
--
-- Role is pinned 'installer', same value the column already defaults to,
-- not because a partner does installer work but because THE WALL's sweep
-- (section 3 above) walls off every crew table by is_partner_user() FIRST,
-- before any predicate that reads role or rank ever runs — role stops
-- being the thing that matters the moment is_partner is true. Pinning it to
-- the lowest rank is belt-and-suspenders against a future bug that checks
-- rank without also checking is_partner, not a claim that rank does
-- anything for a partner today.

create or replace function public.trg_guard_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.id <> auth.uid() then
    if public.my_role_rank() < 2 then
      raise exception 'you may only create your own profile'
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  if exists (select 1 from partner_invites where email = v_email) then
    new.is_partner := true;
    new.role := 'installer';
    delete from partner_invites where email = v_email;
    return new;
  end if;

  if new.role is distinct from 'installer'
     and v_email not in ('ammon@horizonsolarusa.com', 'isaacammonbarlow@gmail.com')
  then
    raise exception
      'a new profile starts as installer; a supervisor or owner assigns the role'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
