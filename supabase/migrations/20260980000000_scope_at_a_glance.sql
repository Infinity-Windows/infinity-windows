-- Scope at a glance, wave X of the transcripts program.
--
-- The question this answers is the one an office asks before opening a job:
-- how big is it, and how much of it is doors? Until now a job card could only
-- say "40 openings / 32 done", and it said that by pulling EVERY opening row
-- for EVERY job down to the phone and counting them in JavaScript.
--
-- Three things here, in the order they depend on each other:
--
--   1. project_mark_specs.unit_kind / .door_kind — the answer, STORED, written
--      by the one TypeScript classifier (app/src/lib/install/specKinds.mjs) at
--      every path that writes a spec. Stored rather than derived at read time
--      because a grouped count is what makes the card cheap, and because the
--      classifier's answer is worth being able to correct: a foreman edits the
--      spec text, the kind follows.
--
--   2. add_field_unit fills them in too. It is the one specs writer that lives
--      in SQL (wave E, 20260977000000), so it cannot call the classifier — it
--      already knows the answer from p_kind, and a field-added door is 'other'
--      until somebody says which kind it is.
--
--   3. project_scope_counts — one row per job, counted in the database and
--      read through the caller's own RLS, so a job a person cannot see cannot
--      appear in their counts either. Tolerates null kinds ("unknown"), which
--      is what every row is until the backfill runs.
--
-- Plus projects.stories, the number nothing else in the app knows: a traced 3D
-- model can say how many storeys a building has, but most jobs have no model,
-- and "two storeys" changes what a bid and a crew look like.
--
-- IDEMPOTENT throughout: every object is if-not-exists or or-replace, and the
-- check constraints are dropped before they are added. Safe to run twice.
-- MERGE ORDER: after 20260979000000. Numbers must land in order, one deploy at
-- a time.

-- ---------------------------------------------------------------------------
-- 1. What kind of unit is this mark?
-- ---------------------------------------------------------------------------
--
-- WHO MAY WRITE THESE: nobody new. project_mark_specs carries a TABLE-level
-- `grant insert, update, delete ... to authenticated` (20260724000000) rather
-- than a column list, so a new column is writable by exactly the people who
-- could already write the row — and RLS still says that is foreman+
-- (mark_specs_insert_foreman / _update_foreman). That is deliberately unlike
-- `projects`, whose writes ARE a column list (see part 4 below).

alter table project_mark_specs
  add column if not exists unit_kind text,
  add column if not exists door_kind text;

alter table project_mark_specs drop constraint if exists project_mark_specs_unit_kind_check;
alter table project_mark_specs add constraint project_mark_specs_unit_kind_check
  check (unit_kind is null or unit_kind in ('window', 'door'));

-- A door kind only means something on a door. Null-when-not-a-door is the
-- same rule specKindColumns applies in the app; stating it here as well means a
-- future writer that forgets is refused rather than quietly counted.
alter table project_mark_specs drop constraint if exists project_mark_specs_door_kind_check;
alter table project_mark_specs add constraint project_mark_specs_door_kind_check
  check (
    door_kind is null
    or (unit_kind = 'door'
        and door_kind in ('slider', 'french', 'bifold', 'swing', 'other'))
  );

comment on column project_mark_specs.unit_kind is
  'window | door | null, written by doorKind''s module (app/src/lib/install/specKinds.mjs) at every specs write path. Null means the paperwork does not say - project_scope_counts keeps those in their own bucket rather than guessing.';
comment on column project_mark_specs.door_kind is
  'slider | french | bifold | swing | other, null for anything that is not a door. Vocabulary: docs/window-vendor-conventions.md, "Door kinds". Change the classifier and the backfill (scripts/seed-spec-kinds.mjs) must be re-run.';

-- Counting doors on one job is a per-project read; the existing
-- project_mark_specs_project_idx already serves it.

-- ---------------------------------------------------------------------------
-- 2. The one specs writer that lives in SQL
-- ---------------------------------------------------------------------------
--
-- add_field_unit (wave E, 20260977000000) inserts the spec row for a window or
-- door somebody found on site. Replaced here ONLY to carry the two new columns:
-- everything else below is that migration's function, word for word, because a
-- create-or-replace has to restate the whole body and a paraphrase would be a
-- silent behaviour change.
--
-- It does not need the classifier: p_kind is the answer, typed by the person
-- standing in front of the hole. A field-added door is 'other' — nobody has
-- been asked which kind, and 'other' is what the app writes whenever the
-- paperwork does not say.

create or replace function add_field_unit(
  p_project_id uuid,
  p_kind text,
  p_width_in numeric,
  p_height_in numeric,
  p_photo_path text,
  p_pin_x numeric,
  p_pin_y numeric,
  p_note text,
  -- Not in the wave's written signature, and needed: a pin is only meaningful
  -- against the sheet it was tapped on, and a job's map has pages. Trailing
  -- and defaulted so the eight-argument call in the spec still works.
  p_page_number int default null
)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_next int;
  v_code text;
  v_style text;
  v_name text;
begin
  if p_kind not in ('window', 'door') then
    raise exception 'Say whether this is a window or a door.' using errcode = '22023';
  end if;

  -- PRESENCE, NOT RANK (wave E): whoever is on the clock on this job can
  -- record a window nobody drew. Anything less and the person looking at the
  -- hole has to phone someone to write it down, which is how it goes unwritten.
  if not exists (
    select 1 from time_shifts
     where profile_id = auth.uid()
       and project_id = p_project_id
       and status = 'open'
       and clock_out_at is null
  ) then
    raise exception 'Clock in on this job before you add a missed window or door.'
      using errcode = '42501';
  end if;

  -- "Missed 1", "Missed 2", … per job. Read off field_unit_seq and not off the
  -- CODE, because the code is renameable and the number must not be: a job
  -- where "Missed 1" has been renamed to "W-14", or removed, must still call
  -- the next one "Missed 2". Every row on the job counts, hidden ones included.
  --
  -- The advisory lock is per project and lasts the transaction: two people
  -- standing in the same house adding a unit in the same second would otherwise
  -- both read the same max and one of them would meet a raw duplicate-key error
  -- from project_openings_live_code_key instead of getting their window
  -- recorded.
  perform pg_advisory_xact_lock(hashtext('field_unit:' || p_project_id::text));
  select coalesce(max(field_unit_seq), 0) + 1
    into v_next
    from project_openings
   where project_id = p_project_id;
  v_code := 'Missed ' || v_next;

  v_style := case when p_kind = 'door'
                  then 'Missed door — field added'
                  else 'Missed window — field added' end;

  perform set_config('app.field_unit_add', 'on', true);
  insert into project_openings (
    project_id, opening_code, label, page_number, pin_x, pin_y,
    status, confirmed, flag_kind, flag_note, flagged_by, flagged_at,
    field_added, field_unit_seq
  ) values (
    p_project_id, v_code, v_style, coalesce(p_page_number, 1),
    p_pin_x, p_pin_y,
    'planned', true, 'not_on_plans',
    nullif(trim(coalesce(p_note, '')), ''), auth.uid(), now(), true, v_next
  )
  returning * into v_row;
  perform set_config('app.field_unit_add', 'off', true);

  -- The spec row is what makes it a real unit everywhere else: the sheet, the
  -- schedule list and the 3D map all read specs by mark code.
  insert into project_mark_specs (
    project_id, mark_code, style, width_in, height_in, source, confirmed,
    unit_kind, door_kind
  ) values (
    p_project_id, v_code, v_style, p_width_in, p_height_in, 'field', false,
    p_kind, case when p_kind = 'door' then 'other' end
  )
  -- AUTHORITATIVE FOR A FIELD ROW. `do nothing` meant a leftover spec under
  -- this code silently became the new unit's size — a second missed unit
  -- showing the first one's width and height, which is what a purchase order
  -- gets cut from. The numbering above should make a collision impossible now;
  -- if one happens anyway, the measurements somebody just took on site win. A
  -- row that is not ours, or that a foreman has confirmed, is never touched.
  on conflict (project_id, mark_code) do update
     set style = excluded.style,
         width_in = excluded.width_in,
         height_in = excluded.height_in,
         source = 'field',
         -- Wave X: the kind follows the style it was written with, or the two
         -- would disagree on a row that used to be a window and is now a door.
         unit_kind = excluded.unit_kind,
         door_kind = excluded.door_kind,
         updated_at = now()
   where project_mark_specs.source = 'field'
     and coalesce(project_mark_specs.confirmed, false) = false;

  if nullif(trim(coalesce(p_photo_path, '')), '') is not null then
    insert into attachments (project_id, project_opening_id, kind, storage_path, created_by)
    select p_project_id, v_row.id, 'photo', p_photo_path,
           (select display_name from profiles where id = auth.uid());
  end if;

  -- It lands on the Issues board like every other field problem, so it is
  -- chased rather than admired.
  select display_name into v_name from profiles where id = auth.uid();
  insert into issues (project_id, opening_id, kind, urgency, note, created_by)
  values (
    p_project_id, v_row.id, 'flag', 'normal',
    coalesce(nullif(trim(coalesce(p_note, '')), ''),
             v_style) || ' (added by ' || coalesce(v_name, 'the crew') || ')',
    auth.uid()
  );

  return v_row;
end;
$$;

revoke all on function add_field_unit(uuid, text, numeric, numeric, text, numeric, numeric, text, int) from public, anon;
grant execute on function add_field_unit(uuid, text, numeric, numeric, text, numeric, numeric, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. One row per job: how big is it, and how much of it is doors?
-- ---------------------------------------------------------------------------
--
-- SECURITY INVOKER, which is the whole point: the counts are computed from
-- `projects`, `project_openings` and `project_mark_specs` under the READER's
-- own row-level security. A trashed job, a testing job below supervisor, a job
-- a partner was never granted — none of them can appear here, because none of
-- their rows are visible to the query in the first place. A definer view would
-- have leaked the existence and size of every job on the company.
--
-- The join from an opening to its spec is markBase, exactly as the app does it
-- (specForOpeningCode): openings "1-1" and "1-2" are both instances of mark
-- "1", while "Add-1" is a mark of its own. public.mark_base is wave E's SQL
-- mirror of that function.
--
-- LATERAL rather than a plain join so one opening can only ever count once. A
-- job could hold two spec rows whose mark codes differ only in case ("Add-1"
-- and "ADD-1"): the unique index is on the literal string, but this join is
-- case-insensitive because indexSpecsByMark is. Confirmed beats draft, then
-- most recently touched — the same row the sheet would show.
--
-- `unknown_units` is not a bug, it is the honest bucket: a mark whose spec
-- nobody has read yet, or which predates the backfill. Openings always add up
-- (windows + doors + unknown = openings), which is what lets the card say "40
-- openings · 32 windows · 8 doors" without the numbers arguing.

drop view if exists project_scope_counts;

create view project_scope_counts
  with (security_invoker = true)
as
select
  p.id                                                              as project_id,
  count(o.id)                                                       as openings,
  count(o.id) filter (where o.status = 'installed')                 as installed,
  count(o.id) filter (where s.unit_kind = 'window')                 as windows,
  count(o.id) filter (where s.unit_kind = 'door')                   as doors,
  count(o.id) filter (where s.door_kind = 'slider')                 as door_sliders,
  count(o.id) filter (where s.door_kind = 'french')                 as door_french,
  count(o.id) filter (where s.door_kind = 'bifold')                 as door_bifold,
  count(o.id) filter (where s.door_kind = 'swing')                  as door_swing,
  count(o.id) filter (where s.door_kind = 'other')                  as door_other,
  count(o.id) filter (where s.unit_kind is null)                    as unknown_units
from projects p
left join project_openings o
  on o.project_id = p.id
left join lateral (
  select ms.unit_kind, ms.door_kind
    from project_mark_specs ms
   where ms.project_id = p.id
     and upper(ms.mark_code) = upper(public.mark_base(o.opening_code))
   order by ms.confirmed desc, ms.updated_at desc
   limit 1
) s on true
group by p.id;

comment on view project_scope_counts is
  'One row per job: openings, installed, windows, doors, and doors by kind. SECURITY INVOKER - counts are computed under the reader''s own RLS, so a hidden job cannot show up as a number. Retires the whole-table project_openings pull the job cards used to do.';

revoke all on project_scope_counts from public, anon;
grant select on project_scope_counts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. How many storeys is this building?
-- ---------------------------------------------------------------------------
--
-- Typed on the job form, and only ever typed: when a job has a traced 3D model
-- the app SHOWS that model's storey count instead (storiesOf), and never
-- writes it back here. Three writers already share an outline row's `features`
-- and a fourth, writing into a different table on their behalf, is exactly the
-- kind of loop that makes a number nobody can explain.
--
-- THE GRANT IS THE POINT (wave D's law, 20260959000000): table-level INSERT and
-- UPDATE on `projects` are revoked, and only app-written columns are granted
-- back by name. A column missing from those lists is a 42501 on the first PATCH
-- that names it. Granted here per-column and additively, so this never has to
-- restate — or accidentally shorten — the list another wave is extending.

alter table projects add column if not exists stories smallint;

alter table projects drop constraint if exists projects_stories_check;
alter table projects add constraint projects_stories_check
  check (stories is null or (stories >= 1 and stories <= 60));

comment on column projects.stories is
  'How many storeys the building has, typed by a human on the job form. Null means nobody said. A traced fit-view model beats it for display (storiesOf) and never writes back into it.';

grant insert (stories) on projects to authenticated;
grant update (stories) on projects to authenticated;
