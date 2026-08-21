-- The skill tree, as badges (owner decision 2026-08-21, meeting-grill Q6):
-- numbers everywhere stay 1-5. WHAT somebody may touch is a named capability
-- a foreman grants — "can do wet glazing" is checkable against reality in a
-- way "is he a 7 or an 8" never is. Dispatch already blends skill, proven
-- per-type history, and per-type training clearance (installer_clearance);
-- badges sit ABOVE those as a hard family gate: a window type that demands a
-- capability is never offered to an installer who doesn't hold it, whatever
-- their number says. Foremen and above are the graders and stay ungated.

create table if not exists capability_badges (
  installer_id uuid not null references profiles(id) on delete cascade,
  capability text not null check (
    capability in ('nail_fin', 'retrofit', 'doors', 'wet_glazing', 'curtain_wall')
  ),
  granted_by uuid references profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (installer_id, capability)
);

alter table capability_badges enable row level security;

drop policy if exists "badges_select" on capability_badges;
create policy "badges_select" on capability_badges
  for select to authenticated using (true);

-- Writes go through the RPC below so the grant always carries who did it.

create or replace function set_capability_badge(
  p_installer_id uuid,
  p_capability text,
  p_granted boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_caller_role text;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role = 'installer' then
    raise exception 'Only a foreman or above can grant or take away a badge.'
      using errcode = '42501';
  end if;
  if p_capability not in ('nail_fin', 'retrofit', 'doors', 'wet_glazing', 'curtain_wall') then
    raise exception 'That is not one of the five badges.';
  end if;
  if p_granted then
    insert into capability_badges (installer_id, capability, granted_by)
    values (p_installer_id, p_capability, auth.uid())
    on conflict (installer_id, capability) do nothing;
  else
    delete from capability_badges
    where installer_id = p_installer_id and capability = p_capability;
  end if;
end;
$$;

grant execute on function set_capability_badge(uuid, text, boolean) to authenticated;

-- Which badge a window type demands before dispatch will offer it to an
-- installer. Null = no gate (the common case); set via the catalog CSV.
alter table window_types
  add column if not exists required_capability text
  check (
    required_capability is null
    or required_capability in ('nail_fin', 'retrofit', 'doors', 'wet_glazing', 'curtain_wall')
  );

comment on column window_types.required_capability is
  'Badge an installer must hold before dispatch offers them this type. Null = open to any eligible installer.';
