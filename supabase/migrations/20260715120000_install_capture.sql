-- Install capture module: plansets, project openings (map pins), install
-- events (voice-memo brain), storage buckets, and RPCs.
--
-- Three IDs stay distinct:
--   window_types.type_code  -> catalog product (AI learning stacks here)
--   windows.window_id       -> physical unit (warehouse license plate)
--   project_openings.id     -> hole in the wall on this job's planset (map pin)

-- Uploaded planset documents. PDF is the working format; DWG/DXF are stored
-- raw with status 'converting' until a server-side conversion exists.
create table project_plansets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  storage_path text not null,
  source_format text not null check (source_format in ('pdf','dwg','dxf')),
  converted_pdf_path text,
  page_count int,
  status text not null default 'uploaded'
    check (status in ('uploaded','converting','extracting','ready','failed')),
  created_at timestamptz not null default now()
);

-- One row per opening on the planset. pin_x/pin_y are normalized (0-1) on the
-- rendered page image so pins survive any render scale.
create table project_openings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  planset_id uuid references project_plansets(id) on delete set null,
  opening_code text not null,               -- e.g. W1, A-101
  window_type_id uuid references window_types(id),
  label text,                               -- location text: "Living room north"
  page_number int not null default 1 check (page_number >= 1),
  pin_x numeric check (pin_x >= 0 and pin_x <= 1),
  pin_y numeric check (pin_y >= 0 and pin_y <= 1),
  assigned_window_id uuid references windows(id) on delete set null,
  status text not null default 'planned'
    check (status in ('planned','assigned','installed')),
  -- Extraction writes confirmed=false drafts; humans confirm. A re-extract may
  -- only replace unconfirmed drafts — never confirmed rows.
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (project_id, opening_code)
);

-- One row per completed install: the structured memo the AI brain learns from.
-- Topic columns match vault/_schemas/install-memo-topics.md.
create table install_events (
  id uuid primary key default gen_random_uuid(),
  project_opening_id uuid not null references project_openings(id) on delete cascade,
  window_id uuid references windows(id) on delete set null,
  window_type_id uuid references window_types(id),
  installer text,
  started_at timestamptz,
  minutes int check (minutes >= 0),
  quality_grade int check (quality_grade between 1 and 5),
  difficulty text,
  went_well text,
  went_poorly text,
  obstacles text,
  tools_helped text,
  time_vs_estimate text,
  safety_notes text,
  do_again text,
  transcript_raw text,
  created_at timestamptz not null default now()
);

-- Attachments can now hang off an install event (photos/voice taken at the
-- opening even before a unit is linked).
alter table attachments
  add column install_event_id uuid references install_events(id) on delete cascade;
alter table attachments alter column window_id drop not null;
alter table attachments
  add constraint attachments_target
  check (window_id is not null or install_event_id is not null);

create index project_plansets_project_idx on project_plansets(project_id, created_at desc);
create index project_openings_project_idx on project_openings(project_id);
create index project_openings_window_idx on project_openings(assigned_window_id);
create index install_events_opening_idx on install_events(project_opening_id);
create index install_events_type_idx on install_events(window_type_id, created_at desc);
create index attachments_event_idx on attachments(install_event_id);

-- Storage buckets for planset documents and on-site media.
insert into storage.buckets (id, name, public)
values ('plansets', 'plansets', false), ('install-media', 'install-media', false)
on conflict (id) do nothing;

create policy "authenticated install buckets"
  on storage.objects for all to authenticated
  using (bucket_id in ('plansets','install-media'))
  with check (bucket_id in ('plansets','install-media'));

-- RLS: same trusted-crew pattern as the inventory tables.
alter table project_plansets enable row level security;
alter table project_openings enable row level security;
alter table install_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['project_plansets','project_openings','install_events']
  loop
    execute format('create policy "authenticated full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end;
$$;

-- Link a physical inventory unit to an opening. Validates the unit's type
-- matches the opening's expected type (when the opening has one).
create or replace function assign_window_to_opening(
  p_opening_id uuid,
  p_window_id uuid,
  p_actor text default null
)
returns project_openings
language plpgsql
as $$
declare
  v_opening project_openings;
  v_window windows;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  if v_opening.status = 'installed' then
    raise exception 'opening % is already installed', v_opening.opening_code;
  end if;

  select * into v_window from windows where id = p_window_id;
  if v_window is null then
    raise exception 'unknown window %', p_window_id;
  end if;
  if v_opening.window_type_id is not null
     and v_window.window_type_id <> v_opening.window_type_id then
    raise exception 'type mismatch: % is not the type planned for opening %',
      v_window.window_id, v_opening.opening_code;
  end if;

  update project_openings
  set assigned_window_id = v_window.id,
      window_type_id = coalesce(window_type_id, v_window.window_type_id),
      status = 'assigned'
  where id = p_opening_id
  returning * into v_opening;

  return v_opening;
end;
$$;

-- Record a completed install: write the event, mark the opening installed,
-- and (when an inventory unit is linked) run the existing install_window RPC
-- so warehouse status and the movements log stay in sync.
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
  p_started_at timestamptz default null
)
returns install_events
language plpgsql
as $$
declare
  v_opening project_openings;
  v_event install_events;
begin
  select * into v_opening from project_openings where id = p_opening_id;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;

  insert into install_events (
    project_opening_id, window_id, window_type_id, installer, started_at,
    minutes, quality_grade, difficulty, went_well, went_poorly, obstacles,
    tools_helped, time_vs_estimate, safety_notes, do_again, transcript_raw
  ) values (
    v_opening.id, v_opening.assigned_window_id, v_opening.window_type_id,
    p_installer, p_started_at, p_minutes, p_quality_grade, p_difficulty,
    p_went_well, p_went_poorly, p_obstacles, p_tools_helped,
    p_time_vs_estimate, p_safety_notes, p_do_again, p_transcript_raw
  )
  returning * into v_event;

  update project_openings
  set status = 'installed', confirmed = true
  where id = v_opening.id;

  if v_opening.assigned_window_id is not null then
    perform install_window(v_opening.assigned_window_id, p_installer);
  end if;

  return v_event;
end;
$$;
