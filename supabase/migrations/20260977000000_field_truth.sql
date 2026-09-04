-- FIELD TRUTH: "data off" with a reason, and a missed unit added from the site.
--
-- Transcripts program, wave E (owner grill 2026-09-03, Q12 + Q18). Two things
-- the crew has been telling each other on the phone instead of telling the app:
--
--   1. "the data is off on this one" — the window is in, but the paperwork was
--      wrong: wrong size, mirrored, not as drawn. Today the only way to say it
--      is a free-text flag nobody counts, so the bad numbers quietly become
--      estimating evidence. This gives the flag a REASON code, leaves the note
--      alone, and never blocks Finish — "done, data off" is the normal case.
--   2. "there's a window here that isn't on the plans" — the crew finds a unit
--      the paperwork never had. add_field_unit lets whoever is standing there
--      add it, with a photo and (when there is a map) a pin, and rings the
--      leads. Presence on the job is the permission, not rank: the person who
--      can see the hole is the person who should be able to record it.
--
-- Every existing caller of flag_opening keeps working: the two-argument form
-- stays, and a note with no kind reads as 'other', which is also what every
-- free-text flag already on the database is backfilled to.

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------

alter table project_openings
  add column if not exists flag_kind text,
  -- Born in the field rather than read off a planset. The one flag that makes
  -- a row immune to every re-extraction sweep (#476): the extractor may drop
  -- its own guesses, never a person's. Separate from flag_kind on purpose —
  -- a supervisor clearing the data-off flag must not make the row deletable.
  add column if not exists field_added boolean not null default false,
  -- WHICH missed unit this was on this job, kept apart from the name it wears.
  -- The number used to be read back out of opening_code ("Missed 3" → 3), which
  -- made it depend on a field a supervisor is invited to change: rename
  -- "Missed 1" to "W-14" and the 1 is free again, so the next unit added is
  -- "Missed 1" a second time and inherits the first one's spec row — the width
  -- and height somebody orders glass from. A number nothing renames cannot be
  -- handed out twice.
  add column if not exists field_unit_seq int;

alter table project_openings drop constraint if exists project_openings_flag_kind_check;
alter table project_openings add constraint project_openings_flag_kind_check
  check (
    flag_kind is null
    or flag_kind in ('wrong_size', 'mirrored', 'not_as_drawn', 'not_on_plans', 'other')
  );

comment on column project_openings.flag_kind is
  'Why this unit''s record is wrong: wrong_size | mirrored | not_as_drawn | not_on_plans | other. Null means no flag. Free-text flags raised before wave E read as ''other''.';
comment on column project_openings.field_added is
  'True when a person on site added this window or door with add_field_unit. Re-extraction never deletes one.';
comment on column project_openings.field_unit_seq is
  'The N this row was issued as "Missed N". Survives renaming and removal so a number is never handed out twice on a job.';

-- Idempotent backfill, for a database where an earlier cut of this migration
-- already issued codes: read the number back off the name while the name is
-- still the only place it lives.
update project_openings
   set field_unit_seq = (regexp_match(opening_code, '^Missed ([0-9]+)$'))[1]::int
 where field_added
   and field_unit_seq is null
   and opening_code ~ '^Missed [0-9]+$';

-- Every flag already on the database was typed as free text, so the only
-- honest reason for it is "other" — nobody was ever asked which kind it was.
update project_openings
   set flag_kind = 'other'
 where flag_note is not null and flag_kind is null;

create index if not exists project_openings_flagged_idx
  on project_openings (project_id) where flag_kind is not null;

-- The photo of a missed unit hangs off the OPENING, the same way a package
-- photo hangs off its package (20260936000000). attachments_target has to
-- learn the new target or the insert fails the check the moment it is written.
alter table attachments add column if not exists project_opening_id uuid
  references project_openings(id) on delete cascade;
create index if not exists attachments_opening_idx on attachments (project_opening_id);

alter table attachments drop constraint if exists attachments_target;
alter table attachments add constraint attachments_target
  check (
    window_id is not null
    or install_event_id is not null
    or package_id is not null
    or project_opening_id is not null
  );

-- A field-added mark spec records where it came from. 'field' joins the three
-- provenances the extractor and its reviewers already use.
alter table project_mark_specs drop constraint if exists project_mark_specs_source_check;
alter table project_mark_specs add constraint project_mark_specs_source_check
  check (source in ('ai', 'manual', 'deterministic', 'field'));

-- ---------------------------------------------------------------------------
-- 2. flag_opening, with a reason
-- ---------------------------------------------------------------------------
--
-- TWO FUNCTIONS, NOT ONE WITH A DEFAULT. PostgREST picks an overload by the
-- SET OF ARGUMENT NAMES in the request body, and a parameter carrying a
-- default is still a candidate — so `flag_opening(uuid, text, text default
-- null)` alongside the old two-argument form would make every existing
-- {p_opening_id, p_note} call ambiguous and fail. Two exact arities can never
-- be ambiguous, so the old callers keep working untouched and the new one
-- names its kind.

-- NOT security definer, deliberately: the function it replaces was not either,
-- and it has no reason to bypass RLS — an installer may already update the
-- openings they can see. Definer here would additionally let a caller flag (and
-- read back) a REMOVED opening, which is a row nobody is supposed to see.
create or replace function flag_opening(
  p_opening_id uuid,
  p_note text,
  p_kind text
)
returns project_openings
language plpgsql
set search_path = public
as $$
declare
  v_opening project_openings;
  v_clean text;
  v_kind text;
begin
  v_clean := nullif(trim(coalesce(p_note, '')), '');
  v_kind := nullif(trim(coalesce(p_kind, '')), '');

  if v_kind is not null
     and v_kind not in ('wrong_size', 'mirrored', 'not_as_drawn', 'not_on_plans', 'other') then
    raise exception 'Pick one of the listed reasons for the data being off.'
      using errcode = '22023';
  end if;

  -- A note with no kind is the old two-argument call's meaning: something is
  -- wrong and nobody was asked to say which kind. A kind with no note is fine
  -- — the reason IS the message.
  if v_clean is null and v_kind is null then
    -- THE RANK LIVES HERE, not only in clear_opening_flag. Both arities and
    -- both call paths end up in this branch, and the two-argument form is
    -- granted to every signed-in account and cannot be revoked without
    -- breaking the callers it exists for — so a check that sat only in
    -- clear_opening_flag was one `flag_opening(id, null)` away from being no
    -- check at all. Only asked when there is something to take down: clearing
    -- nothing is not a claim about anything.
    if not public.is_foreman_plus(auth.uid())
       and exists (
         select 1 from project_openings
          where id = p_opening_id
            and (flag_kind is not null or flag_note is not null)
       ) then
      raise exception 'Only a foreman or above can clear a data-off flag.'
        using errcode = '42501';
    end if;

    update project_openings
       set flag_kind = null, flag_note = null, flagged_by = null, flagged_at = null
     where id = p_opening_id
     returning * into v_opening;
  else
    update project_openings
       set flag_kind = coalesce(v_kind, 'other'),
           flag_note = v_clean,
           flagged_by = auth.uid(),
           flagged_at = now()
     where id = p_opening_id
     returning * into v_opening;
  end if;

  if v_opening is null then
    raise exception 'That window or door is not on this job.' using errcode = 'P0002';
  end if;

  if v_opening.flag_kind is null then
    update issues
       set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
     where opening_id = p_opening_id and kind = 'flag' and status = 'open';
  elsif not exists (
    select 1 from issues
     where opening_id = p_opening_id and kind = 'flag' and status = 'open'
  ) then
    -- The NOTE is only ever what a person typed. It used to fall back to the
    -- reason code, so a flag raised with a reason and no note filed an issue
    -- whose note read `wrong_size` — a column value from this database printed
    -- to a foreman on a phone, which is the thing plain-English copy exists to
    -- stop. The reason is already on the opening; Blockers and the Issues page
    -- read it from there and say it in the reader's own language.
    insert into issues (project_id, opening_id, kind, urgency, note, created_by)
    values (v_opening.project_id, p_opening_id, 'flag', 'normal',
            v_clean, auth.uid());
  end if;

  return v_opening;
end;
$$;

-- The old two-argument form, rebuilt on top of the new one so there is exactly
-- one set of rules. Behaviour is unchanged: a note flags, an empty note clears.
create or replace function flag_opening(p_opening_id uuid, p_note text)
returns project_openings
language plpgsql
set search_path = public
as $$
begin
  return flag_opening(p_opening_id, p_note, null);
end;
$$;

-- Clearing is the foreman saying "the record is right again", which is why it
-- is the one half of this that carries a rank. An installer raises the flag;
-- somebody who can go and check takes it down. The named door for it, so the
-- app has something to call and something to hide behind a role — the rule
-- itself is enforced in flag_opening's clear branch, which every path reaches.
create or replace function clear_opening_flag(p_opening_id uuid)
returns project_openings
language plpgsql
set search_path = public
as $$
declare v_opening project_openings;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can clear a data-off flag.'
      using errcode = '42501';
  end if;
  return flag_opening(p_opening_id, null, null);
end;
$$;

revoke all on function flag_opening(uuid, text, text) from public, anon;
revoke all on function clear_opening_flag(uuid) from public, anon;
grant execute on function flag_opening(uuid, text, text) to authenticated, service_role;
grant execute on function clear_opening_flag(uuid) to authenticated, service_role;

-- And the same rule at the table, because the RPCs are not the only door.
-- `openings_update_live` (20260730210000) is `for update to authenticated
-- using (removed_at is null) with check (true)`, so a plain PATCH of
-- flag_kind/flag_note goes straight past every function above. Scoped exactly
-- like guard_opening_pin_move (20260730160000): an update that leaves the flag
-- columns alone — every claim, start, finish, measurement, condition check and
-- assignment — never reaches the body.
--
-- RAISING a flag stays anyone's right, which is the whole point of the feature.
-- Only taking one DOWN carries the rank, so this needs no escape hatch for the
-- RPCs: flag_opening's own clear branch is foreman+ now, and the trigger simply
-- agrees with it.
create or replace function public.guard_opening_flag_clear()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.flag_kind is not distinct from old.flag_kind
     and new.flag_note is not distinct from old.flag_note then
    return new;
  end if;

  -- No JWT is a migration or an edge function on the service key, both already
  -- trusted above RLS.
  if auth.uid() is null then
    return new;
  end if;

  -- Still flagged after this write: raising or re-wording one is anyone's.
  if new.flag_kind is not null or new.flag_note is not null then
    return new;
  end if;

  if (old.flag_kind is not null or old.flag_note is not null)
     and not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can clear a data-off flag.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_opening_flag_clear on project_openings;
create trigger guard_opening_flag_clear
  before update of flag_kind, flag_note on project_openings
  for each row execute function public.guard_opening_flag_clear();

comment on function public.guard_opening_flag_clear() is
  'Refuses taking a data-off flag down from anyone below foreman, whichever door they came through. Raising one is unrestricted.';

-- ---------------------------------------------------------------------------
-- 3. Adding a unit nobody drew
-- ---------------------------------------------------------------------------
--
-- guard_opening_create_delete (20260730180000) refuses an INSERT from anyone
-- below foreman, and it is right to: re-reading a planset must stay a lead's
-- action. Adding ONE window you are standing in front of is a different act
-- with a different check — an open shift on that job — so it gets the same
-- session-flag escape hatch the removal guard already uses.

create or replace function public.guard_opening_create_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  -- No JWT means this is not a person holding a phone: a migration, or an edge
  -- function on the service key. Both are already trusted above RLS.
  if auth.uid() is null then
    return v_row;
  end if;

  -- add_field_unit, which has already proved the caller is clocked in on this
  -- job. Wave E: presence is the permission for one missed window, and only
  -- for the insert that function makes inside its own transaction.
  if tg_op = 'INSERT'
     and coalesce(current_setting('app.field_unit_add', true), '') = 'on' then
    return v_row;
  end if;

  if not public.is_foreman_plus(auth.uid()) then
    if tg_op = 'DELETE' then
      raise exception 'Only a foreman or above can remove a window or door from a job.'
        using errcode = '42501';
    else
      raise exception 'Only a foreman or above can add windows or doors to a job.'
        using errcode = '42501';
    end if;
  end if;

  return v_row;
end;
$$;

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
    project_id, mark_code, style, width_in, height_in, source, confirmed
  ) values (
    p_project_id, v_code, v_style, p_width_in, p_height_in, 'field', false
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
-- 4. What a supervisor does with one
-- ---------------------------------------------------------------------------
-- Keep (rename allowed), Merge into an existing mark, Remove. Merge and Remove
-- are only offered while the unit carries no work — once somebody has clocked
-- time or filed an install on it, the row is evidence and the answer is Keep.

-- SPECS ARE KEYED BY MARK BASE, NOT BY OPENING CODE. `specForOpeningCode`
-- (app/src/lib/install/specs.ts) looks a unit's spec up as
-- markBase(opening_code).toUpperCase(), and markBase strips the instance
-- suffix: "1-3" is an instance of mark "1", while "Add-1" and "W-14" are marks
-- in their own right because a run of LETTERS before the dash is the mark's own
-- identity (the Mad Moose incident, 2026-09-01 — see markBase's comment).
--
-- Renaming a missed unit has to move its spec to the key the app will actually
-- read it back by, so this mirrors markBase exactly, case for case. Both sides
-- of every comparison below are upper()ed, which is what indexSpecsByMark does
-- too, so stored casing never decides whether a spec is found.
create or replace function public.mark_base(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    -- Letters-then-dash-then-digits is one whole mark, title-cased so the same
    -- mark always writes the same literal into project_mark_specs.mark_code.
    when v.trimmed ~ '^[A-Za-z]+-[0-9]+$'
      then upper(left(split_part(v.trimmed, '-', 1), 1))
           || lower(substr(split_part(v.trimmed, '-', 1), 2))
           || '-' || split_part(v.trimmed, '-', 2)
    -- Otherwise a trailing "-<digits>" is the instance number. Falling back to
    -- the whole code when stripping leaves nothing matches the TS `|| n`.
    else coalesce(
      nullif(regexp_replace(upper(v.trimmed), '-[0-9]+$', ''), ''),
      upper(v.trimmed)
    )
  end
  from (
    -- trim(), then strip a leading '#', and nothing else — exactly what the TS
    -- does, so the two never disagree on an odd code.
    select regexp_replace(btrim(coalesce(p_code, '')), '^#', '') as trimmed
  ) v;
$$;

comment on function public.mark_base(text) is
  'Mark code behind an opening code (1-3 -> 1, Add-1 -> Add-1). Mirrors markBase in app/src/lib/install/extract.ts; change them together.';

revoke all on function public.mark_base(text) from public, anon;
grant execute on function public.mark_base(text) to authenticated, service_role;

create or replace function public.field_unit_has_work(p_opening_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from unit_sessions where opening_id = p_opening_id)
      or exists (select 1 from install_events
                  where project_opening_id = p_opening_id and voided_at is null);
$$;

create or replace function rename_field_unit(p_opening_id uuid, p_code text)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_old text;
  v_spec_id uuid;
  v_new_mark text;
  v_code text := nullif(trim(coalesce(p_code, '')), '');
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can rename a missed window or door.'
      using errcode = '42501';
  end if;
  if v_code is null then
    raise exception 'Give the window or door a name before saving it.' using errcode = '22023';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found or not v_row.field_added then
    raise exception 'That is not a missed window or door added from the field.'
      using errcode = 'P0002';
  end if;
  v_old := v_row.opening_code;
  if exists (
    select 1 from project_openings
     where project_id = v_row.project_id and opening_code = v_code
       and removed_at is null and id <> p_opening_id
  ) then
    raise exception 'There is already a % on this job. Pick a different name.', v_code
      using errcode = '23505';
  end if;

  update project_openings set opening_code = v_code
   where id = p_opening_id
   returning * into v_row;

  -- The spec row carries the size somebody measured, so it has to end up under
  -- the key the sheet will read it back by — mark_base of the new name, not the
  -- new name. Rename to "1-3" and the sheet looks up mark "1"; a spec left at
  -- "1-3" is a row nothing ever reads, and the measurement is gone from the
  -- screen that orders the glass.
  --
  -- It is found BY ID and only when it is ours (source 'field'), so a rename
  -- can never pick up and move a spec the planset put there.
  v_new_mark := public.mark_base(v_code);
  select id into v_spec_id
    from project_mark_specs
   where project_id = v_row.project_id
     and upper(mark_code) = upper(public.mark_base(v_old))
     and source = 'field'
   limit 1;

  if v_spec_id is not null then
    if exists (
      select 1 from project_mark_specs
       where project_id = v_row.project_id
         and upper(mark_code) = upper(v_new_mark)
         and id <> v_spec_id
    ) then
      -- The paperwork caught up and that row is the better one. DELETE rather
      -- than leave ours behind: an orphan sitting at the freed "Missed N" code
      -- is what the next missed unit on this job would silently inherit its
      -- width and height from.
      delete from project_mark_specs where id = v_spec_id;
    else
      update project_mark_specs
         set mark_code = v_new_mark, updated_at = now()
       where id = v_spec_id;
    end if;
  end if;
  return v_row;
end;
$$;

create or replace function merge_field_unit(p_opening_id uuid, p_into_code text)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
  v_target project_openings;
  v_code text := nullif(trim(coalesce(p_into_code, '')), '');
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can merge a missed window or door.'
      using errcode = '42501';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found or not v_row.field_added then
    raise exception 'That is not a missed window or door added from the field.'
      using errcode = 'P0002';
  end if;
  if public.field_unit_has_work(p_opening_id) then
    raise exception 'Somebody has already worked this one, so it cannot be merged away. Keep it and rename it instead.'
      using errcode = '42501';
  end if;

  -- A missed unit that has been renamed answers to a real code of its own, so
  -- "merge into <that code>" would otherwise find ITSELF: attachments repointed
  -- to the same row, a job note reading "W-14 turned out to be W-14", and then
  -- the row and its spec deleted. The list on the sheet never offers it; the
  -- refusal belongs in SQL like every other refusal in this file, because the
  -- RPC is granted to every signed-in account.
  if v_code = v_row.opening_code then
    raise exception 'That is the name this one already has — rename it instead.'
      using errcode = '22023';
  end if;

  select * into v_target from project_openings
   where project_id = v_row.project_id and opening_code = v_code
     and removed_at is null and id <> p_opening_id
   limit 1;
  if not found then
    raise exception 'There is no % on this job to merge it into.', v_code using errcode = 'P0002';
  end if;

  -- The photo is the evidence, so it follows the unit it was really about.
  update attachments set project_opening_id = v_target.id
   where project_opening_id = p_opening_id;

  update issues
     set status = 'resolved', resolved_by = auth.uid(), resolved_at = now()
   where opening_id = p_opening_id and status = 'open';

  insert into job_notes (project_id, author_id, author_name, note)
  select v_row.project_id, auth.uid(),
         (select display_name from profiles where id = auth.uid()),
         v_row.opening_code || ' turned out to be ' || v_target.opening_code || ' — merged.';

  -- ONLY THE ROW THIS FEATURE CREATED. A merge used to delete any spec whose
  -- mark_code matched the unit's current code — and after a rename that code is
  -- a REAL mark, whose spec is the manufacturer's: style, glass, size code,
  -- u-factor, the drawing coordinates, possibly confirmed by a foreman, and
  -- read by every other opening of that mark. project_mark_specs has no soft
  -- delete, so it would simply be gone. Three fences: it must be ours
  -- (source 'field'), nobody may have confirmed it, and no other live opening
  -- may still resolve to that mark.
  delete from project_mark_specs s
   where s.project_id = v_row.project_id
     and upper(s.mark_code) = upper(public.mark_base(v_row.opening_code))
     and s.source = 'field'
     and coalesce(s.confirmed, false) = false
     and not exists (
       select 1 from project_openings o
        where o.project_id = v_row.project_id
          and o.id <> p_opening_id
          and o.removed_at is null
          and upper(public.mark_base(o.opening_code))
              = upper(public.mark_base(v_row.opening_code))
     );
  delete from project_openings where id = p_opening_id;

  return v_target;
end;
$$;

create or replace function remove_field_unit(p_opening_id uuid, p_reason text default null)
returns project_openings
language plpgsql
security definer
set search_path = public
as $$
declare v_row project_openings;
begin
  if public.my_role_rank() < 2 then
    raise exception 'Only a supervisor or above can take a missed window or door back off.'
      using errcode = '42501';
  end if;

  select * into v_row from project_openings where id = p_opening_id;
  if not found or not v_row.field_added then
    raise exception 'That is not a missed window or door added from the field.'
      using errcode = 'P0002';
  end if;
  if public.field_unit_has_work(p_opening_id) then
    raise exception 'Somebody has already worked this one, so it stays on the job. Keep it and rename it instead.'
      using errcode = '42501';
  end if;

  -- The ordinary soft delete: hidden, never destroyed, and restorable from the
  -- removed list like any other window a foreman takes off.
  return public.remove_opening(p_opening_id, coalesce(p_reason, 'Missed unit withdrawn'));
end;
$$;

revoke all on function public.field_unit_has_work(uuid) from public, anon;
revoke all on function rename_field_unit(uuid, text) from public, anon;
revoke all on function merge_field_unit(uuid, text) from public, anon;
revoke all on function remove_field_unit(uuid, text) from public, anon;
grant execute on function public.field_unit_has_work(uuid) to authenticated, service_role;
grant execute on function rename_field_unit(uuid, text) to authenticated, service_role;
grant execute on function merge_field_unit(uuid, text) to authenticated, service_role;
grant execute on function remove_field_unit(uuid, text) to authenticated, service_role;

-- The test-login cage covers every project-scoped table; re-arming is
-- idempotent and costs nothing, and this migration touches two of them.
select public.attach_sandbox_guards();
