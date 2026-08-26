-- Only owners see owners; only owners manage owners (owner ask, 2026-08-26).
--
-- The display half lives in the client (visibleRole: an owner reads as
-- "Supervisor" to anyone below owner). This is the half that has to be true
-- even if the display lies are peeled back: today a supervisor could demote
-- an owner or mint a new one through set_profile_role — with owners now
-- DISGUISED as supervisors, a supervisor tapping the pill their eyes agree
-- with would really demote the owner. So the rule becomes law here:
--
--   * changing an OWNER's role: owners only
--   * granting the owner role: owners only
--
-- Both functions are rebuilt from their CURRENT definitions (house rule):
-- set_profile_role from 20260729200000, trg_guard_profile_role_change from
-- the same file — each body identical except the new owner gates.

create or replace function public.set_profile_role(p_target uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rank int := public.my_role_rank();
  v_row  public.profiles;
begin
  if p_role not in ('installer', 'foreman', 'supervisor', 'owner') then
    raise exception 'invalid role %', p_role using errcode = '22023';
  end if;

  if v_rank < 2 then
    raise exception 'only a supervisor or owner can change roles'
      using errcode = '42501';
  end if;

  -- Owners belong to owners (2026-08-26): below owner rank, the owner role
  -- can be neither granted nor touched. Sentences the app shows as-is.
  if v_rank < 3 and p_role = 'owner' then
    raise exception 'only an owner can make an owner'
      using errcode = '42501';
  end if;
  if v_rank < 3
     and exists (select 1 from public.profiles where id = p_target and role = 'owner')
  then
    raise exception 'only an owner can change an owner''s role'
      using errcode = '42501';
  end if;

  -- No self-promotion above your own rank: a supervisor cannot make themselves
  -- the owner. Lateral and downward self-changes stay allowed.
  if p_target = auth.uid() and public.role_rank(p_role) > v_rank then
    raise exception 'you cannot promote yourself above your own role'
      using errcode = '42501';
  end if;

  update public.profiles
     set role = p_role, updated_at = now()
   where id = p_target
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such profile %', p_target using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'display_name', v_row.display_name,
    'role', v_row.role,
    'skill_level', v_row.skill_level,
    'active', v_row.active,
    'updated_at', v_row.updated_at
  );
end;
$$;

-- The trigger is the backstop that also binds SECURITY DEFINER paths. Same
-- body as 20260729200000, with the supervisor branch narrowed: rank 2 passes
-- only when neither side of the change is the owner role.
create or replace function public.trg_guard_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  -- Service role / no JWT: migrations, seeds, edge functions on the service
  -- key. RLS and the grants above already keep anon out.
  if auth.uid() is null then
    return new;
  end if;

  -- Owner: the sanctioned path, unrestricted.
  if public.my_role_rank() >= 3 then
    return new;
  end if;

  -- Supervisor: sanctioned for every role EXCEPT the owner role — an owner
  -- row can neither be demoted nor created below owner rank (2026-08-26).
  if public.my_role_rank() >= 2
     and old.role is distinct from 'owner'
     and new.role is distinct from 'owner'
  then
    return new;
  end if;

  -- Founder bootstrap, narrowed. The previous version let either founder email
  -- make ANY role change to ANY row; this allows exactly one thing — that
  -- account promoting itself to owner on first sign-in, which is how the very
  -- first owner comes to exist. Reachable only via claim_owner_bootstrap().
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if new.id = auth.uid()
     and new.role = 'owner'
     and v_email in ('ammon@horizonsolarusa.com', 'isaacammonbarlow@gmail.com')
  then
    return new;
  end if;

  raise exception
    'only an owner can touch an owner''s role (blocked: % -> % on %)',
    old.role, new.role, old.id
    using errcode = '42501';
end;
$$;

-- The INSERT guard had the same gap from the other direction: a supervisor
-- pre-creating a colleague's profile row could hand it role 'owner' on the
-- way in — and that fresh "owner" can promote anyone. Same body as
-- 20260729200000 with one added gate on the someone-else branch.
create or replace function public.trg_guard_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.id <> auth.uid() then
    if public.my_role_rank() < 2 then
      raise exception 'you may only create your own profile'
        using errcode = '42501';
    end if;
    if new.role = 'owner' and public.my_role_rank() < 3 then
      raise exception 'only an owner can make an owner'
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if new.role is distinct from 'installer'
     and v_email not in ('ammon@horizonsolarusa.com', 'isaacammonbarlow@gmail.com')
  then
    raise exception
      'a new profile starts as installer; a supervisor or owner assigns the role'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
