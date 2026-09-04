-- Wave Y — Who did what (transcripts program, grill of 2026-09-03, Q2).
--
-- Until now the app answered "who installed this window?" with "whoever
-- pressed Submit". That is the same person about nine times in ten, and wrong
-- the tenth: a foreman finishing a unit for an installer whose phone is dead,
-- a lead filing the last three of the day so the crew can drive home. Every
-- one of those quietly moved a window onto the filer's record — into his
-- median, his fail rate, the figures dispatch ranks him on — and off the
-- person who actually stood on the ladder.
--
-- Two facts, kept apart, fix it:
--
--   * WHO INSTALLED IT   install_events.credited_to (null = the filer)
--   * WHO FILED IT       install_events.installer_id, unchanged
--
-- The Record reads "Installed by Sam · filed by Jed", and every per-person
-- rollup in this database reads coalesce(credited_to, installer_id) from here
-- on. Credit is about the RECORD; it never moves a session. The finisher's
-- session stays the finisher's, because sessions follow the human (CONTEXT.md,
-- "Session") and the walk Jed made to that window is Jed's time.
--
-- And a second, older silence: assignment. `assigned_to` is a single column
-- that gets overwritten, so "who was this on before, and who moved it?" had no
-- answer at all — the previous assignee was simply gone. opening_assignment_events
-- is that answer, written by a trigger so no writing surface can forget, and
-- assign_opening_to_installer / unassign_opening finally carry the foreman+
-- rank that until today lived only in the buttons the UI chose to draw.
--
-- Deploy AFTER 20260980000000 (wave X) and 20260981000000 (wave H).

-- ===========================================================================
-- 1. Y1 — the credited installer
-- ===========================================================================
-- Nullable, and null MEANS "the filer installed it". Not a backfill: every row
-- filed before today was filed by whoever installed it as far as anyone knew,
-- and writing that guess into a column would turn an assumption into a record.

alter table install_events
  add column if not exists credited_to uuid references profiles(id) on delete set null;

comment on column install_events.credited_to is
  'Who actually installed this unit, when that is not the person who filed the event. NULL means installer_id — the filer did the work — and is the ordinary case. Every per-person rollup reads coalesce(credited_to, installer_id); nothing reads this column alone.';

-- The leaderboard and the timecard both ask "everything this person installed",
-- which is now two columns. One partial index on the rare one keeps that cheap
-- without paying for an index entry on the millions of rows where it is null.
create index if not exists install_events_credited_idx
  on install_events (credited_to, created_at desc)
  where credited_to is not null;


-- ---------------------------------------------------------------------------
-- 1a. The rule, in one place
-- ---------------------------------------------------------------------------
-- Returns NULL when the credit is allowed, and the SENTENCE to refuse with when
-- it is not — so the RPC and the table trigger below enforce one rule and say
-- the same words, rather than two copies that drift.
--
-- Who may credit whom:
--   * anybody may credit THEMSELVES (that is just filing your own work)
--   * a plain installer may additionally credit the person this unit is
--     ASSIGNED to — the one on-site case that needs no permission: the window
--     was Sam's, Sam did it, somebody else typed it in
--   * foreman and above may credit any active crew member
--
-- "Any active crew member" rather than "anyone with a shift on this job" on
-- purpose: a helper who walked over for a four-man lift and never clocked in to
-- that job still installed the window, and a rule that refuses the honest
-- answer teaches people to file the dishonest one. The picker on the sheet
-- offers the job's own crew first; the DATABASE only refuses names that are not
-- crew at all.
create or replace function public.credit_refusal(
  p_opening_id uuid,
  p_credited_to uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_assigned uuid;
begin
  -- Nothing claimed, nothing to check.
  if p_credited_to is null then
    return null;
  end if;

  -- No JWT means the service role or a migration, not a phone. The key IS the
  -- fence there; a rank check would only break the server's own jobs.
  if v_actor is null then
    return null;
  end if;

  if p_credited_to = v_actor then
    return null;
  end if;

  if not exists (
    select 1 from profiles
     where id = p_credited_to
       and active
       and not coalesce(is_partner, false)
  ) then
    return 'That person is not on the crew list, so the install cannot be filed under their name.';
  end if;

  if public.is_foreman_plus(v_actor) then
    return null;
  end if;

  select assigned_to into v_assigned from project_openings where id = p_opening_id;
  if v_assigned is not null and v_assigned = p_credited_to then
    return null;
  end if;

  return 'Only a foreman or above can file an install under somebody else''s name. You can record it as yours, or as the person this unit is assigned to.';
end;
$$;

comment on function public.credit_refusal(uuid, uuid) is
  'NULL when the calling user may credit p_credited_to with an install on p_opening_id, otherwise the plain-English sentence to refuse with. Rank 0 may credit self or the unit''s current assignee; foreman+ may credit any active crew member; a partner login is never a candidate. One rule, shared by submit_install_event and the table trigger.';

revoke all on function public.credit_refusal(uuid, uuid) from public, anon;
grant execute on function public.credit_refusal(uuid, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1b. submit_install_event — the wider arity
-- ---------------------------------------------------------------------------
-- A NEW EXACT ARITY, not a defaulted parameter on the old one. PostgREST picks
-- an overload by the SET OF ARGUMENT NAMES in the request body and a parameter
-- carrying a default is still a candidate, so a 17th defaulted parameter
-- alongside the 16-argument form would make every existing call ambiguous and
-- fail. Two exact arities never can be (the same reasoning wave E wrote down
-- for flag_opening, 20260977000000). The old form stays, rebuilt as a
-- one-line delegator, so there is exactly one body and one set of rules.
--
-- Rebuilt from the CURRENT body (20260811000000_opening_phases.sql — the
-- flashing gate included), never from an older copy.
create or replace function submit_install_event(
  p_opening_id uuid,
  p_installer text,
  p_minutes int,
  p_quality_grade int,
  p_difficulty text,
  p_went_well text,
  p_went_poorly text,
  p_obstacles text,
  p_tools_helped text,
  p_time_vs_estimate text,
  p_safety_notes text,
  p_do_again text,
  p_transcript_raw text,
  p_started_at timestamptz,
  p_installer_id uuid,
  p_estimate_minutes int,
  p_credited_to uuid
)
returns install_events
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
  v_event install_events;
  v_actor uuid := auth.uid();
  v_profile uuid := coalesce(p_installer_id, auth.uid());
  v_credited uuid;
  v_refusal text;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  if _flashing_outstanding(p_opening_id) then
    raise exception 'this opening needs flashing submitted before the install is filed';
  end if;

  -- p_installer_id has always been able to name somebody else, and doing so
  -- has always meant "file it as them". From wave Y that IS a credit, so it
  -- answers to the credit rule like every other one — otherwise the rule below
  -- would be one argument away from being no rule at all.
  v_refusal := public.credit_refusal(p_opening_id, nullif(v_profile, v_actor));
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;

  v_refusal := public.credit_refusal(p_opening_id, nullif(p_credited_to, v_actor));
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;

  -- Crediting the filer is what NULL already means. Storing it twice would
  -- give the same fact two spellings and every reader a choice to get wrong.
  v_credited := nullif(p_credited_to, v_profile);

  insert into install_events (
    project_opening_id, window_id, window_type_id, installer, installer_id,
    credited_to, started_at, minutes, estimate_minutes, quality_grade,
    difficulty, went_well, went_poorly, obstacles, tools_helped,
    time_vs_estimate, safety_notes, do_again, transcript_raw
  ) values (
    v_opening.id, v_opening.assigned_window_id, v_opening.window_type_id,
    p_installer, v_profile, v_credited, p_started_at, p_minutes,
    p_estimate_minutes, p_quality_grade, p_difficulty, p_went_well, p_went_poorly,
    p_obstacles, p_tools_helped, p_time_vs_estimate, p_safety_notes, p_do_again,
    p_transcript_raw
  )
  returning * into v_event;

  update project_openings
  set status = 'installed', confirmed = true, work_ended_at = now()
  where id = v_opening.id;

  if v_opening.assigned_window_id is not null then
    perform install_window(v_opening.assigned_window_id, p_installer);
  end if;

  -- Task-time follows the FILER, not the credited person: whoever is standing
  -- here is the one who is now between windows. Sessions follow the human.
  if v_profile is not null then
    perform close_open_task_sessions(v_profile);
    insert into task_sessions (profile_id, opening_id, project_id, state)
    values (v_profile, null, v_opening.project_id, 'off_task');
  end if;

  return v_event;
end;
$$;

-- The old sixteen-argument form, kept for every caller that has no credit to
-- name (which is most of them, most of the time) and rebuilt on top of the new
-- one so the rules live in exactly one body.
create or replace function submit_install_event(
  p_opening_id uuid,
  p_installer text default null,
  p_minutes int default null,
  p_quality_grade int default null,
  p_difficulty text default null,
  p_went_well text default null,
  p_went_poorly text default null,
  p_obstacles text default null,
  p_tools_helped text default null,
  p_time_vs_estimate text default null,
  p_safety_notes text default null,
  p_do_again text default null,
  p_transcript_raw text default null,
  p_started_at timestamptz default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
set search_path = public, pg_temp
as $$
begin
  return submit_install_event(
    p_opening_id, p_installer, p_minutes, p_quality_grade, p_difficulty,
    p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    p_started_at, p_installer_id, p_estimate_minutes, null);
end;
$$;

revoke all on function submit_install_event(
  uuid, text, int, int, text, text, text, text, text, text, text, text, text,
  timestamptz, uuid, int, uuid) from public, anon;
grant execute on function submit_install_event(
  uuid, text, int, int, text, text, text, text, text, text, text, text, text,
  timestamptz, uuid, int, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1c. finish_unit — the wider arity
-- ---------------------------------------------------------------------------
-- Same two-exact-arities shape. Rebuilt IN FULL from the current body
-- (20260964000000_finish_unit_own_sessions.sql), including the corrected
-- `project_opening_id` cutoff — the 2026-09-02 incident's fix, which
-- scripts/migration_lint.py now guards. Nothing about the minutes maths, the
-- session close or the chain moves; the only new line is the credit riding
-- through to submit_install_event.
create or replace function finish_unit(
  p_opening_id uuid,
  p_next_opening_id uuid,
  p_installer text,
  p_quality_grade int,
  p_difficulty text,
  p_went_well text,
  p_went_poorly text,
  p_obstacles text,
  p_tools_helped text,
  p_time_vs_estimate text,
  p_safety_notes text,
  p_do_again text,
  p_transcript_raw text,
  p_installer_id uuid,
  p_estimate_minutes int,
  p_credited_to uuid
)
returns install_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_minutes int;
  v_started timestamptz;
  v_event install_events;
  v_tiers int;
begin
  -- Close the caller's open session on this unit first so it counts. THE
  -- CALLER'S — crediting somebody else does not reach into their clock, and a
  -- finish filed for Sam still ends the session of whoever is standing here.
  update unit_sessions
  set ended_at = now(), end_reason = 'finish'
  where profile_id = v_uid and ended_at is null and opening_id = p_opening_id;

  -- Session-derived figures for THIS round: sessions since the last
  -- non-voided event ON THIS UNIT (all of them for a first install). The
  -- column is `project_opening_id`; a bare `opening_id` here resolves to the
  -- outer unit_sessions row instead and picks the newest install on the whole
  -- database (2026-09-02).
  select coalesce(sum(least(480,
           greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)))), 0)::int,
         min(started_at)
  into v_minutes, v_started
  from unit_sessions
  where opening_id = p_opening_id and ended_at is not null
    and started_at > coalesce(
      (select max(created_at) from install_events
       where project_opening_id = p_opening_id and voided_at is null),
      '-infinity'::timestamptz);

  v_event := submit_install_event(
    p_opening_id, p_installer, nullif(v_minutes, 0), p_quality_grade,
    p_difficulty, p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    v_started, p_installer_id, p_estimate_minutes, p_credited_to);

  -- Finishing resolves the unit's open redo, if any.
  update unit_redos
  set resolved_at = now()
  where opening_id = p_opening_id and resolved_at is null;

  -- The CHAIN — suppressed on multi-tier units (signature tiers > 1) and
  -- never allowed to sink the submit: a refused start (flashing owed on
  -- the next unit) leaves the finish standing.
  select coalesce(jsonb_array_length(signature -> 'tiers'), 1)
  into v_tiers from project_openings where id = p_opening_id;
  if p_next_opening_id is not null and coalesce(v_tiers, 1) <= 1 then
    begin
      perform start_unit_session(p_next_opening_id, 'install');
    exception when others then
      null; -- next starts by hand
    end;
  end if;

  return v_event;
end;
$$;

-- The old fifteen-argument form, delegating. A phone that is behind this
-- migration keeps finishing units exactly as it always has.
create or replace function finish_unit(
  p_opening_id uuid,
  p_next_opening_id uuid default null,
  p_installer text default null,
  p_quality_grade int default null,
  p_difficulty text default null,
  p_went_well text default null,
  p_went_poorly text default null,
  p_obstacles text default null,
  p_tools_helped text default null,
  p_time_vs_estimate text default null,
  p_safety_notes text default null,
  p_do_again text default null,
  p_transcript_raw text default null,
  p_installer_id uuid default null,
  p_estimate_minutes int default null
)
returns install_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return finish_unit(
    p_opening_id, p_next_opening_id, p_installer, p_quality_grade,
    p_difficulty, p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw,
    p_installer_id, p_estimate_minutes, null);
end;
$$;

revoke all on function finish_unit(
  uuid, uuid, text, int, text, text, text, text, text, text, text, text, text,
  uuid, int, uuid) from public, anon;
grant execute on function finish_unit(
  uuid, uuid, text, int, text, text, text, text, text, text, text, text, text,
  uuid, int, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1d. The same rule at the table, because the RPC is not the only door
-- ---------------------------------------------------------------------------
-- install_events' policy is `for all to authenticated using (not
-- is_partner_user() and (true))` (20260950000000), so a plain PATCH can set
-- credited_to on any row. Wave E made the same discovery about flag_kind and
-- answered it the same way: put the rule on the table too.
--
-- It also normalises credit-to-the-filer down to NULL from every door, so
-- "null means the filer" can never be broken by a caller that spells it out.
create or replace function public.guard_install_credit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refusal text;
  v_opening uuid;
begin
  if new.credited_to is not null and new.credited_to = new.installer_id then
    new.credited_to := null;
  end if;

  if tg_op = 'UPDATE' and new.credited_to is not distinct from old.credited_to then
    return new;
  end if;
  if new.credited_to is null then
    return new;
  end if;

  v_opening := new.project_opening_id;
  v_refusal := public.credit_refusal(v_opening, new.credited_to);
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.guard_install_credit() is
  'Applies credit_refusal to install_events.credited_to on every write, and folds "credited to the filer" down to NULL. The RPC says it first and better; this is the door a plain PATCH would otherwise walk through.';

drop trigger if exists install_events_credit_guard on install_events;
create trigger install_events_credit_guard
  before insert or update on install_events
  for each row execute function public.guard_install_credit();


-- ===========================================================================
-- 2. Y1 — every per-person reader switches to coalesce(credited_to, installer_id)
-- ===========================================================================
-- These are the figures a person is measured by, and the whole point of the
-- column is that they follow the work rather than the typing. Rebuilt from
-- their CURRENT definitions (20260730120000_test_accounts_excluded_from_learning.sql)
-- with one substitution each; the column lists are untouched, so
-- `create or replace view` is legal.

create or replace view installer_type_stats as
select
  coalesce(e.credited_to, e.installer_id) as installer_id,
  e.window_type_id,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade,
  (count(distinct e.id) filter (where e.quality_grade <= 2 or q.status = 'callback'))::numeric
    / nullif(count(*), 0) as fail_rate,
  max(e.created_at) as last_at
from install_events e
left join qc_checks q on q.project_opening_id = e.project_opening_id
where coalesce(e.credited_to, e.installer_id) is not null and e.window_type_id is not null
  and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
group by coalesce(e.credited_to, e.installer_id), e.window_type_id;

comment on view installer_type_stats is
  'Per-person proven performance per window type, which dispatch ranks on. The person is coalesce(credited_to, installer_id) — who installed it, not who typed it in (wave Y).';

create or replace view installer_category_stats as
select
  coalesce(e.credited_to, e.installer_id) as installer_id,
  t.category,
  count(*) filter (where e.minutes is not null) as n,
  percentile_cont(0.5) within group (order by e.minutes)
    filter (where e.minutes is not null) as median_minutes,
  avg(e.quality_grade) filter (where e.quality_grade is not null) as avg_grade
from install_events e
join window_types t on t.id = e.window_type_id
where coalesce(e.credited_to, e.installer_id) is not null and t.category is not null
  and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
group by coalesce(e.credited_to, e.installer_id), t.category;


-- The type rollups' test-account exclusion asks "was this a real person's
-- install?", so it has to ask about the person who INSTALLED it. A foreman
-- filing on behalf of the QA login is still a QA install and must still be
-- kept out of the numbers the crew is measured against.
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
    and not public.is_test_profile(coalesce(credited_to, installer_id));

  -- Problem = low grade OR a QC callback on that opening.
  select count(distinct e.id)
  into v_problem
  from install_events e
  left join qc_checks q on q.project_opening_id = e.project_opening_id
  where e.window_type_id = p_type_id
    and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
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


-- The golden install is the worked example a real installer is shown. Same
-- reasoning: a test account's install must not become the how-to, whoever
-- filed it.
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
    and not public.is_test_profile(coalesce(e.credited_to, e.installer_id))
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


-- A service case names the installer whose work is being called back. That is
-- a per-person fact — the Service page groups by it — so it follows the credit
-- too. Rebuilt in full from 20260718080030_chain_correctness_fixes.sql.
create or replace function open_service_case(
  p_window_id uuid,
  p_reason text,
  p_fail_point text default null,
  p_description text default null
)
returns service_cases
language plpgsql
security definer
as $$
declare
  v_role text;
  v_window windows;
  v_event install_events;
  v_case service_cases;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can open a service case';
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;

  -- Idempotent: one open case per unit. Return the existing open case if any.
  select * into v_case
  from service_cases
  where window_id = p_window_id and status = 'open'
  order by created_at desc
  limit 1;
  if v_case.id is not null then
    return v_case;
  end if;

  -- Latest non-voided install event for this unit gives us the opening,
  -- installer, and the exact event the failure traces back to.
  select * into v_event
  from install_events
  where window_id = p_window_id and voided_at is null
  order by created_at desc
  limit 1;

  insert into service_cases (
    window_id, install_event_id, project_id, opening_id, window_type_id,
    installer_id, status, reason, fail_point, description, reported_by
  ) values (
    p_window_id,
    v_event.id,
    v_window.project_id,
    v_event.project_opening_id,
    v_window.window_type_id,
    coalesce(v_event.credited_to, v_event.installer_id),
    'open',
    p_reason,
    p_fail_point,
    p_description,
    auth.uid()
  )
  returning * into v_case;

  return v_case;
end;
$$;


-- ===========================================================================
-- 3. Y5 — assignment history
-- ===========================================================================
-- `assigned_to` is one column that gets overwritten, so a reassignment erased
-- the fact that anybody else ever had the unit. Every "why was this sitting
-- unstarted for two days" conversation ran into that wall. One row per change,
-- written by a trigger rather than by each of the four surfaces that assign
-- (Dispatch, the flat map, Maps Interactive, auto-distribute) — a surface can
-- forget; a trigger on the column cannot.

create table if not exists opening_assignment_events (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  from_profile uuid references profiles(id) on delete set null,
  to_profile uuid references profiles(id) on delete set null,
  changed_by uuid references profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  via text not null check (via in ('dispatch', 'map', 'auto', 'unassign'))
);

create index if not exists opening_assignment_events_opening_idx
  on opening_assignment_events (opening_id, changed_at desc);
create index if not exists opening_assignment_events_project_idx
  on opening_assignment_events (project_id, changed_at desc);

comment on table opening_assignment_events is
  'One row per time a unit changed hands: who it was on, who it went to, who moved it, and from which surface. Written only by the trigger on project_openings.assigned_to, so no assigning screen can forget to log. Read by foreman+; a partner login never.';

alter table opening_assignment_events enable row level security;

-- Revoke BEFORE granting: this project's default privileges hand every new
-- table in `public` the full set to `authenticated`, and RLS alone is not the
-- wall. No insert/update/delete grant at all — the trigger is the only writer,
-- and it is SECURITY DEFINER for exactly that reason.
revoke all on opening_assignment_events from anon, authenticated;
grant select on opening_assignment_events to authenticated;
grant all on opening_assignment_events to service_role;

-- Foreman+ read: who is on what, and who moved it, is a supervision fact.
-- An installer sees their own list; they do not need the ledger of everyone
-- else's. Never a partner login — the mechanical wall guard every crew table
-- carries since 20260950000000.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'opening_assignment_events' and policyname = 'foreman read'
  ) then
    create policy "foreman read" on opening_assignment_events
      for select to authenticated
      using (not public.is_partner_user() and public.my_role_rank() >= 1);
  end if;
end;
$$;


-- The trigger. AFTER UPDATE OF assigned_to only: an opening is INSERTED
-- unassigned by every path that makes one (extraction, Studio, wave E's
-- add_field_unit), so there is no birth event to record, and a log row for
-- every one of the thousands of openings a planset creates would bury the
-- handful that are real handovers.
--
-- `via` cannot be worked out from the row — the database has no idea which
-- screen the tap came from — so assign_opening_to_installer states it in a
-- transaction-local setting below. Anything that writes assigned_to WITHOUT
-- going through the RPC (a plain PATCH) leaves it unset and reads as
-- 'dispatch', which is honest: somebody handed the unit out.
create or replace function public.trg_opening_assignment_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_via text;
begin
  if new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;

  if new.assigned_to is null then
    v_via := 'unassign';
  else
    v_via := coalesce(nullif(current_setting('app.assignment_via', true), ''), 'dispatch');
    -- A stray value must never be able to refuse an assignment: the check
    -- constraint is about the vocabulary, not about the crew's afternoon.
    if v_via not in ('dispatch', 'map', 'auto') then
      v_via := 'dispatch';
    end if;
  end if;

  insert into opening_assignment_events (
    opening_id, project_id, from_profile, to_profile, changed_by, via
  ) values (
    new.id, new.project_id, old.assigned_to, new.assigned_to, auth.uid(), v_via
  );

  return new;
end;
$$;

drop trigger if exists project_openings_assignment_log on project_openings;
create trigger project_openings_assignment_log
  after update of assigned_to on project_openings
  for each row execute function public.trg_opening_assignment_event();


-- ---------------------------------------------------------------------------
-- 3a. The rank the buttons were carrying on their own
-- ---------------------------------------------------------------------------
-- assign_opening_to_installer and unassign_opening (20260715240000) have never
-- had a rank check in SQL. The gate was `isForemanPlus` in the UI, which is a
-- hidden button, not a lock: any signed-in crew phone could hand work to
-- anybody. Every caller in the app is already behind that same UI gate
-- (DispatchBoard is only mounted for isLead, ProjectMap's controls are isLead,
-- MapsInteractive and JobModelViewer pass onAssign only for foreman+), so
-- nothing legitimate loses a door today — the check simply moves to where it
-- cannot be walked around.
--
-- assign_opening_to_installer is DROPPED and recreated rather than overloaded:
-- it gains a trailing p_via, and a defaulted parameter alongside the old
-- four-argument form would make every existing call ambiguous through
-- PostgREST (see 1b). With exactly ONE function, an old four-name call resolves
-- to it and takes the default.
drop function if exists assign_opening_to_installer(uuid, uuid, uuid, int);

create or replace function assign_opening_to_installer(
  p_opening_id uuid,
  p_profile_id uuid,
  p_actor_id uuid default null,
  p_sequence int default null,
  p_via text default 'dispatch'
)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  -- No JWT is the service role or a migration, not a phone; the key is the
  -- fence there.
  if auth.uid() is not null and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can hand out work.'
      using errcode = '42501';
  end if;

  -- Which screen this came from, for the history row the trigger writes.
  -- Transaction-local, so it can never leak into the next request.
  perform set_config('app.assignment_via', coalesce(p_via, 'dispatch'), true);

  update project_openings
  set assigned_to = p_profile_id,
      assigned_by = p_actor_id,
      assigned_at = now(),
      sequence = coalesce(p_sequence, sequence)
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;
  return v_opening;
end;
$$;

revoke all on function assign_opening_to_installer(uuid, uuid, uuid, int, text)
  from public, anon;
grant execute on function assign_opening_to_installer(uuid, uuid, uuid, int, text)
  to authenticated, service_role;

create or replace function unassign_opening(p_opening_id uuid)
returns project_openings
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opening project_openings;
begin
  if auth.uid() is not null and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can take work off somebody''s list.'
      using errcode = '42501';
  end if;

  update project_openings
  set assigned_to = null, assigned_by = null, assigned_at = null
  where id = p_opening_id
  returning * into v_opening;

  if v_opening is null then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;
  return v_opening;
end;
$$;

revoke all on function unassign_opening(uuid) from public, anon;
grant execute on function unassign_opening(uuid) to authenticated, service_role;


-- ===========================================================================
-- 4. Re-arm the sandbox fence
-- ===========================================================================
-- opening_assignment_events carries a project_id, which is what makes a table
-- project-scoped (sandbox_scoped_tables, 20260967000000), so the test-login
-- fence belongs on it. Idempotent: a table already correctly guarded is left
-- alone. scripts/test_sandbox_guard.py fails CI for exactly this omission.
select public.attach_sandbox_guards();
