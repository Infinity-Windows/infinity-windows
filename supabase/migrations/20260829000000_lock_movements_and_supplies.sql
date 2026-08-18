-- Close two write holes the warehouse rebuild left open (warehouse audit).
--
-- S1, and it is the serious one. `package_events` was deliberately locked
-- down when storage tracking shipped: crew read, NO direct-write policies at
-- all, every line of history written by a SECURITY DEFINER RPC. Ticket 05
-- folded that history into `movements` to have one log instead of two — good
-- — but `movements` has carried a blanket "authenticated full access" policy
-- since the day-one inventory migration, and the fold never touched it.
--
-- So the lockdown was silently removed by a change that never mentioned
-- security: any signed-in crew member could insert a fake movement, rewrite
-- the actor/time/reason on a real one, or delete one outright, straight at
-- the table. That is the audit trail the whole design leans on ("last moved
-- Tuesday by Ammon"), and the estimating evidence downstream of it.
--
-- S2: `supplies` sits on the same blanket policy, which makes
-- set_supply_home's foreman+ check decoration — an installer could set a home
-- spot, fake a shelf count, or add a catalog row by going around the app.
-- Known debt (docs/security-followups-2026-07-29.md names this table); the
-- supplies work walked past it rather than creating it, but the owner has
-- since decided the catalog is the company's official list, so it gets the
-- same treatment here.
--
-- Every existing writer is a SECURITY DEFINER function, which bypasses RLS —
-- so putaway, load-out, cycle counts, bind/store/checkout/move, take/count
-- and the supply home spot all keep working untouched. The only client code
-- that wrote either table directly was addSupply(), which moves to an RPC
-- below with the foreman+ gate the UI already applies.

-- ------------------------------------------------------------- movements

drop policy if exists "movements_all_authed" on movements;
drop policy if exists "authenticated full access" on movements;

do $$
declare
  p record;
begin
  -- The day-one policy's name has drifted across repairs, so drop by shape:
  -- anything on movements that permits a write.
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'movements'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy %I on movements', p.policyname);
  end loop;

  if not exists (
    select 1 from pg_policies
    where tablename = 'movements' and policyname = 'movements crew read'
  ) then
    create policy "movements crew read" on movements
      for select to authenticated using (true);
  end if;
  -- Deliberately NO insert/update/delete policies: history is append-only and
  -- only the definer RPCs may append to it.
end;
$$;

-- -------------------------------------------------------------- supplies

do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'supplies'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy %I on supplies', p.policyname);
  end loop;

  if not exists (
    select 1 from pg_policies
    where tablename = 'supplies' and policyname = 'supplies crew read'
  ) then
    create policy "supplies crew read" on supplies
      for select to authenticated using (true);
  end if;
end;
$$;

-- The one direct client write that existed, now gated to match the UI.
-- Foreman+ because the catalog is the company's official list (owner's call,
-- 2026-08-17) — the same reasoning that already gates home spots.
create or replace function add_supply(p_name text, p_unit text default 'ea')
returns supplies
language plpgsql
security definer
as $$
declare
  v_role text;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_row supplies;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role = 'installer' then
    raise exception 'only a foreman-level user or above can add to the catalog';
  end if;
  if v_name is null then
    raise exception 'give the supply a name';
  end if;

  -- Case-insensitive duplicate guard: "Caulk", "caulk" and "CAULK" are one
  -- supply, and a split catalog makes every count on it meaningless.
  select * into v_row from supplies where lower(name) = lower(v_name) limit 1;
  if found then
    return v_row;
  end if;

  insert into supplies (name, unit)
  values (v_name, coalesce(nullif(trim(coalesce(p_unit, '')), ''), 'ea'))
  returning * into v_row;
  return v_row;
end;
$$;
