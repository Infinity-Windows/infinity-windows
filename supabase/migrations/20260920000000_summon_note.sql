-- Summon for anyone, with an optional why (owner asks, 2026-08-19 night):
--
--   1. ANYONE can summon — the caller's clock-in requirement is gone. The
--      needed-at timer made this overdue: a foreman lining up hands for
--      "in 60 minutes" may not be on the clock yet, and the owner wants no
--      role or state gate on calling for help. ANSWERING still requires an
--      open shift (it starts the helper's clock), unchanged.
--   2. An optional note rides the summon ("second story, no elevator") so
--      answerers know what they're walking into.
--
-- create_summon is rebuilt from its CURRENT 3-arg body; the old signature
-- is dropped in the same migration (the overload lesson), and the new args
-- default so stale bundles still resolve here.

alter table summons add column if not exists note text;

drop function if exists create_summon(uuid, int, int);

create or replace function create_summon(
  p_opening_id uuid,
  p_needed int,
  p_lead_minutes int default null,
  p_note text default null
)
returns summons
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_row summons;
begin
  if p_needed is null or p_needed < 1 or p_needed > 8 then
    raise exception 'ask for between 1 and 8 helpers';
  end if;
  if p_lead_minutes is not null and (p_lead_minutes < 5 or p_lead_minutes > 480) then
    raise exception 'lead time must be between 5 minutes and 8 hours';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'keep the note under 500 characters';
  end if;
  select project_id into v_project from project_openings where id = p_opening_id;
  if v_project is null then
    raise exception 'opening not found';
  end if;
  if exists (
    select 1 from summons
    where opening_id = p_opening_id and status in ('open', 'covered')
  ) then
    raise exception 'a summon is already live on this window';
  end if;
  insert into summons (project_id, opening_id, requested_by, needed, needed_at, note)
  values (
    v_project, p_opening_id, v_uid, p_needed,
    case when p_lead_minutes is null then null
         else now() + make_interval(mins => p_lead_minutes) end,
    nullif(trim(p_note), '')
  )
  returning * into v_row;
  return v_row;
end;
$$;
