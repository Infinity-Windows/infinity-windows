-- A supply take can't subtract twice any more (warehouse audit F1).
--
-- The hole: take_supply had no way to tell a repeat from a new take. Every
-- call subtracted from on_hand and wrote a movement line, no questions asked.
-- A phone can't tell "the server never got it" from "the server got it and
-- the answer never came back" — both look like a dead connection — so it
-- retries. Send a take of 4 tubes, lose the reply, retry: on hand quietly
-- drops by 8 and the log shows two takes that never happened.
--
-- The fix is the one this repo already uses for clocking in
-- (20260720000000_offline_outbox_idempotency.sql) and for photo uploads: the
-- phone makes an id ONCE, before the first try, and reuses it on every retry.
-- The database recognizes an id it has already applied and does nothing the
-- second time. Same column name (client_id), same partial unique index
-- naming, same "check for the replay first, before anything else" shape.
--
-- One deliberate difference from clock_in: there is NO fallback overload that
-- takes no key. clock_in kept its old signature so a phone running an older
-- build still punches in; a take with no key would be a take with no guard,
-- which is the exact hole being closed. The 3-arg version is dropped, so a
-- call that omits the key fails to resolve to any function at all instead of
-- succeeding unguarded.
--
-- Where the key lives: a take IS a movement (ticket 05 folded every history
-- into `movements` so a second log could never grow back), one row per take.
-- So client_id belongs on `movements`, exactly like it lives on time_shifts
-- (one row per punch) and attachments (one row per photo).
--
-- Safe on a production database with rows already in supplies/movements:
-- everything here is additive. The new column is nullable, so every existing
-- movement keeps a null client_id; the unique index is partial (null is not
-- null-equal anyway, but the partial clause matches the two indexes this
-- copies) so those rows never collide. No existing row is read, rewritten or
-- rejected. Nothing here touches movements_event_ck — 'took' has been a legal
-- event since 20260825000000 and no new event value is minted.

-- 1) The key ---------------------------------------------------------------

alter table movements
  add column if not exists client_id uuid;

create unique index if not exists movements_client_id_key
  on movements (client_id)
  where client_id is not null;

-- 2) take_supply, now able to recognize its own retry -----------------------
--
-- Body is 20260826000000's verbatim, plus the replay guard, minus nothing.
-- The statement ORDER changed on purpose: the movement row is inserted BEFORE
-- on_hand is touched, so the unique index gates the subtraction and not just
-- the log line. In the old order a second call could subtract and only then
-- fail to log, which is the very drift this is meant to prevent.

drop function if exists take_supply(uuid, uuid, numeric);

create or replace function take_supply(
  p_supply uuid,
  p_project uuid,
  p_qty numeric,
  p_client_id uuid
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
  -- Belt and braces. Leaving the key off can't even reach this function (the
  -- 3-arg version no longer exists), but a caller can still pass an explicit
  -- null, and that must fail loudly rather than quietly skip the guard.
  if p_client_id is null then
    raise exception 'this take is missing the id that keeps it from counting twice';
  end if;

  -- The replay check runs FIRST and short-circuits everything, same as
  -- clock_in's. This take already landed on an earlier try whose answer never
  -- made it back to the phone. Hand back where the count stands now: the
  -- phone needs a success so it stops retrying, and nobody did anything wrong.
  if exists (select 1 from movements where client_id = p_client_id) then
    select * into v_row from supplies where id = p_supply;
    return v_row;
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'how many did you take?';
  end if;
  if p_project is null then
    raise exception 'pick the job this is for';
  end if;
  if not exists (select 1 from supplies where id = p_supply) then
    raise exception 'that supply is not in the catalog';
  end if;

  -- Claim the key before the count moves. Two phones draining the same take at
  -- the same instant both pass the check above; the index is what decides it.
  -- The loser lands here, subtracts nothing, and answers with the count the
  -- winner left behind.
  begin
    insert into movements (supply_id, event, project_id, qty, actor, client_id)
    values (p_supply, 'took', p_project, p_qty, auth.uid()::text, p_client_id);
  exception when unique_violation then
    select * into v_row from supplies where id = p_supply;
    return v_row;
  end;

  -- The running count floors at zero: a negative "about" number reads as
  -- broken, the movement keeps the true quantity, and the next shelf count
  -- corrects the estimate anyway.
  update supplies
  set on_hand = case when on_hand is null then null
                     else greatest(on_hand - p_qty, 0) end
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;

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
