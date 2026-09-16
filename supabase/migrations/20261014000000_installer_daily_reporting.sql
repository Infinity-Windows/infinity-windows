-- Owner request, 2026-09-16: daily reporting is open to installers from now on.
-- Keep one shared job/day log, existing authorship, validation and sharing rules.
begin;
create or replace function public.can_file_daily_log()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and not public.is_partner_user() and exists (
    select 1 from public.profiles where id = auth.uid() and access_revoked_at is null
      and role in ('installer','foreman','lead','supervisor','admin','owner','big_boss')
  )
$$;
revoke all on function public.can_file_daily_log() from public, anon;
grant execute on function public.can_file_daily_log() to authenticated;

-- Partners may carry an installer role, so the old rank-only policy is no
-- longer sufficient. On-site availability (profiles.active) is not login access.
drop policy if exists "daily_logs_select_foreman_plus" on public.daily_logs;
drop policy if exists "daily_logs_select_crew" on public.daily_logs;
create policy "daily_logs_select_crew" on public.daily_logs for select to authenticated
  using (not public.is_partner_user() and public.can_file_daily_log());

create or replace function file_daily_log(
  p_project_id uuid,
  p_log_date date,
  p_headline text default null,
  p_notes text default null,
  p_day_flow text default null,
  p_reflection jsonb default null,
  p_weather text default null
)
returns daily_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row daily_logs;
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
  -- A coarse backstop only, not the source of truth for "today": this is
  -- the server's own calendar day, and the whole point of the client's one
  -- shared localDateISO() (lib/dailyLogDay.ts) is that a phone's local day
  -- is what decides log_date, never a second copy of that math re-derived
  -- here. Horizon's reminder chip and its filing flow each rolled their own
  -- local-midnight math and quietly disagreed near it; this check only
  -- catches a date obviously in the future, whatever sent it.
  if p_log_date > current_date then
    raise exception 'the log date cannot be in the future';
  end if;

  insert into daily_logs (
    project_id, log_date, headline, notes, day_flow, reflection, weather,
    filed_by
  )
  values (
    p_project_id, p_log_date, nullif(btrim(p_headline), ''), btrim(p_notes),
    p_day_flow, p_reflection, nullif(btrim(p_weather), ''), v_uid
  )
  on conflict (project_id, log_date) do update
    set headline   = excluded.headline,
        notes      = excluded.notes,
        day_flow   = excluded.day_flow,
        reflection = excluded.reflection,
        weather    = excluded.weather,
        updated_by = v_uid,
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function file_daily_log(uuid, date, text, text, text, jsonb, text) from public;
grant execute on function file_daily_log(uuid, date, text, text, text, jsonb, text) to authenticated;

commit;
