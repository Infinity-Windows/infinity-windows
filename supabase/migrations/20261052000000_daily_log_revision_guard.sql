-- A manual edit must name the shared log revision it was based on. The AI
-- contribution RPC uses the same job/day lock, so neither writer can race.
begin;

drop function public.file_daily_log(uuid, date, text, text, text, jsonb, text);

create function public.file_daily_log(
  p_project_id uuid,
  p_log_date date,
  p_headline text default null,
  p_notes text default null,
  p_day_flow text default null,
  p_reflection jsonb default null,
  p_weather text default null,
  p_expected_revision bigint default null
)
returns public.daily_logs
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_row public.daily_logs;
begin
  if not public.can_file_daily_log() then
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

  perform pg_advisory_xact_lock(hashtextextended('daily_log:' || p_project_id::text || ':' || p_log_date::text, 0));
  select * into v_row from public.daily_logs
    where project_id = p_project_id and log_date = p_log_date for update;
  if coalesce(v_row.revision, 0) <> p_expected_revision then
    raise exception 'daily log changed; review the current version before saving' using errcode = '40001';
  end if;

  if v_row.id is null then
    insert into public.daily_logs (project_id, log_date, headline, notes, day_flow, reflection, weather, filed_by)
    values (p_project_id, p_log_date, nullif(btrim(p_headline), ''), btrim(p_notes),
      p_day_flow, p_reflection, nullif(btrim(p_weather), ''), v_uid)
    returning * into v_row;
  else
    update public.daily_logs set
      headline = nullif(btrim(p_headline), ''), notes = btrim(p_notes),
      day_flow = p_day_flow, reflection = p_reflection, weather = nullif(btrim(p_weather), ''),
      updated_by = v_uid, updated_at = now()
    where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end $$;

revoke all on function public.file_daily_log(uuid, date, text, text, text, jsonb, text, bigint) from public, anon;
grant execute on function public.file_daily_log(uuid, date, text, text, text, jsonb, text, bigint) to authenticated;
commit;
