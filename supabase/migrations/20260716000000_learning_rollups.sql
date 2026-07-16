-- Phase A1: persist per-type learning so it drives dispatch, estimates, and UI
-- instead of being recomputed at read-time and thrown away.

alter table window_types
  add column if not exists n_installs int not null default 0,
  add column if not exists median_minutes numeric,
  add column if not exists p90_minutes numeric,
  add column if not exists avg_grade numeric,
  add column if not exists fail_rate numeric,
  add column if not exists learned_difficulty numeric,
  add column if not exists last_install_at timestamptz;

comment on column window_types.learned_difficulty is
  'Data-driven difficulty 1-5 from real outcomes: median-time percentile across the catalog + fail rate + inverse avg grade. No LLM.';

-- Recompute one type's rollups from its install_events.
create or replace function recompute_window_type_rollups(p_type_id uuid)
returns void
language plpgsql
as $$
declare
  v_n int;
  v_median numeric;
  v_p90 numeric;
  v_avg_grade numeric;
  v_fail numeric;
  v_last timestamptz;
  v_time_score numeric;
  v_grade_score numeric;
  v_diff numeric;
  v_min_med numeric;
  v_max_med numeric;
begin
  select
    count(*) filter (where minutes is not null),
    percentile_cont(0.5) within group (order by minutes) filter (where minutes is not null),
    percentile_cont(0.9) within group (order by minutes) filter (where minutes is not null),
    avg(quality_grade) filter (where quality_grade is not null),
    (count(*) filter (where quality_grade is not null and quality_grade <= 2))::numeric
      / nullif(count(*) filter (where quality_grade is not null), 0),
    max(created_at)
  into v_n, v_median, v_p90, v_avg_grade, v_fail, v_last
  from install_events
  where window_type_id = p_type_id;

  -- Difficulty model (1-5): where this type's median time sits across the
  -- catalog, nudged by fail rate and low grades. Falls back to seeded rating.
  select min(median_minutes), max(median_minutes)
  into v_min_med, v_max_med
  from window_types
  where median_minutes is not null;

  if v_median is not null and v_max_med is not null and v_max_med > coalesce(v_min_med, 0) then
    v_time_score := (v_median - v_min_med) / (v_max_med - v_min_med); -- 0..1
  else
    v_time_score := 0.5;
  end if;
  v_grade_score := coalesce((5 - v_avg_grade) / 4.0, 0.3); -- worse grade => harder
  v_diff := 1 + 4 * least(1, greatest(0,
    0.5 * v_time_score + 0.3 * coalesce(v_fail, 0) + 0.2 * v_grade_score));

  update window_types
  set n_installs = coalesce(v_n, 0),
      median_minutes = v_median,
      p90_minutes = v_p90,
      avg_grade = round(v_avg_grade, 2),
      fail_rate = round(v_fail * 100, 1),
      learned_difficulty = case when v_n >= 2 then round(v_diff, 2) else learned_difficulty end,
      last_install_at = v_last
  where id = p_type_id;
end;
$$;

create or replace function trg_recompute_rollups()
returns trigger
language plpgsql
as $$
declare
  v_type uuid;
begin
  v_type := coalesce(new.window_type_id, old.window_type_id);
  if v_type is not null then
    perform recompute_window_type_rollups(v_type);
  end if;
  -- On UPDATE that moved the row to a different type, refresh the old one too.
  if tg_op = 'UPDATE' and new.window_type_id is distinct from old.window_type_id
     and old.window_type_id is not null then
    perform recompute_window_type_rollups(old.window_type_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists install_events_rollups on install_events;
create trigger install_events_rollups
  after insert or update or delete on install_events
  for each row
  execute function trg_recompute_rollups();

-- Backfill every type that already has installs.
do $$
declare r record;
begin
  for r in select distinct window_type_id from install_events where window_type_id is not null
  loop
    perform recompute_window_type_rollups(r.window_type_id);
  end loop;
end;
$$;
