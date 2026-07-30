-- Mark an account as a TEST account, and keep its work out of the numbers.
--
-- WHY THIS EXISTS. Verifying almost any screen in this app requires a login, and
-- until now there was no account anyone could sign in with except a real
-- person's. So a fix could be shipped and never seen — which is how "plans do
-- not render on iPhones" survived: nobody could open the screen to check.
--
-- The obvious answer, "make a test account", has a trap in it. `install_events`
-- is EMPTY on production today. `window_types.median_minutes` (target time),
-- `p90_minutes` (the slow case) and `learned_difficulty` are all derived from
-- that table by recompute_window_type_rollups(), fired by a trigger on every
-- insert. So the FIRST install event ever recorded sets the company's baseline
-- for that window type, and the second one makes it a median. A test account
-- tapping through an install to check that a screen loads would silently become
-- the reference the crew are measured against, and dispatch would route real
-- work on it. Deleting the row afterwards is not enough of a promise: the
-- damage happens the moment it is written, and nothing about it looks wrong.
--
-- So exclusion is a property of the DATABASE, not a rule in a document that a
-- future agent has to find and obey. A test account may tap anything; its
-- numbers are simply not counted.
--
-- WHAT THIS DOES NOT DO. It does not change who can read or write anything. No
-- policy, grant or guard is loosened; `is_test` is writable only by the
-- service-role key, exactly like `role` and `access_revoked_at`. On a database
-- with no test accounts every definition below computes precisely what it
-- computed before, because the filter it adds matches nothing.
--
-- See docs/test-account.md for the account itself and how to sign in as it.
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. The flag
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists is_test boolean not null default false;

comment on column public.profiles.is_test is
  'This login belongs to automation, not to a person. Its install events, per-installer stats and golden-install nominations are excluded from every company-wide figure. Set only by the service-role key (see scripts/provision-test-installer.py); no client role may write it.';

-- The profiles lockdown (20260729200000) replaced the table-level grants with
-- explicit column lists, so a new column is unreachable until it is named.
-- Readable, so the app can label a test row and leave it out of a leaderboard.
-- Writable by nobody: a crew member who could clear their own is_test flag
-- could launder a fabricated time into the company baseline, and one who could
-- SET it on somebody else could erase that person's record from the numbers.
grant select (is_test) on table public.profiles to authenticated;
revoke insert (is_test), update (is_test) on table public.profiles from anon, authenticated;

-- SECURITY DEFINER so the answer never depends on the caller's privileges on
-- profiles. The exclusions below are correctness filters inside aggregates, not
-- access control: if a future grant change made this column unreadable to the
-- caller, a non-definer lookup would quietly return NULL and the test rows
-- would flow straight back into the baselines. It reveals one boolean about an
-- account and can write nothing.
create or replace function public.is_test_profile(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_test from public.profiles where id = p_uid), false);
$$;

comment on function public.is_test_profile(uuid) is
  'True when this profile is an automation/test login. Used to keep test work out of window_types rollups, installer stats and golden installs.';

revoke all on function public.is_test_profile(uuid) from public, anon;
grant execute on function public.is_test_profile(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. Type rollups: target time, the slow case, and learned difficulty
-- ---------------------------------------------------------------------------
-- The definition in force is the one from 20260717007000_qc_flywheel.sql, which
-- folded QC callbacks into the fail rate. This is that function with one change:
-- every read of install_events skips events recorded by a test account. Nothing
-- else about the maths moves.
--
-- These are the figures that cannot be un-poisoned, because n_installs,
-- median_minutes, p90_minutes and learned_difficulty are what the crew are
-- measured against and what dispatch estimates from.

create or replace function recompute_window_type_rollups(p_type_id uuid)
returns void
language plpgsql
as $$
declare
  v_n int; v_total int; v_median numeric; v_p90 numeric; v_avg_grade numeric;
  v_problem int; v_fail numeric; v_last timestamptz;
  v_time_score numeric; v_grade_score numeric; v_diff numeric;
  v_min_med numeric; v_max_med numeric;
begin
  select
    count(*) filter (where minutes is not null),
    count(*),
    percentile_cont(0.5) within group (order by minutes) filter (where minutes is not null),
    percentile_cont(0.9) within group (order by minutes) filter (where minutes is not null),
    avg(quality_grade) filter (where quality_grade is not null),
    max(created_at)
  into v_n, v_total, v_median, v_p90, v_avg_grade, v_last
  from install_events
  where window_type_id = p_type_id
    and not public.is_test_profile(installer_id);

  -- Problem = low grade OR a QC callback on that opening.
  select count(distinct e.id)
  into v_problem
  from install_events e
  left join qc_checks q on q.project_opening_id = e.project_opening_id
  where e.window_type_id = p_type_id
    and not public.is_test_profile(e.installer_id)
    and (e.quality_grade <= 2 or q.status = 'callback');

  v_fail := case when coalesce(v_total,0) > 0 then v_problem::numeric / v_total else null end;

  select min(median_minutes), max(median_minutes) into v_min_med, v_max_med
  from window_types where median_minutes is not null;

  if v_median is not null and v_max_med is not null and v_max_med > coalesce(v_min_med, 0) then
    v_time_score := (v_median - v_min_med) / (v_max_med - v_min_med);
  else
    v_time_score := 0.5;
  end if;
  v_grade_score := coalesce((5 - v_avg_grade) / 4.0, 0.3);
  v_diff := 1 + 4 * least(1, greatest(0,
    0.5 * v_time_score + 0.3 * coalesce(v_fail, 0) + 0.2 * v_grade_score));

  update window_types
  set n_installs = coalesce(v_n, 0), median_minutes = v_median, p90_minutes = v_p90,
      avg_grade = round(v_avg_grade, 2),
      fail_rate = round(coalesce(v_fail, 0) * 100, 1),
      learned_difficulty = case when v_total >= 2 then round(v_diff, 2) else learned_difficulty end,
      last_install_at = v_last
  where id = p_type_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. The golden install: the worked example the crew are shown
-- ---------------------------------------------------------------------------
-- A test event could be nominated as the reference install for a window type
-- and end up illustrating the how-to a real installer reads on site. Same
-- definition as 20260716005000_training_howto.sql, minus test events.

create or replace function pick_golden_install(p_type_id uuid)
returns void
language plpgsql
as $$
declare v_locked boolean; v_golden uuid;
begin
  select golden_locked into v_locked from window_types where id = p_type_id;
  if v_locked then return; end if;

  select e.id into v_golden
  from install_events e
  where e.window_type_id = p_type_id
    and not public.is_test_profile(e.installer_id)
  order by
    coalesce(e.quality_grade, 0) desc,
    (e.transcript_raw is not null) desc,
    (exists (select 1 from attachments a
             where a.install_event_id = e.id and a.kind = 'photo')) desc,
    e.created_at desc
  limit 1;

  update window_types set golden_install_event_id = v_golden where id = p_type_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Per-installer stats, which dispatch ranks on
-- ---------------------------------------------------------------------------
-- A test account with a fabricated time on a type would look like the fastest
-- installer the company has, and assign_opening_to_installer reads these. The
-- column lists are unchanged, so `create or replace view` is legal.
--
-- installer_type_stats: as redefined by 20260717007000_qc_flywheel.sql.

create or replace view installer_type_stats as
select
  e.installer_id, e.window_type_id,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade,
  (count(distinct e.id) filter (where e.quality_grade <= 2 or q.status = 'callback'))::numeric
    / nullif(count(*), 0) as fail_rate,
  max(e.created_at) as last_at
from install_events e
left join qc_checks q on q.project_opening_id = e.project_opening_id
where e.installer_id is not null and e.window_type_id is not null
  and not public.is_test_profile(e.installer_id)
group by e.installer_id, e.window_type_id;

-- installer_category_stats: as defined by 20260716002000_installer_stats.sql.

create or replace view installer_category_stats as
select
  e.installer_id,
  t.category,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade
from install_events e
join window_types t on t.id = e.window_type_id
where e.installer_id is not null and t.category is not null
  and not public.is_test_profile(e.installer_id)
group by e.installer_id, t.category;


-- ---------------------------------------------------------------------------
-- 5. Recompute, so the stored rollups match the new definitions
-- ---------------------------------------------------------------------------
-- A no-op on production today: install_events is empty, so there is nothing to
-- recompute and no stored figure changes. It matters on any database that
-- already holds test events — the filter above only governs future writes
-- until the cached numbers in window_types are rebuilt.

do $$ declare r record; begin
  for r in select distinct window_type_id from install_events
           where window_type_id is not null loop
    perform recompute_window_type_rollups(r.window_type_id);
    perform pick_golden_install(r.window_type_id);
  end loop;
end; $$;
