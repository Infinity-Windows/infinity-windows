-- Takeoffs (owner spec + grill, 2026-08-18): a warehouse hand bundles a
-- job's supplies for a named person. Two ways in, one trail out:
--
--   Flow A - built ahead: a foreman+ ("warehouse manager" is a hat, not a
--   rung - grill Q1) makes the bundle and marks it ready; the person it is
--   for gets told.
--
--   Flow B - requested: a foreman builds the list they need (installers
--   receive, foremen request - grill Q3), the warehouse acknowledges with a
--   rough ETA (quick picks, not prose - grill Q4), marks it ready, and the
--   requester picks it up.
--
-- Picking up TAKES the supplies (grill Q2): one tap runs the same decrement
-- take_supply does, per line, with the job attached - double entry gets
-- skipped at a tailgate, so pickup IS the take. The status transition is the
-- idempotency guard: ready -> picked_up happens once, and a resend after a
-- lost answer finds picked_up and changes nothing.
--
-- Shortages warn and never block (standing decision); the warning lives in
-- the app, the truth lives in movements.

create table if not exists takeoffs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  /** Who the bundle is FOR - the person told when it is ready. */
  for_profile_id uuid references profiles (id) on delete set null,
  created_by uuid references profiles (id) on delete set null,
  status text not null default 'requested'
    check (status in ('requested', 'acknowledged', 'ready', 'picked_up')),
  note text,
  /** The rough answer: one of the quick picks, free of prose on purpose. */
  eta text check (eta is null or eta in ('30min', 'today', 'tomorrow', 'this_week')),
  eta_note text,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  ready_at timestamptz,
  picked_up_at timestamptz,
  picked_up_by uuid references profiles (id) on delete set null
);

create table if not exists takeoff_items (
  id uuid primary key default gen_random_uuid(),
  takeoff_id uuid not null references takeoffs (id) on delete cascade,
  supply_id uuid not null references supplies (id) on delete restrict,
  qty numeric not null check (qty > 0)
);
create index if not exists takeoff_items_takeoff_idx on takeoff_items (takeoff_id);

alter table takeoffs enable row level security;
alter table takeoff_items enable row level security;

-- Visibility (owner): the warehouse side and the person it is for. Foreman+
-- see all (the shared warehouse inbox); an installer sees the ones for them.
-- Writes go through the definer functions below, nothing direct.
drop policy if exists takeoffs_read on takeoffs;
create policy takeoffs_read on takeoffs for select to authenticated
  using (
    public.is_foreman_plus(auth.uid())
    or for_profile_id = auth.uid()
    or created_by = auth.uid()
  );
drop policy if exists takeoff_items_read on takeoff_items;
create policy takeoff_items_read on takeoff_items for select to authenticated
  using (
    exists (
      select 1 from takeoffs t
      where t.id = takeoff_id
        and (
          public.is_foreman_plus(auth.uid())
          or t.for_profile_id = auth.uid()
          or t.created_by = auth.uid()
        )
    )
  );

-- Create, either flow. p_ready = true is Flow A: built ahead and READY the
-- moment it exists. Items arrive as [{supply_id, qty}]; every line checked.
create or replace function create_takeoff(
  p_project uuid,
  p_for uuid,
  p_items jsonb,
  p_note text default null,
  p_ready boolean default false
)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
  v_item jsonb;
  v_supply uuid;
  v_qty numeric;
  v_count int := 0;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can build a takeoff';
  end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'job not found';
  end if;
  if p_for is not null and not exists (select 1 from profiles where id = p_for) then
    raise exception 'that person is not on the roster';
  end if;

  insert into takeoffs (project_id, for_profile_id, created_by, status, note,
                        ready_at)
  values (
    p_project,
    coalesce(p_for, auth.uid()),
    auth.uid(),
    case when coalesce(p_ready, false) then 'ready' else 'requested' end,
    nullif(trim(coalesce(p_note, '')), ''),
    case when coalesce(p_ready, false) then now() end
  )
  returning * into v_row;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_supply := (v_item->>'supply_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    if v_supply is null or v_qty is null or v_qty <= 0 then
      raise exception 'every line needs a supply and a count above zero';
    end if;
    if not exists (select 1 from supplies where id = v_supply) then
      raise exception 'a line names a supply that is not in the catalog';
    end if;
    insert into takeoff_items (takeoff_id, supply_id, qty)
    values (v_row.id, v_supply, v_qty);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'a takeoff needs at least one line';
  end if;

  return v_row;
end;
$$;

-- The warehouse answers a request: received, and roughly when.
create or replace function acknowledge_takeoff(
  p_takeoff uuid,
  p_eta text default null,
  p_eta_note text default null
)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can answer a request';
  end if;
  update takeoffs
  set status = 'acknowledged',
      acknowledged_at = now(),
      eta = p_eta,
      eta_note = nullif(trim(coalesce(p_eta_note, '')), '')
  where id = p_takeoff and status = 'requested'
  returning * into v_row;
  if not found then
    raise exception 'that request is not waiting for an answer';
  end if;
  return v_row;
end;
$$;

create or replace function ready_takeoff(p_takeoff uuid)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can mark a takeoff ready';
  end if;
  update takeoffs
  set status = 'ready', ready_at = now()
  where id = p_takeoff and status in ('requested', 'acknowledged')
  returning * into v_row;
  if not found then
    raise exception 'that takeoff is not in a state that can become ready';
  end if;
  return v_row;
end;
$$;

-- Pickup IS the take (grill Q2). The status flip is the idempotency guard:
-- it happens exactly once, the takes ride the same transaction, and a resend
-- finds picked_up and returns success without touching a count.
create or replace function pickup_takeoff(p_takeoff uuid)
returns takeoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row takeoffs;
  v_item record;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;

  select * into v_row from takeoffs where id = p_takeoff;
  if not found then
    raise exception 'takeoff not found';
  end if;
  if v_row.status = 'picked_up' then
    return v_row; -- a resend is not a second pickup
  end if;
  if v_row.for_profile_id is distinct from auth.uid()
     and not public.is_foreman_plus(auth.uid()) then
    raise exception 'this takeoff is for somebody else';
  end if;

  update takeoffs
  set status = 'picked_up', picked_up_at = now(), picked_up_by = auth.uid()
  where id = p_takeoff and status = 'ready'
  returning * into v_row;
  if not found then
    raise exception 'this takeoff is not ready yet';
  end if;

  for v_item in
    select ti.supply_id, ti.qty, s.name
    from takeoff_items ti join supplies s on s.id = ti.supply_id
    where ti.takeoff_id = p_takeoff
  loop
    -- Same decrement take_supply does: an uncounted supply stays uncounted,
    -- a counted one never goes below zero.
    update supplies
    set on_hand = case when on_hand is null then null
                       else greatest(on_hand - v_item.qty, 0) end
    where id = v_item.supply_id;

    insert into movements (supply_id, event, project_id, qty, actor, reason)
    values (
      v_item.supply_id, 'took', v_row.project_id, v_item.qty,
      auth.uid()::text,
      'takeoff pickup'
    );
  end loop;

  return v_row;
end;
$$;
