-- Step-by-step undo for moved plan marks.
--
-- Dragging a numbered circle on the project map wrote straight to
-- project_openings.pin_x / pin_y — the SAME two columns the planset extraction
-- fills. Nothing anywhere recorded where the mark used to be, so an accidental
-- nudge was permanent and invisible. (Taylor moved door mark #37 on Black
-- Desert exactly this way; the repair at the bottom of this file puts it back.)
--
-- Two things fix that:
--
--   origin_pin_x / origin_pin_y / origin_page_number
--     Where the extraction put the mark. Seeded on insert and then immutable,
--     so "put it back where it came from" always has an answer — this is the
--     floor of the undo stack.
--
--   project_opening_pin_moves
--     One durable row per move: who moved it, when, from where, to where. It is
--     written by a TRIGGER rather than by the app, so every write path (the map
--     drag, the plan editor drag, anything written later) is captured and no
--     client can forget to record one. This is the undo stack, and because it
--     lives in the database it survives a reload, a new phone, and a dead zone.

-- --- 1. Where the extraction put each mark -------------------------------

alter table project_openings
  add column if not exists origin_pin_x numeric
    check (origin_pin_x is null or (origin_pin_x >= 0 and origin_pin_x <= 1)),
  add column if not exists origin_pin_y numeric
    check (origin_pin_y is null or (origin_pin_y >= 0 and origin_pin_y <= 1)),
  add column if not exists origin_page_number integer;

comment on column project_openings.origin_pin_x is
  'Normalized x the planset extraction placed this mark at. Write-once; the reset/undo target.';

-- --- 2. Repair Black Desert door #37, BEFORE anything is seeded ----------
--
-- Evidence: this row read (0.485199100308642, 0.7016958912037037) in every
-- backup taken on 2026-07-29 (1934Z, 1942Z, 2005Z, 2012Z, 2046Z) and has never
-- read anything else since it was created on 2026-07-28. It now reads
-- (0.502, 0.700) — three decimal places, which is the exact signature of the
-- map's drag handler (`Math.round(x * 1000) / 1000`). That is the accidental
-- move, and this is the value it was moved away from.
--
-- Guarded on the id AND the current value, so it is a no-op if the row has
-- since changed, if it is a different database, or if this file is replayed.
-- It runs here, before the backfill below, so the restored value is what gets
-- recorded as the mark's origin.
update project_openings
set pin_x = 0.485199100308642,
    pin_y = 0.7016958912037037
where id = 'b1a6266b-87a0-42fa-a56a-2f9de83793f1'
  and opening_code = '37'
  and round(pin_x::numeric, 3) = 0.502
  and round(pin_y::numeric, 3) = 0.700;

-- --- 3. Seed the origin for everything that already exists ---------------
--
-- Every other mark in production is still sitting exactly where extraction put
-- it (verified against the same backups), so the current pin IS the origin.
update project_openings
set origin_pin_x = pin_x,
    origin_pin_y = pin_y,
    origin_page_number = page_number
where origin_pin_x is null
  and pin_x is not null
  and pin_y is not null;

-- --- 4. Keep the origin honest from now on -------------------------------

create or replace function public.seed_opening_origin_pin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- A re-extract re-inserts rows and deliberately carries a manually placed
    -- pin across (see planDraftPersistence). When the caller supplies an
    -- origin, that is the freshly extracted position and it wins; otherwise
    -- the pin it was created at is the origin.
    if new.origin_pin_x is null and new.pin_x is not null then
      new.origin_pin_x := new.pin_x;
      new.origin_pin_y := new.pin_y;
    end if;
    if new.origin_page_number is null then
      new.origin_page_number := new.page_number;
    end if;
    return new;
  end if;

  -- Write-once. An ordinary update can fill a blank origin but can never
  -- rewrite one, so no amount of dragging can launder a nudge into "original".
  if old.origin_pin_x is not null then
    new.origin_pin_x := old.origin_pin_x;
    new.origin_pin_y := old.origin_pin_y;
  end if;
  if old.origin_page_number is not null then
    new.origin_page_number := old.origin_page_number;
  end if;
  return new;
end;
$$;

drop trigger if exists seed_opening_origin_pin on project_openings;
create trigger seed_opening_origin_pin
  before insert or update on project_openings
  for each row execute function public.seed_opening_origin_pin();

-- --- 5. The undo stack ---------------------------------------------------

create table if not exists project_opening_pin_moves (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  opening_id uuid not null references project_openings(id) on delete cascade,
  moved_by uuid references auth.users(id) on delete set null,
  moved_at timestamptz not null default now(),
  from_pin_x numeric not null,
  from_pin_y numeric not null,
  from_page_number integer,
  to_pin_x numeric not null,
  to_pin_y numeric not null,
  to_page_number integer,
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  note text
);

comment on table project_opening_pin_moves is
  'One row per plan-mark move. The durable undo stack behind the map''s Undo button.';

-- The stack is read newest-first for one job, and the undoable head is the
-- newest row with undone_at is null.
create index if not exists opening_pin_moves_project_idx
  on project_opening_pin_moves(project_id, moved_at desc);
create index if not exists opening_pin_moves_open_idx
  on project_opening_pin_moves(project_id, moved_at desc)
  where undone_at is null;

alter table project_opening_pin_moves enable row level security;

do $$
begin
  -- Everyone on the crew can SEE who moved what — attribution is the point.
  -- Nobody can write this table directly: the trigger and the undo functions
  -- below are security definer and owned by postgres, so the history cannot be
  -- forged or quietly deleted from a browser.
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_opening_pin_moves'
      and policyname = 'pin_moves_select_authenticated'
  ) then
    create policy "pin_moves_select_authenticated" on project_opening_pin_moves
      for select to authenticated using (true);
  end if;
end;
$$;

grant select on project_opening_pin_moves to authenticated;

-- --- 6. Record every move, from wherever it came -------------------------

create or replace function public.record_opening_pin_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- An undo is not a move. The undo functions set this for their transaction
  -- so walking the stack back does not push new entries onto it.
  if coalesce(current_setting('app.pin_undo', true), '') = 'on' then
    return null;
  end if;
  -- Only an actual relocation counts. Placing a mark for the first time
  -- (null -> value) and clearing one (value -> null) are different actions
  -- with their own undo already, and neither has a "from" to go back to.
  if old.pin_x is null or old.pin_y is null
     or new.pin_x is null or new.pin_y is null then
    return null;
  end if;
  if old.pin_x = new.pin_x
     and old.pin_y = new.pin_y
     and old.page_number is not distinct from new.page_number then
    return null;
  end if;

  insert into project_opening_pin_moves (
    project_id, opening_id, moved_by,
    from_pin_x, from_pin_y, from_page_number,
    to_pin_x, to_pin_y, to_page_number
  ) values (
    new.project_id, new.id, auth.uid(),
    old.pin_x, old.pin_y, old.page_number,
    new.pin_x, new.pin_y, new.page_number
  );
  return null;
end;
$$;

drop trigger if exists record_opening_pin_move on project_openings;
create trigger record_opening_pin_move
  after update of pin_x, pin_y, page_number on project_openings
  for each row execute function public.record_opening_pin_move();

-- --- 7. Undo, one step at a time -----------------------------------------
--
-- Takes the id of the move to walk back rather than "the newest one", for two
-- reasons: an undo queued in a dead zone must still undo the move the person
-- was looking at when they pressed it, not whatever happens to be newest when
-- the phone finds signal; and replaying the same queued undo twice must be a
-- no-op rather than eating someone else's work.
--
-- Foreman and above only. The marks are the whole crew's view of the job, and
-- this matches how every other plan-authoring write is gated
-- (project_mark_specs, project_mark_elevation_views, plan outlines).
create or replace function public.undo_opening_pin_move(p_move_id uuid)
returns project_opening_pin_moves
language plpgsql
security definer
set search_path = public
as $$
declare
  v_move project_opening_pin_moves;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can undo a mark move';
  end if;

  select * into v_move from project_opening_pin_moves where id = p_move_id;
  if v_move.id is null then
    raise exception 'That move is no longer on record';
  end if;
  if v_move.undone_at is not null then
    return v_move;
  end if;

  perform set_config('app.pin_undo', 'on', true);
  update project_openings
  set pin_x = v_move.from_pin_x,
      pin_y = v_move.from_pin_y,
      page_number = coalesce(v_move.from_page_number, page_number)
  where id = v_move.opening_id;
  perform set_config('app.pin_undo', 'off', true);

  update project_opening_pin_moves
  set undone_at = now(),
      undone_by = auth.uid()
  where id = p_move_id
  returning * into v_move;

  return v_move;
end;
$$;

-- --- 8. Put the whole job back where extraction put it -------------------
--
-- The end state of pressing undo enough times, in one action. Idempotent:
-- running it twice moves nothing the second time.
create or replace function public.reset_project_pins_to_extracted(p_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can reset a job''s marks';
  end if;

  perform set_config('app.pin_undo', 'on', true);
  with restored as (
    update project_openings
    set pin_x = origin_pin_x,
        pin_y = origin_pin_y,
        page_number = coalesce(origin_page_number, page_number)
    where project_id = p_project_id
      and origin_pin_x is not null
      and pin_x is not null
      and (pin_x <> origin_pin_x or pin_y <> origin_pin_y)
    returning 1
  )
  select count(*) into v_count from restored;
  perform set_config('app.pin_undo', 'off', true);

  update project_opening_pin_moves
  set undone_at = now(),
      undone_by = auth.uid()
  where project_id = p_project_id
    and undone_at is null;

  return v_count;
end;
$$;

-- --- 9. Put ONE mark back ------------------------------------------------
create or replace function public.reset_opening_pin_to_extracted(p_opening_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can reset a mark';
  end if;

  perform set_config('app.pin_undo', 'on', true);
  with restored as (
    update project_openings
    set pin_x = origin_pin_x,
        pin_y = origin_pin_y,
        page_number = coalesce(origin_page_number, page_number)
    where id = p_opening_id
      and origin_pin_x is not null
      and pin_x is not null
      and (pin_x <> origin_pin_x or pin_y <> origin_pin_y)
    returning 1
  )
  select count(*) into v_count from restored;
  perform set_config('app.pin_undo', 'off', true);

  update project_opening_pin_moves
  set undone_at = now(),
      undone_by = auth.uid()
  where opening_id = p_opening_id
    and undone_at is null;

  return v_count;
end;
$$;

grant execute on function public.undo_opening_pin_move(uuid) to authenticated;
grant execute on function public.reset_project_pins_to_extracted(uuid) to authenticated;
grant execute on function public.reset_opening_pin_to_extracted(uuid) to authenticated;

-- --- 10. Leave a record of the Black Desert repair -----------------------
--
-- So the history shown in the app is the truth: the move happened, and it has
-- been walked back. Marked undone on the way in, so it is not sitting at the
-- top of anyone's undo stack.
insert into project_opening_pin_moves (
  project_id, opening_id, moved_at,
  from_pin_x, from_pin_y, from_page_number,
  to_pin_x, to_pin_y, to_page_number,
  undone_at, note
)
select o.project_id, o.id, '2026-07-30T00:00:00Z',
       0.485199100308642, 0.7016958912037037, 1,
       0.502, 0.700, 1,
       now(),
       'Accidental drag, reported by Taylor. Restored from the 2026-07-29 backups.'
from project_openings o
where o.id = 'b1a6266b-87a0-42fa-a56a-2f9de83793f1'
  and o.opening_code = '37'
  and o.origin_pin_x = 0.485199100308642
  and not exists (
    select 1 from project_opening_pin_moves m where m.opening_id = o.id
  );
