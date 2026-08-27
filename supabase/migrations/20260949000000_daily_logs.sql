-- Wave L, L1: foreman daily logs — the model. Owner decisions, settled in
-- the grill 2026-08-26 (cited here, never re-decided):
--
--   Q6: FOREMEN file daily logs; ONE shared log per job per day — any
--       foreman may edit it, and the log itself records who touched it
--       last (filed_by stamps on the row's first insert, updated_by on
--       every save after — including the first foreman's own later edit).
--       UNIQUE (project_id, log_date) is that "one log" rule enforced by
--       the database, not just by app code building one query a certain way.
--   Q7: Foreman+ read logs; installers never see them — frank friction
--       notes belong to the crew that can act on them. Enforced by RLS
--       (my_role_rank() >= 1 on SELECT), not just a hidden tab: a direct
--       REST call from an installer's own session comes back empty too.
--   Q9 follow-through: customer_visible exists from day one, with its
--       _at/_by stamp columns, but nothing in this wave sets or reads it —
--       wave S's reviewer-facing flow does that. Defaulting it false is
--       the only claim this migration makes about it.
--
-- notes is the one hard gate (NOT NULL; file_daily_log also checks it's not
-- empty after trimming — "what we got done" is the log, everything else is
-- color). day_flow is deliberately nullable: Smooth/Fine/Stuck is a
-- temperature reading a foreman may skip, never a second required field
-- sitting alongside notes.
--
-- All writes go through file_daily_log (SECURITY DEFINER, search_path
-- pinned) — house rule, same as timecard_periods/capability_badges/etc:
-- zero insert/update/delete policies below, so there is no direct-write
-- path that could skip the notes / day_flow / future-date validation.

create table if not exists daily_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  log_date date not null,
  headline text,
  notes text not null,
  day_flow text check (day_flow in ('smooth', 'fine', 'stuck')),
  -- Shape (a client convention, not a DB constraint): {went_well,
  -- went_poorly, would_have_helped, what_worked} — all optional strings.
  -- lib/dailyLogDraft.ts and the filing dialog are the one place that
  -- shape is read and written.
  reflection jsonb,
  weather text,
  customer_visible boolean not null default false,
  customer_visible_at timestamptz,
  customer_visible_by uuid references profiles(id) on delete set null,
  filed_by uuid not null references profiles(id),
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, log_date)
);

alter table daily_logs enable row level security;

-- Foreman+ only, full stop (Q7). No "or it's mine" clause: there is no
-- per-log owner, only one shared record per job per day.
drop policy if exists "daily_logs_select_foreman_plus" on daily_logs;
create policy "daily_logs_select_foreman_plus" on daily_logs
  for select to authenticated
  using (public.my_role_rank() >= 1);
-- No insert/update/delete policy — file_daily_log is the only writer.

-- ------------------------------------------------------------ file_daily_log
-- One shared log per job per day: upsert on (project_id, log_date).
-- filed_by stamps once, on the row's first insert; every save after (by the
-- same foreman or a different one) stamps updated_by — "the log records who
-- touched it last" (Q6) without losing who filed it originally.
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
  if not _is_lead(v_uid) then
    raise exception 'only a foreman or above can file a daily log';
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
