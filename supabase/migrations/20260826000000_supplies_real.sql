-- Supplies become real (warehouse ticket 07).
--
-- Supplies were a wish list: a name, a unit, a per-job order row. Nothing
-- said WHERE the caulk lives or HOW MUCH we think we have. The grill settled
-- both (Q8/Q9, owner-confirmed): one home spot per supply, and a running
-- count that is always an estimate — decremented by what installers say they
-- took, corrected only by counting the shelf, and never shown without the
-- date it was last counted.
--
-- One deviation from docs/warehouse-tickets.md, on purpose: it sketched a
-- `supply_takes` table, but ticket 05 folded every history into `movements`
-- precisely so a second log could never grow back. A take IS a movement —
-- subject supply, event 'took' (pre-minted in 05's vocabulary), qty context.

alter table supplies
  add column if not exists home_location_id uuid references locations (id) on delete set null,
  -- Null = never counted. The UI must say "not counted yet", never invent 0.
  add column if not exists on_hand numeric,
  add column if not exists last_counted_at timestamptz;

-- How many moved. Context, not subject: null for every non-supply movement.
alter table movements add column if not exists qty numeric;

create index if not exists movements_supply_idx on movements (supply_id, created_at desc);

-- ---------------------------------------------------------------- RPCs

-- Any signed-in crew: take supplies. Three taps in the UI — how many, which
-- job, go. Never requires a pull list (grill Q25: taking must never wait on
-- somebody having planned it). The running count floors at zero: a negative
-- "about" number reads as broken, the movement keeps the true quantity, and
-- the next shelf count corrects the estimate anyway.
create or replace function take_supply(
  p_supply uuid,
  p_project uuid,
  p_qty numeric
)
returns supplies
language plpgsql
security definer
as $$
declare
  v_row supplies;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'how many did you take?';
  end if;
  if p_project is null then
    raise exception 'pick the job this is for';
  end if;

  update supplies
  set on_hand = case when on_hand is null then null
                     else greatest(on_hand - p_qty, 0) end
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;

  insert into movements (supply_id, event, project_id, qty, actor)
  values (p_supply, 'took', p_project, p_qty, auth.uid()::text);

  -- The pull list ticks itself off when a take matches it: flip the OLDEST
  -- open request for this supply on this job to 'picked'. A take with no
  -- matching request is fine and stays recorded — the list is a plan, the
  -- movement is what happened.
  update supply_orders
  set status = 'picked'
  where id = (
    select id from supply_orders
    where supply_id = p_supply and project_id = p_project
      and status in ('needed', 'ordered')
    order by created_at
    limit 1
  );

  return v_row;
end;
$$;

-- Any signed-in crew: counting the shelf is the correction, same as cycle
-- counts. Sets the estimate AND its date; the movement records the number
-- so drift between counts is measurable later.
create or replace function count_supply(
  p_supply uuid,
  p_counted numeric
)
returns supplies
language plpgsql
security definer
as $$
declare
  v_row supplies;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'a shelf count can''t be negative';
  end if;

  update supplies
  set on_hand = p_counted,
      last_counted_at = now()
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;

  insert into movements (supply_id, event, qty, actor)
  values (p_supply, 'count_verified', p_counted, auth.uid()::text);

  return v_row;
end;
$$;

-- Foreman+: the home spot is curation — it is the answer the app gives an
-- installer, so somebody accountable sets it.
create or replace function set_supply_home(
  p_supply uuid,
  p_location uuid
)
returns supplies
language plpgsql
security definer
as $$
declare
  v_role text;
  v_row supplies;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can set home spots';
  end if;

  update supplies
  set home_location_id = p_location
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;
  return v_row;
end;
$$;
