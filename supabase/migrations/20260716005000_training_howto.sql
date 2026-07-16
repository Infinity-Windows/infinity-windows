-- Phase B1: golden reference install + AI-generated how-to per type.

alter table window_types
  add column if not exists golden_install_event_id uuid references install_events(id) on delete set null,
  add column if not exists golden_locked boolean not null default false,
  add column if not exists howto_json jsonb,
  add column if not exists howto_generated_at timestamptz;

-- Auto-nominate the golden install for a type: best grade, then documented
-- (transcript + photos), most recent. Skips when a lead has locked one.
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

-- Fold golden selection into the rollup trigger so it stays fresh per install.
create or replace function trg_recompute_rollups()
returns trigger language plpgsql as $$
declare v_type uuid;
begin
  v_type := coalesce(new.window_type_id, old.window_type_id);
  if v_type is not null then
    perform recompute_window_type_rollups(v_type);
    perform pick_golden_install(v_type);
  end if;
  if tg_op = 'UPDATE' and new.window_type_id is distinct from old.window_type_id
     and old.window_type_id is not null then
    perform recompute_window_type_rollups(old.window_type_id);
    perform pick_golden_install(old.window_type_id);
  end if;
  return coalesce(new, old);
end;
$$;

-- Lead sets/locks a golden install manually.
create or replace function set_golden_install(p_type_id uuid, p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare v_role text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is distinct from 'lead' then
    raise exception 'only a lead can set the golden install';
  end if;
  update window_types
  set golden_install_event_id = p_event_id, golden_locked = true
  where id = p_type_id;
end;
$$;

-- Backfill golden picks for types that already have installs.
do $$ declare r record; begin
  for r in select distinct window_type_id from install_events where window_type_id is not null loop
    perform pick_golden_install(r.window_type_id);
  end loop;
end; $$;
