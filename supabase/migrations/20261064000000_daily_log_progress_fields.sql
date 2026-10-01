-- Daily log progress fields (Horizon parity, window work) — owner request
-- 2026-10-01. Extends the ONE shared job/day row (wave L) with the
-- structured facts Horizon's crew form captures and this app did not:
-- which window stages the crew worked today with a cumulative 0-100%
-- reading per stage, what the log covers (windows/doors/both), one or more
-- delay cards (Horizon shows multiple causes, each its own description/how
-- long/Happened-or-Still going/attribution — never a single cause), a
-- safety flag (never the safety words themselves — those stay in the
-- existing incident flow and this flag never reaches daily_logs.notes,
-- which stg_day hands to a builder login), a weather impact, what's missing
-- for tomorrow, tomorrow's plan, and the crew's own reported unit counts
-- (today / to date / remaining, plus which units remain).
--
-- Same door, same guard. Every new field rides through file_daily_log, so
-- it inherits can_file_daily_log() (installer and up, not partner) and the
-- revision-guarded upsert from 20261052000000 unchanged. No new RLS: the
-- existing daily_logs_select_crew policy already reads every column on the
-- row, this just widens the row.
--
-- Stage vocabulary is deliberately NOT an enum: a future stage must not
-- need a migration to say the word. Validated here against the same list
-- lib/dailyLogStages.ts carries (work_stage + the two non-stage chips), so
-- client and server agree without a shared table.
--
-- LEGACY OMISSION, FIXED. An earlier version of this migration defaulted
-- every missing structured param to empty/null and wrote that straight over
-- an existing row — so a caller that only knows the original 8 params (an
-- old client, a queued replay from before this wave existed) silently
-- erased every stage reading, unit count and tomorrow plan already on the
-- log. p_progress_provided is the fix: it is the one signal a caller that
-- doesn't know about these fields can never accidentally send. False
-- (the default) means "I am not answering for the structured fields at
-- all" and the row's existing structured columns are left untouched, not
-- cleared. True (every CURRENT caller passes it) means "here is the full,
-- deliberate structured snapshot, including any explicit clears" — this
-- is a real PUT for those fields, same as notes/headline/weather always were.
begin;

alter table public.daily_logs
  add column if not exists work_stages text[] not null default '{}',
  add column if not exists stage_progress jsonb not null default '{}'::jsonb,
  add column if not exists covers text,
  add column if not exists delays jsonb not null default '[]'::jsonb,
  add column if not exists safety_status text,
  add column if not exists weather_impact text,
  add column if not exists missing_tomorrow jsonb not null default '[]'::jsonb,
  add column if not exists tomorrow_stages text[] not null default '{}',
  add column if not exists tomorrow_crew_expected integer,
  add column if not exists tomorrow_plan text,
  add column if not exists units_today integer,
  add column if not exists units_to_date integer,
  add column if not exists units_remaining integer,
  add column if not exists units_remaining_detail text;

-- drop-if-exists before add: ADD CONSTRAINT has no IF NOT EXISTS for a plain
-- CHECK, and a replay of this migration (db-dry-run, a re-applied bundle)
-- must not fail on "constraint already exists" — confirmed by the
-- independent compatibility probe (compatibility-probe-result.json).
alter table public.daily_logs drop constraint if exists daily_logs_covers_ck;
alter table public.daily_logs add constraint daily_logs_covers_ck
  check (covers is null or covers in ('windows', 'doors', 'both'));
alter table public.daily_logs drop constraint if exists daily_logs_safety_status_ck;
alter table public.daily_logs add constraint daily_logs_safety_status_ck
  check (safety_status is null or safety_status in ('none_reported', 'reported'));
alter table public.daily_logs drop constraint if exists daily_logs_weather_impact_ck;
alter table public.daily_logs add constraint daily_logs_weather_impact_ck
  check (weather_impact is null or weather_impact in ('slowed', 'stopped', 'none'));
alter table public.daily_logs drop constraint if exists daily_logs_units_today_ck;
alter table public.daily_logs add constraint daily_logs_units_today_ck
  check (units_today is null or units_today >= 0);
alter table public.daily_logs drop constraint if exists daily_logs_units_to_date_ck;
alter table public.daily_logs add constraint daily_logs_units_to_date_ck
  check (units_to_date is null or units_to_date >= 0);
alter table public.daily_logs drop constraint if exists daily_logs_units_remaining_ck;
alter table public.daily_logs add constraint daily_logs_units_remaining_ck
  check (units_remaining is null or units_remaining >= 0);
alter table public.daily_logs drop constraint if exists daily_logs_tomorrow_crew_ck;
alter table public.daily_logs add constraint daily_logs_tomorrow_crew_ck
  check (tomorrow_crew_expected is null or tomorrow_crew_expected between 0 and 500);

comment on column public.daily_logs.work_stages is
  'Stage/non-stage keys the crew worked today (lib/dailyLogStages.ts WORK_STAGE_KEYS + NON_STAGE_WORK_KEYS). The multiselect; stage_progress is read only for the real-stage subset.';
comment on column public.daily_logs.stage_progress is
  'Cumulative 0-100 integer per real stage key, as of THIS log. "+N today" (which may be NEGATIVE on a downward correction) is a client-side diff against the project''s previous log, never stored twice.';
comment on column public.daily_logs.delays is
  'Array of {description, minutes, status: happened|still_going, attribution: builder|forge|weather|other} — Horizon''s multi-cause delay cards. Never read by payroll/clock code.';
comment on column public.daily_logs.units_today is
  'Crew-reported count of units completed today. NULL means not reported — distinct from 0, which is a reported zero. Never auto-derived from timers or sessions.';
comment on column public.daily_logs.units_remaining_detail is
  'Which units remain, in the crew''s own words — so "N remaining" always names them, not just counts them.';

-- -----------------------------------------------------------------------
-- file_daily_log: same signature, 15 new trailing params (14 structured
-- fields + p_progress_provided), all defaulted so every existing caller (the
-- manual editor on an old build, the AI contribution path, a queued replay
-- from before this wave) keeps working unchanged. Dropped and recreated
-- rather than CREATE OR REPLACE, matching 20261030000000's own precedent for
-- appending params to this function.
--
-- REPLAY SAFETY: a hand-written signature list here previously went stale
-- the moment this migration's own trailing params changed mid-development —
-- confirmed by the independent compatibility probe (compatibility-probe-
-- result-v3.json: "function file_daily_log already exists with same
-- argument types" on a second apply). Dropping EVERY overload of the name
-- by introspection, rather than naming exact argument lists, makes this
-- migration safe to re-apply regardless of which prior shape is live —
-- the original 8-arg prod function, an intermediate draft of this one, or
-- (idempotently) nothing at all.
do $$
declare
  v_sig text;
begin
  for v_sig in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'file_daily_log'
  loop
    execute format('drop function %s', v_sig);
  end loop;
end $$;

create function public.file_daily_log(
  p_project_id uuid,
  p_log_date date,
  p_headline text default null,
  p_notes text default null,
  p_day_flow text default null,
  p_reflection jsonb default null,
  p_weather text default null,
  p_expected_revision bigint default null,
  p_progress_provided boolean default false,
  p_work_stages text[] default null,
  p_stage_progress jsonb default null,
  p_covers text default null,
  p_delays jsonb default null,
  p_safety_status text default null,
  p_weather_impact text default null,
  p_missing_tomorrow jsonb default null,
  p_tomorrow_stages text[] default null,
  p_tomorrow_crew_expected integer default null,
  p_tomorrow_plan text default null,
  p_units_today integer default null,
  p_units_to_date integer default null,
  p_units_remaining integer default null,
  p_units_remaining_detail text default null
)
returns public.daily_logs
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_row public.daily_logs;
  v_work_stages text[] := coalesce(p_work_stages, '{}');
  v_tomorrow_stages text[] := coalesce(p_tomorrow_stages, '{}');
  v_stage_progress jsonb := coalesce(p_stage_progress, '{}'::jsonb);
  v_missing_tomorrow jsonb := coalesce(p_missing_tomorrow, '[]'::jsonb);
  v_delays jsonb := coalesce(p_delays, '[]'::jsonb);
  v_item text;
  v_kv record;
  v_elem jsonb;
begin
  if not public.can_file_daily_log() or not exists (
    select 1 from public.profiles where id = v_uid and retired_at is null
  ) then
    raise exception 'only internal crew can file a daily log';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and deleted_at is null) then
    raise exception 'choose an existing job for the daily log';
  end if;
  if p_notes is null or btrim(p_notes) = '' then
    raise exception 'notes are required — what did the crew get done today?';
  end if;
  if p_day_flow is not null and p_day_flow not in ('smooth', 'fine', 'stuck') then
    raise exception 'day flow must be smooth, fine, or stuck';
  end if;
  if p_log_date is null then
    raise exception 'a log date is required';
  end if;
  if p_log_date > current_date then
    raise exception 'the log date cannot be in the future';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'refresh the daily log before saving' using errcode = '40001';
  end if;

  -- Omission has the same meaning on insert and update. Do not apply
  -- unvalidated trailing arguments from a caller that did not provide a
  -- structured snapshot (including a NULL presence flag).
  if p_progress_provided is not true then
    v_work_stages := '{}';
    v_stage_progress := '{}'::jsonb;
    v_delays := '[]'::jsonb;
    v_missing_tomorrow := '[]'::jsonb;
    v_tomorrow_stages := '{}';
    p_covers := null;
    p_safety_status := null;
    p_weather_impact := null;
    p_tomorrow_crew_expected := null;
    p_tomorrow_plan := null;
    p_units_today := null;
    p_units_to_date := null;
    p_units_remaining := null;
    p_units_remaining_detail := null;
  end if;

  -- Structured-field validation only applies when this caller is actually
  -- answering for them (p_progress_provided) — a caller that left it false
  -- may have sent garbage in the trailing params (an old build sends
  -- nothing at all, so these are irrelevant) and none of it is ever read.
  if p_progress_provided then
    -- Stage vocabulary, validated against the same list the client carries
    -- (lib/dailyLogStages.ts). A key neither list knows is refused, not
    -- silently dropped — the client never sends one it didn't offer, so
    -- this only ever fires on a stale build or a hand-crafted call. A NULL
    -- array element (a malformed call bypassing the client entirely) is
    -- refused explicitly — `x not in (...)` on NULL is NULL, not true, and
    -- would otherwise slip through the loop unnoticed.
    foreach v_item in array v_work_stages loop
      if v_item is null or v_item not in ('prep','flashing','frames','glass','doors','hardware','sealing','qc','site_clean','corrections','material_run') then
        raise exception 'unknown work stage: %', coalesce(v_item, '<null>');
      end if;
    end loop;
    foreach v_item in array v_tomorrow_stages loop
      if v_item is null or v_item not in ('prep','flashing','frames','glass','doors','hardware','sealing','qc','site_clean') then
        raise exception 'unknown tomorrow stage: %', coalesce(v_item, '<null>');
      end if;
    end loop;
    if jsonb_typeof(v_stage_progress) <> 'object' then
      raise exception 'stage progress must be an object keyed by stage';
    end if;
    for v_kv in select * from jsonb_each(v_stage_progress) loop
      if v_kv.key not in ('prep','flashing','frames','glass','doors','hardware','sealing','qc','site_clean') then
        raise exception 'unknown stage in progress: %', v_kv.key;
      end if;
      -- Preserve a numeric JSON contract; text extraction alone would
      -- accept "50" and leave a string where readers expect a number.
      if jsonb_typeof(v_kv.value) is distinct from 'number'
        or v_kv.value::text !~ '^\d+$'
        or v_kv.value::text::numeric < 0 or v_kv.value::text::numeric > 100 then
        raise exception 'stage progress for % must be a whole number 0-100', v_kv.key;
      end if;
    end loop;

    if p_covers is not null and p_covers not in ('windows', 'doors', 'both') then
      raise exception 'covers must be windows, doors, or both';
    end if;

    -- Horizon's delay cards: ANY number of causes, each its own shape — not
    -- one cause object. description required; minutes optional >=0; status
    -- and attribution from fixed, closed lists.
    if jsonb_typeof(v_delays) <> 'array' then
      raise exception 'delays must be a list';
    end if;
    for v_elem in select * from jsonb_array_elements(v_delays) loop
      if jsonb_typeof(v_elem) <> 'object' then
        raise exception 'each delay entry must be an object';
      end if;
      if jsonb_typeof(v_elem->'description') is distinct from 'string'
        or coalesce(btrim(v_elem->>'description'), '') = '' then
        raise exception 'each delay entry needs a description';
      end if;
      if v_elem ? 'minutes' and jsonb_typeof(v_elem->'minutes') <> 'null' then
        if jsonb_typeof(v_elem->'minutes') <> 'number' or (v_elem->>'minutes')::numeric < 0 then
          raise exception 'a delay''s minutes must be a non-negative number';
        end if;
      end if;
      if coalesce(v_elem->>'status', '') not in ('happened', 'still_going') then
        raise exception 'unknown delay status: %', v_elem->>'status';
      end if;
      if coalesce(v_elem->>'attribution', '') not in ('builder', 'forge', 'weather', 'other') then
        raise exception 'unknown delay attribution: %', v_elem->>'attribution';
      end if;
    end loop;

    if p_safety_status is not null and p_safety_status not in ('none_reported', 'reported') then
      raise exception 'unknown safety status';
    end if;
    if p_weather_impact is not null and p_weather_impact not in ('slowed', 'stopped', 'none') then
      raise exception 'unknown weather impact';
    end if;
    if jsonb_typeof(v_missing_tomorrow) <> 'array' then
      raise exception 'missing-tomorrow must be a list';
    end if;
    for v_elem in select * from jsonb_array_elements(v_missing_tomorrow) loop
      if jsonb_typeof(v_elem) <> 'object'
        or jsonb_typeof(v_elem->'description') is distinct from 'string'
        or coalesce(btrim(v_elem->>'description'), '') = '' then
        raise exception 'each missing-tomorrow item needs a description';
      end if;
      if coalesce(v_elem->>'kind', 'material') not in ('material','equipment') then
        raise exception 'unknown missing-tomorrow kind: %', v_elem->>'kind';
      end if;
    end loop;
    if p_tomorrow_crew_expected is not null and (p_tomorrow_crew_expected < 0 or p_tomorrow_crew_expected > 500) then
      raise exception 'crew expected must be between 0 and 500';
    end if;
    if p_units_today is not null and p_units_today < 0 then raise exception 'units today cannot be negative'; end if;
    if p_units_to_date is not null and p_units_to_date < 0 then raise exception 'units to date cannot be negative'; end if;
    if p_units_remaining is not null and p_units_remaining < 0 then raise exception 'units remaining cannot be negative'; end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('daily_log:' || p_project_id::text || ':' || p_log_date::text, 0));
  select * into v_row from public.daily_logs
    where project_id = p_project_id and log_date = p_log_date for update;
  if coalesce(v_row.revision, 0) <> p_expected_revision then
    raise exception 'daily log changed; review the current version before saving' using errcode = '40001';
  end if;

  if v_row.id is null then
    -- Nothing to preserve on a first insert — use the provided snapshot
    -- (empty defaults if the caller never answered for it at all).
    insert into public.daily_logs (
      project_id, log_date, headline, notes, day_flow, reflection, weather, filed_by,
      work_stages, stage_progress, covers, delays, safety_status, weather_impact,
      missing_tomorrow, tomorrow_stages, tomorrow_crew_expected, tomorrow_plan,
      units_today, units_to_date, units_remaining, units_remaining_detail
    )
    values (
      p_project_id, p_log_date, nullif(btrim(p_headline), ''), btrim(p_notes),
      p_day_flow, p_reflection, nullif(btrim(p_weather), ''), v_uid,
      v_work_stages, v_stage_progress, p_covers, v_delays, p_safety_status, p_weather_impact,
      v_missing_tomorrow, v_tomorrow_stages, p_tomorrow_crew_expected, nullif(btrim(p_tomorrow_plan), ''),
      p_units_today, p_units_to_date, p_units_remaining, nullif(btrim(p_units_remaining_detail), '')
    )
    returning * into v_row;
  elsif p_progress_provided then
    -- A full, deliberate structured snapshot — may legitimately clear a
    -- nullable field (an explicit null is as real an answer as a value).
    update public.daily_logs set
      headline = nullif(btrim(p_headline), ''), notes = btrim(p_notes),
      day_flow = p_day_flow, reflection = p_reflection, weather = nullif(btrim(p_weather), ''),
      work_stages = v_work_stages, stage_progress = v_stage_progress, covers = p_covers,
      delays = v_delays, safety_status = p_safety_status, weather_impact = p_weather_impact,
      missing_tomorrow = v_missing_tomorrow, tomorrow_stages = v_tomorrow_stages,
      tomorrow_crew_expected = p_tomorrow_crew_expected, tomorrow_plan = nullif(btrim(p_tomorrow_plan), ''),
      units_today = p_units_today, units_to_date = p_units_to_date, units_remaining = p_units_remaining,
      units_remaining_detail = nullif(btrim(p_units_remaining_detail), ''),
      updated_by = v_uid, updated_at = now()
    where id = v_row.id returning * into v_row;
  else
    -- LEGACY OMISSION: this caller never answered for the structured
    -- fields at all. Every structured column is left exactly as it was —
    -- not in the SET list, not touched, not cleared. Only the text fields
    -- (which every caller, old or new, has always sent) change.
    update public.daily_logs set
      headline = nullif(btrim(p_headline), ''), notes = btrim(p_notes),
      day_flow = p_day_flow, reflection = p_reflection, weather = nullif(btrim(p_weather), ''),
      updated_by = v_uid, updated_at = now()
    where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end $$;

revoke all on function public.file_daily_log(
  uuid, date, text, text, text, jsonb, text, bigint, boolean, text[], jsonb, text, jsonb, text, text,
  jsonb, text[], integer, text, integer, integer, integer, text
) from public, anon;
grant execute on function public.file_daily_log(
  uuid, date, text, text, text, jsonb, text, bigint, boolean, text[], jsonb, text, jsonb, text, text,
  jsonb, text[], integer, text, integer, integer, integer, text
) to authenticated;

commit;
