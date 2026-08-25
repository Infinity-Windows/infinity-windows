-- Deliveries grow up (owner-confirmed Q2, 2026-08-25): rename them, delete
-- them, give them an expected date & time, and assign the crew who meets
-- the truck — which lands automatically on Scheduling and each member's
-- My Schedule as a published assignment of kind 'delivery'.
--
-- Deleting a delivery kills only what was still EXPECTED (that was only
-- ever a list); arrived material is real and survives, losing just its
-- truck reference (the packages FK is ON DELETE SET NULL). The schedule
-- assignment rides the delivery (ON DELETE CASCADE).

alter table package_deliveries
  add column if not exists expected_at timestamptz;

alter table schedule_assignments
  add column if not exists kind text not null default 'install'
  check (kind in ('install', 'delivery'));

alter table schedule_assignments
  add column if not exists delivery_id uuid references package_deliveries(id) on delete cascade;

alter table schedule_assignments alter column project_id drop not null;

alter table schedule_assignments
  drop constraint if exists schedule_assignments_kind_target_ck;
alter table schedule_assignments
  add constraint schedule_assignments_kind_target_ck
  check (
    (kind = 'install' and project_id is not null)
    or (kind = 'delivery' and delivery_id is not null)
  );

-- One schedule entry per delivery, ever.
create unique index if not exists schedule_assignments_delivery_key
  on schedule_assignments (delivery_id) where delivery_id is not null;

create or replace function update_delivery(
  p_delivery uuid,
  p_label text default null,
  p_expected_at timestamptz default null
)
returns package_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row package_deliveries;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can edit a delivery.'
      using errcode = '42501';
  end if;
  update package_deliveries
  set label = coalesce(nullif(trim(coalesce(p_label, '')), ''), label),
      expected_at = coalesce(p_expected_at, expected_at)
  where id = p_delivery
  returning * into v_row;
  if not found then
    raise exception 'That delivery is gone.';
  end if;
  -- The schedule entry follows the truck's new time.
  if p_expected_at is not null then
    update schedule_assignments
    set start_date = p_expected_at::date,
        end_date = p_expected_at::date,
        start_time = p_expected_at::time
    where delivery_id = p_delivery;
  end if;
  return v_row;
end;
$$;

grant execute on function update_delivery(uuid, text, timestamptz) to authenticated;

create or replace function delete_delivery(p_delivery uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_killed int;
  v_kept int;
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can delete a delivery.'
      using errcode = '42501';
  end if;
  select count(*) filter (where status = 'minted'),
         count(*) filter (where status <> 'minted')
    into v_killed, v_kept
  from packages where delivery_id = p_delivery;

  delete from packages where delivery_id = p_delivery and status = 'minted';
  delete from package_deliveries where id = p_delivery;

  return jsonb_build_object('killed', coalesce(v_killed, 0), 'kept', coalesce(v_kept, 0));
end;
$$;

grant execute on function delete_delivery(uuid) to authenticated;

create or replace function schedule_delivery(
  p_delivery uuid,
  p_when timestamptz,
  p_member_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_label text;
  v_assignment uuid;
  v_member uuid;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null or v_role in ('installer', 'foreman') then
    raise exception 'Only a supervisor or above can put a delivery on the schedule.'
      using errcode = '42501';
  end if;
  if p_when is null then
    raise exception 'Pick the date and time the truck comes.';
  end if;
  select label into v_label from package_deliveries where id = p_delivery;
  if v_label is null then
    raise exception 'That delivery is gone.';
  end if;

  update package_deliveries set expected_at = p_when where id = p_delivery;

  select id into v_assignment from schedule_assignments
  where delivery_id = p_delivery;

  if v_assignment is null then
    insert into schedule_assignments
      (kind, delivery_id, project_id, start_date, end_date, start_time,
       status, note, created_by, published_at)
    values
      ('delivery', p_delivery, null, p_when::date, p_when::date, p_when::time,
       'published', 'Meet the truck — ' || v_label, auth.uid(), now())
    returning id into v_assignment;
  else
    update schedule_assignments
    set start_date = p_when::date,
        end_date = p_when::date,
        start_time = p_when::time,
        status = 'published',
        note = 'Meet the truck — ' || v_label,
        published_at = coalesce(published_at, now())
    where id = v_assignment;
  end if;

  delete from schedule_assignment_members where assignment_id = v_assignment;
  foreach v_member in array coalesce(p_member_ids, array[]::uuid[])
  loop
    insert into schedule_assignment_members (assignment_id, profile_id, role)
    values (v_assignment, v_member, 'installer')
    on conflict do nothing;
  end loop;

  return v_assignment;
end;
$$;

grant execute on function schedule_delivery(uuid, timestamptz, uuid[]) to authenticated;
