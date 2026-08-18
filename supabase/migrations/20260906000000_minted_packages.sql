-- Ticket 15: plan a window's packages and mint its labels (ADR-0005).
--
-- Typing at a truck is where wrong data comes from. A foreman declares
-- "window 16 arrives as 4 packages" and the labels exist BEFORE the truck —
-- already bound to job + window + part i of N — so receiving is sticking a
-- label on and tapping Arrived. This is the one good idea the unit chain had
-- (pre-issued IDs, missing deliveries visible), kept and moved onto packages,
-- which is the only chain now.
--
-- The new life stage is MINTED: a label that exists for material that has not
-- arrived. minted -> received happens at the truck; every other door already
-- refuses anything that is not physically here, because the eligibility lists
-- in store/stage/checkout name their statuses explicitly and 'minted' is not
-- in any of them. "You cannot store what has not arrived" costs nothing.

-- The status list gains 'minted'. Dropped BY SHAPE, not by name — the
-- constraint was born inline in 20260814 so its name is whatever Postgres
-- generated, and a survivor here would refuse every minted row while looking
-- fixed. Rebuilt from the CURRENT list (blank/received/stored/checked_out,
-- unchanged since 20260814 — verified against every later migration) plus the
-- one new value.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'packages'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%'
    and pg_get_constraintdef(oid) like '%blank%';
  if v_name is not null then
    execute format('alter table packages drop constraint %I', v_name);
  end if;
  alter table packages add constraint packages_status_ck
    check (status in ('blank', 'minted', 'received', 'stored', 'checked_out'));
end;
$$;

-- Declare a window's package count and mint the missing labels.
--
-- Idempotent by part slot: declaring 4 when parts 1 and 3 exist mints 2 and 4
-- and nothing else. Declaring a DIFFERENT total than any existing label
-- carries refuses loudly and names Burn (ticket 16) — silently rewriting part
-- totals is how labels end up lying, and "of 4" printed on paper cannot be
-- edited from here anyway.
create or replace function mint_mark_packages(
  p_project uuid,
  p_mark text,
  p_total int,
  p_category text default 'windows'
)
returns setof packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mark uuid;
  v_mark_code text;
  v_existing_total int;
  v_have int[];
  i int;
  v_row packages;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can mint labels';
  end if;
  if p_total is null or p_total < 1 or p_total > 20 then
    raise exception 'a window arrives as 1 to 20 packages';
  end if;

  v_mark_code := upper(trim(coalesce(p_mark, '')));
  select id into v_mark
  from project_marks
  where project_id = p_project and mark_code = v_mark_code;
  if v_mark is null then
    raise exception 'mark % is not on this job''s schedule', v_mark_code;
  end if;

  -- Every package already carrying this mark, whatever its stage. A label
  -- that disagrees about the total is a contradiction, not a top-up.
  select array_agg(distinct p.part_index) filter (where p.part_index is not null),
         max(p.part_total)
    into v_have, v_existing_total
  from packages p
  join package_marks pm on pm.package_id = p.id
  where pm.mark_id = v_mark;

  if v_existing_total is not null and v_existing_total <> p_total then
    raise exception
      'window % already has labels saying "of %" — burn those first if the count is really %',
      v_mark_code, v_existing_total, p_total;
  end if;

  for i in 1..p_total loop
    if v_have is not null and i = any(v_have) then
      continue; -- that part slot already has its label
    end if;
    insert into packages
      (status, project_id, category, part_index, part_total,
       short_code, bound_at, bound_by)
    values
      ('minted', p_project, p_category, i, p_total,
       issue_package_short_code(), now(), auth.uid()::text)
    returning * into v_row;

    insert into package_marks (package_id, mark_id)
    values (v_row.id, v_mark)
    on conflict do nothing;

    -- 'preissued' is already in movements_event_ck — the unit chain put it
    -- there, and this is its idea living on. The constraint stays untouched.
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_row.id, 'preissued', p_project, auth.uid()::text,
            'label minted — part ' || i || ' of ' || p_total);

    return next v_row;
  end loop;
  return;
end;
$$;

-- The truck side: a pre-labeled package came off the truck. Any signed-in
-- crew — whoever is at the truck receives (S3), same rule as tagging.
--
-- Safe to send twice: a package that is already past 'minted' counts as
-- received and writes NOTHING — the lost-answer resend is the normal case for
-- a phone in a yard, and a second 'received' line would make the history lie
-- about how many trucks there were.
create or replace function receive_minted_packages(p_packages uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select status into v_status from packages where id = v_id;
    if v_status is null then
      continue; -- no such package; nothing honest to do with it here
    end if;
    if v_status = 'minted' then
      update packages set status = 'received' where id = v_id;
      insert into movements (package_id, event, project_id, actor, reason)
      select v_id, 'received', p.project_id, auth.uid()::text,
             'came off the truck — pre-labeled'
      from packages p where p.id = v_id;
      v_count := v_count + 1;
    elsif v_status in ('received', 'stored', 'checked_out') then
      v_count := v_count + 1; -- already arrived; a resend is not a second truck
    end if;
  end loop;
  return v_count;
end;
$$;
