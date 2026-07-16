-- Installer-first: let the field escalate problems to the lead.
-- An opening can be flagged (with a reason) and a job can carry general notes.

alter table project_openings
  add column if not exists flag_note text,
  add column if not exists flagged_by uuid references profiles(id) on delete set null,
  add column if not exists flagged_at timestamptz;

create table if not exists job_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  author_name text,
  note text not null,
  created_at timestamptz not null default now()
);

alter table job_notes enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='job_notes' and policyname='authenticated full access') then
    create policy "authenticated full access" on job_notes
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;

create index if not exists job_notes_project_idx on job_notes (project_id, created_at desc);

-- Flag (or clear) an opening for the lead. Null note clears the flag.
create or replace function flag_opening(p_opening_id uuid, p_note text)
returns project_openings
language plpgsql
as $$
declare v_opening project_openings;
begin
  update project_openings
  set flag_note = nullif(trim(coalesce(p_note, '')), ''),
      flagged_by = case when nullif(trim(coalesce(p_note, '')), '') is null then null else auth.uid() end,
      flagged_at = case when nullif(trim(coalesce(p_note, '')), '') is null then null else now() end
  where id = p_opening_id
  returning * into v_opening;
  if v_opening is null then
    raise exception 'unknown opening %', p_opening_id;
  end if;
  return v_opening;
end;
$$;

-- Post a general, opening-independent job note (site conditions, etc.).
create or replace function add_job_note(p_project_id uuid, p_note text)
returns job_notes
language plpgsql
as $$
declare v_note job_notes; v_name text;
begin
  select display_name into v_name from profiles where id = auth.uid();
  insert into job_notes (project_id, author_id, author_name, note)
  values (p_project_id, auth.uid(), v_name, p_note)
  returning * into v_note;
  return v_note;
end;
$$;

-- Openings already stream via realtime; add job_notes too for the lead board.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'job_notes'
  ) then
    alter publication supabase_realtime add table job_notes;
  end if;
end;
$$;
