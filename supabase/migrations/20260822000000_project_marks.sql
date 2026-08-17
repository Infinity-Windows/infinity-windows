-- Marks get a home (warehouse ticket 01 — docs/warehouse-tickets.md, ADR-0004).
--
-- A mark ("window 16 on BLACK22") had no row of its own: four tables carried
-- `mark_code` as bare text, so nothing could be checked and a typo was a new
-- mark forever. This migration gives marks a table and points `package_marks`
-- at it with a real foreign key — the link the whole warehouse effort builds
-- on ("where is #16's glass" is a join, not a string match).
--
-- Scope is deliberately package-side only. `project_mark_specs`,
-- `project_mark_elevation_views` and `project_spec_discrepancies` keep their
-- natural (project_id, mark_code) keys: converging them is churn with no
-- user-facing payoff today. Recorded as an accepted gap in ADR-0004.
--
-- Additive + idempotent like every migration here: safe to run on live data,
-- safe to run twice. The app reads both shapes until this is applied.

-- ---------------------------------------------------------------- table

create table if not exists project_marks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  -- Base mark without instance suffix ("16", "13A") — same normalization the
  -- spec extractor applies: trimmed, uppercased, no leading '#'.
  mark_code text not null,
  created_at timestamptz not null default now(),
  unique (project_id, mark_code)
);

-- ------------------------------------------------------- sync from specs

-- The tagging UI offers marks from project_mark_specs (the job schedule), so
-- that table is what project_marks mirrors. A trigger keeps the mirror live:
-- when the extractor lands a new spec row, its mark exists here before anyone
-- can try to tag against it. Marks are never auto-deleted — package history
-- may point at them, and a mark leaving the schedule doesn't unmake the
-- packages that were tagged under it.
create or replace function sync_project_mark()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into project_marks (project_id, mark_code)
  values (new.project_id, upper(trim(new.mark_code)))
  on conflict (project_id, mark_code) do nothing;
  return new;
end;
$$;

drop trigger if exists project_mark_specs_sync_mark on project_mark_specs;
create trigger project_mark_specs_sync_mark
  after insert or update of mark_code on project_mark_specs
  for each row execute function sync_project_mark();

-- ---------------------------------------------------------------- seed

-- Canonical source first: every mark the schedule knows.
insert into project_marks (project_id, mark_code)
select distinct project_id, upper(trim(mark_code))
from project_mark_specs
where trim(mark_code) <> ''
on conflict (project_id, mark_code) do nothing;

-- Then history: marks that packages were tagged with before this migration,
-- even where the schedule never listed them (or the spec row is gone). They
-- are real records; the foreign key below has to have somewhere to point.
insert into project_marks (project_id, mark_code)
select distinct p.project_id, upper(trim(pm.mark_code))
from package_marks pm
join packages p on p.id = pm.package_id
where p.project_id is not null and trim(pm.mark_code) <> ''
on conflict (project_id, mark_code) do nothing;

-- -------------------------------------- package_marks: text -> foreign key

-- Restrict, not cascade: deleting a mark someone tagged packages under should
-- fail loudly, not silently strip the tags off crates in the yard.
alter table package_marks
  add column if not exists mark_id uuid references project_marks (id) on delete restrict;

do $$
declare
  orphans int;
begin
  -- Only convert once: mark_code's presence means the old shape is live.
  if exists (
    select 1 from information_schema.columns
    where table_name = 'package_marks' and column_name = 'mark_code'
  ) then
    update package_marks pm
    set mark_id = m.id
    from packages p, project_marks m
    where pm.package_id = p.id
      and m.project_id = p.project_id
      and m.mark_code = upper(trim(pm.mark_code))
      and pm.mark_id is null;

    -- A mark row whose package lost its project (projects delete sets
    -- packages.project_id null) has no project to hang a mark on: the mark
    -- meant "window 16 OF THAT JOB", and the job is gone. The package itself
    -- and its events survive untouched; only the dangling mark label goes.
    select count(*) into orphans from package_marks where mark_id is null;
    if orphans > 0 then
      raise notice 'project_marks: dropping % package mark label(s) whose job was deleted', orphans;
      delete from package_marks where mark_id is null;
    end if;

    alter table package_marks alter column mark_id set not null;
    alter table package_marks drop constraint if exists package_marks_pkey;
    alter table package_marks add primary key (package_id, mark_id);
    alter table package_marks drop column mark_code;
  end if;
end;
$$;

-- "Which packages carry window 16?" — the join this whole ticket exists for.
create index if not exists package_marks_mark_idx on package_marks (mark_id);

-- ---------------------------------------------------------------- RLS

alter table project_marks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_marks' and policyname = 'crew read'
  ) then
    create policy "crew read" on project_marks
      for select to authenticated using (true);
  end if;
  -- No direct-write policies: rows arrive via the spec-sync trigger and the
  -- seeds above, both definer paths — same rule as every storage table.
end;
$$;

-- ---------------------------------------------------------------- RPC

-- bind_package now refuses a mark the job's schedule doesn't know. The tag
-- screen only offers real marks, so a rejection here means a stale client or
-- a hand-made call — exactly the writes that used to mint typo-marks.
-- Everything else (bind-once, delivery grouping, the event row) is unchanged.
create or replace function bind_package(
  p_package uuid,
  p_project uuid,
  p_category text default null,
  p_note text default null,
  p_marks text[] default null,
  p_delivery uuid default null
)
returns packages
language plpgsql
security definer
as $$
declare
  v_row packages;
  v_mark uuid;
  m text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'every package binds to a job';
  end if;

  -- Resolve every mark BEFORE touching the package: a bad mark list leaves
  -- the sticker blank and reusable rather than half-bound.
  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    if v_mark is null then
      raise exception 'mark % is not on this job''s schedule', m;
    end if;
  end loop;

  update packages
  set status = 'received',
      project_id = p_project,
      category = p_category,
      note = nullif(trim(coalesce(p_note, '')), ''),
      delivery_id = p_delivery,
      bound_at = now(),
      bound_by = auth.uid()::text
  where id = p_package and status = 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is already assigned — a package ID never moves to another package';
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    insert into package_marks (package_id, mark_id)
    values (p_package, v_mark)
    on conflict do nothing;
  end loop;

  insert into package_events (package_id, event, project_id, actor)
  values (p_package, 'bound', p_project, auth.uid()::text);

  return v_row;
end;
$$;
