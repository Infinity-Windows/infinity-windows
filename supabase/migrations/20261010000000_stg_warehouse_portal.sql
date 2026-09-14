-- STG scoped warehouse access. Do not apply to production during review.
create schema if not exists stg_private;
revoke all on schema stg_private from public, anon, authenticated;

-- Business logic copied from 20260922000000_damage_photo.sql; callable only by the scoped command below.
create or replace function stg_private.arrive_packages(
  p_ok uuid[],
  p_damaged uuid[],
  p_project uuid,
  p_note text default null,
  p_photos jsonb default '{}'::jsonb
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_note text;
  v_serial text;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material arrived at';
  end if;
  v_note := nullif(trim(coalesce(p_note, '')), '');

  foreach v_id in array coalesce(p_ok, array[]::uuid[])
  loop
    if not exists (
      select 1 from packages where id = v_id and status = 'checked_out'
    ) then
      continue;
    end if;
    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'unloaded', p_project, auth.uid()::text,
            coalesce('arrived on site — ' || v_note, 'arrived on site'));
    v_count := v_count + 1;
  end loop;

  foreach v_id in array coalesce(p_damaged, array[]::uuid[])
  loop
    select serial into v_serial from packages where id = v_id and status = 'checked_out';
    if v_serial is null then
      continue;
    end if;

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_id, 'damaged', p_project, auth.uid()::text,
            coalesce('damaged on arrival — ' || v_note, 'damaged on arrival'));

    if not exists (
      select 1 from issues
      where package_id = v_id and kind = 'damage' and status = 'open'
    ) then
      insert into issues (project_id, package_id, kind, urgency, note, created_by, photo_path)
      values (
        p_project, v_id, 'damage', 'urgent',
        coalesce('Package ' || v_serial || ' damaged on arrival — ' || v_note,
                 'Package ' || v_serial || ' damaged on arrival'),
        auth.uid(),
        p_photos ->> v_id::text
      );
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke all on function stg_private.arrive_packages(uuid[], uuid[], uuid, text, jsonb) from public, anon, authenticated;

-- Business logic copied from 20260825000000_one_movement_log.sql; callable only by the scoped command below.
create or replace function stg_private.checkout_packages(
  p_packages uuid[],
  p_reason text,
  p_project uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_from uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'pick a reason for taking the material';
  end if;
  if p_project is null then
    raise exception 'pick the job this material is going to';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select container_id into v_from
    from packages
    where id = v_id and status in ('received', 'stored');
    if not found then
      continue;
    end if;

    update packages
    set status = 'checked_out', container_id = null
    where id = v_id;

    insert into movements (package_id, event, from_container_id, project_id, reason, actor)
    values (v_id, 'checked_out', v_from, p_project, trim(p_reason), auth.uid()::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function stg_private.checkout_packages(uuid[], text, uuid) from public, anon, authenticated;

-- Business logic copied from 20260986000000_warehouse_is_crew_work.sql; callable only by the scoped command below.
create or replace function stg_private.mint_mark_packages(
  p_project uuid,
  p_mark text,
  p_total int,
  p_category text default 'windows'
)
returns setof packages
language plpgsql
security definer
set search_path = public, pg_temp

as $$
declare
  v_mark uuid;
  v_mark_code text;
  v_existing_total int;
  v_have int[];
  i int;
  v_row packages;
begin

  if auth.uid() is null then
    raise exception 'sign in first';
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
      continue; 
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

    insert into movements (package_id, event, project_id, actor, reason)
    values (v_row.id, 'preissued', p_project, auth.uid()::text,
            'label minted — part ' || i || ' of ' || p_total);

    return next v_row;
  end loop;
  return;
end;
$$;
revoke all on function stg_private.mint_mark_packages(uuid, text, int, text) from public, anon, authenticated;

-- Business logic copied from 20260906000000_minted_packages.sql; callable only by the scoped command below.
create or replace function stg_private.receive_minted_packages(p_packages uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp

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
      continue; 
    end if;
    if v_status = 'minted' then
      update packages set status = 'received' where id = v_id;
      insert into movements (package_id, event, project_id, actor, reason)
      select v_id, 'received', p.project_id, auth.uid()::text,
             'came off the truck — pre-labeled'
      from packages p where p.id = v_id;
      v_count := v_count + 1;
    elsif v_status in ('received', 'stored', 'checked_out') then
      v_count := v_count + 1; 
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function stg_private.receive_minted_packages(uuid[]) from public, anon, authenticated;

-- Business logic copied from 20260998000000_bays_are_boxes.sql; callable only by the scoped command below.
create or replace function stg_private.stage_packages(
  p_packages uuid[],
  p_project uuid,
  p_expected jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp

as $$
declare
  v_bay uuid;
  v_id uuid;
  v_status text;
  v_container uuid;
  v_location uuid;
  v_serial text;
  v_note jsonb;
  v_exp_status text;
  v_exp_container uuid;
  v_exp_location uuid;
  v_hit int;
  v_staged int := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_project is null then
    raise exception 'pick the job this material is staged for';
  end if;

  v_bay := public.job_bay_box(p_project);

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select p.status, p.container_id, p.location_id, p.serial
      into v_status, v_container, v_location, v_serial
    from packages p
    where p.id = v_id;

    if v_status = 'stored' and v_container is not distinct from v_bay then
      v_staged := v_staged + 1;
      continue;
    end if;

    v_note := coalesce(p_expected, '{}'::jsonb) -> v_id::text;
    v_exp_status := v_note ->> 'status';
    v_exp_container := nullif(v_note ->> 'container', '')::uuid;
    v_exp_location := nullif(v_note ->> 'location', '')::uuid;

    if v_status is not null
       and v_exp_status is not null
       and v_exp_status in ('received', 'stored')
    then
      update packages
      set status = 'stored',
          container_id = v_bay,
          location_id = null
      where id = v_id
        and status = v_exp_status
        and container_id is not distinct from v_exp_container
        and location_id is not distinct from v_exp_location;
      get diagnostics v_hit = row_count;

      if v_hit = 1 then
        insert into movements
          (package_id, event, from_container_id, from_location_id,
           to_container_id, project_id, actor, reason)
        values (v_id, 'staged', v_exp_container, v_exp_location,
                v_bay, p_project, auth.uid()::text, 'set aside in the job''s bay');
        v_staged := v_staged + 1;
        continue;
      end if;

      select p.status, p.container_id, p.location_id, p.serial
        into v_status, v_container, v_location, v_serial
      from packages p
      where p.id = v_id;
    end if;

    v_refused := v_refused || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'serial', v_serial,
      'status', v_status,
      'container', (
        select c.name from storage_containers c where c.id = v_container
      ),
      'location', (
        select l.address from locations l where l.id = v_location
      ),
      'job', case when v_status = 'checked_out' then (
        select pr.job_code
        from movements m
        join projects pr on pr.id = m.project_id
        where m.package_id = v_id and m.event = 'checked_out'
        order by m.created_at desc
        limit 1
      ) end
    ));
  end loop;

  return jsonb_build_object(
    'staged', v_staged,
    'job', (select pr.job_code from projects pr where pr.id = p_project),
    
    'bay', (select c.name from storage_containers c where c.id = v_bay),
    'refused', v_refused
  );
end;
$$;
revoke all on function stg_private.stage_packages(uuid[], uuid, jsonb) from public, anon, authenticated;

-- Business logic copied from 20260831000000_store_packages_expected_state.sql; callable only by the scoped command below.
create or replace function stg_private.store_packages(p_packages uuid[], p_container uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp

as $$
declare
  v_id uuid;
  v_prev uuid;
  v_prev_loc uuid;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
  end if;

  foreach v_id in array coalesce(p_packages, array[]::uuid[])
  loop
    select container_id, location_id into v_prev, v_prev_loc
    from packages
    where id = v_id and status in ('received', 'stored', 'checked_out');
    if not found then
      continue; 
    end if;

    update packages
    set status = 'stored', container_id = p_container, location_id = null
    where id = v_id;

    insert into movements (
      package_id, event, from_container_id, from_location_id, to_container_id, actor
    )
    values (
      v_id,
      case when v_prev is null and v_prev_loc is null then 'stored' else 'moved' end,
      v_prev,
      v_prev_loc,
      p_container,
      auth.uid()::text
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function stg_private.store_packages(uuid[], uuid) from public, anon, authenticated;

-- Business logic copied from 20260830000000_take_supply_idempotent.sql; callable only by the scoped command below.
create or replace function stg_private.take_supply(
  p_supply uuid,
  p_project uuid,
  p_qty numeric,
  p_client_id uuid
)
returns supplies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row supplies;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;

  if p_client_id is null then
    raise exception 'this take is missing the id that keeps it from counting twice';
  end if;

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

  begin
    insert into movements (supply_id, event, project_id, qty, actor, client_id)
    values (p_supply, 'took', p_project, p_qty, auth.uid()::text, p_client_id);
  exception when unique_violation then
    select * into v_row from supplies where id = p_supply;
    return v_row;
  end;

  update supplies
  set on_hand = case when on_hand is null then null
                     else greatest(on_hand - p_qty, 0) end
  where id = p_supply
  returning * into v_row;
  if not found then
    raise exception 'that supply is not in the catalog';
  end if;

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
revoke all on function stg_private.take_supply(uuid, uuid, numeric, uuid) from public, anon, authenticated;

create or replace function stg_private.move_container(
  p_container uuid,
  p_parent uuid default null,
  p_location uuid default null
)
returns storage_containers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row storage_containers;
  v_old_parent uuid;
  v_old_location uuid;
  v_kind text;
  v_parent_kind text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_parent is not null and p_location is not null then
    raise exception 'pick one destination — inside a container or at a spot, not both';
  end if;
  if not exists (select 1 from storage_containers where id = p_container and active) then
    raise exception 'container not found or inactive';
  end if;

  select kind into v_kind from storage_containers where id = p_container;
  if v_kind = 'building' then
    raise exception 'the building does not move';
  end if;

  if p_parent is not null then
    select kind into v_parent_kind
    from storage_containers where id = p_parent and active;
    if v_parent_kind is null then
      raise exception 'destination container not found or inactive';
    end if;
    if v_parent_kind = 'crate' then
      raise exception 'nothing goes inside a crate — a crate is the smallest box there is';
    end if;
    if v_kind = 'conex' and v_parent_kind <> 'truck' then
      raise exception 'a conex only rides on a truck';
    end if;
    if v_kind = 'truck' then
      raise exception 'a truck does not go inside anything';
    end if;
  end if;

  select parent_container_id, location_id into v_old_parent, v_old_location
  from storage_containers where id = p_container;

  update storage_containers
  set parent_container_id = p_parent,
      location_id = p_location
  where id = p_container
  returning * into v_row;

  insert into movements
    (container_id, event, from_container_id, to_container_id,
     from_location_id, to_location_id, actor)
  values
    (p_container, 'moved', v_old_parent, p_parent, v_old_location, p_location,
     auth.uid()::text);

  insert into movements (package_id, event, to_container_id, actor, reason)
  select p.id, 'moved', p.container_id, auth.uid()::text,
         'rode along — ' || v_row.name || ' moved'
  from packages p
  where p.status = 'stored'
    and (
      p.container_id = p_container
      or p.container_id in (
        select id from storage_containers where parent_container_id = p_container
      )
    );

  return v_row;
end;
$$;
revoke all on function stg_private.move_container(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function stg_private.bind_package(
  p_package uuid,
  p_project uuid,
  p_category text default null,
  p_note text default null,
  p_marks text[] default null,
  p_delivery uuid default null,
  p_part_index int default null,
  p_part_total int default null,
  p_part_type text default null,
  p_mfr_mark text default null,
  p_boneyard boolean default false
)
returns packages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row packages;
  v_mark uuid;
  m text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if coalesce(p_boneyard, false) then
    if p_project is not null then
      raise exception 'boneyard stock has no job — pick one or the other';
    end if;
    if p_marks is not null and array_length(p_marks, 1) > 0 then
      raise exception 'a window number is a position on one job''s plans — boneyard stock has none';
    end if;
  elsif p_project is null then
    raise exception 'every package binds to a job — or to the Boneyard, said on purpose';
  end if;
  if (p_part_index is null) <> (p_part_total is null) then
    raise exception 'a part number needs both halves — "2 of 3", not just one';
  end if;
  if p_part_index is not null and p_part_index > p_part_total then
    raise exception 'part % of % — the first number can''t be bigger than the second', p_part_index, p_part_total;
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    if v_mark is null then
      raise exception 'mark % is not on this job''s schedule', m;
    end if;
  end loop;

  update packages
  set status = 'received',
      project_id = p_project,
      category = p_category,
      note = nullif(trim(coalesce(p_note, '')), ''),
      delivery_id = p_delivery,
      part_index = p_part_index,
      part_total = p_part_total,
      part_type = p_part_type,
      mfr_mark = nullif(upper(trim(coalesce(p_mfr_mark, ''))), ''),
      bound_at = now(),
      bound_by = auth.uid()::text
  where id = p_package and status = 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is already assigned — a package ID never moves to another package';
  end if;

  foreach m in array coalesce(p_marks, array[]::text[])
  loop
    select id into v_mark
    from project_marks
    where project_id = p_project and mark_code = upper(trim(m));
    insert into package_marks (package_id, mark_id)
    values (p_package, v_mark)
    on conflict do nothing;
  end loop;

  insert into movements (package_id, event, project_id, actor, reason)
  values (p_package, 'bound', p_project, auth.uid()::text,
          case when coalesce(p_boneyard, false) then 'tagged into the Boneyard — company stock' end);

  return v_row;
end;
$$;
revoke all on function stg_private.bind_package(uuid,uuid,text,text,text[],uuid,int,int,text,text,boolean) from public,anon,authenticated;

create table public.partner_warehouse_permissions (
  partner_profile_id uuid primary key references public.profiles(id) on delete cascade,
  capabilities text[] not null default '{}',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint partner_warehouse_capabilities_ck check (capabilities <@ array['receive','tag','move','checkout','arrival','damage','supplies','finalize','undo','containers','deliveries']::text[])
);
alter table public.partner_warehouse_permissions enable row level security;
revoke all on public.partner_warehouse_permissions from anon, authenticated;
grant select on public.partner_warehouse_permissions to authenticated;
create policy "warehouse permission owner read" on public.partner_warehouse_permissions for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 3);

create table public.partner_warehouse_commands (
  id uuid primary key,
  partner_profile_id uuid not null references public.profiles(id),
  project_id uuid not null references public.projects(id),
  action text not null,
  input jsonb not null,
  result jsonb not null default '{}',
  before_state jsonb not null default '[]',
  after_state jsonb not null default '[]',
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
alter table public.partner_warehouse_commands enable row level security;
revoke all on public.partner_warehouse_commands from anon, authenticated;
grant select on public.partner_warehouse_commands to authenticated;
create policy "warehouse command owner read" on public.partner_warehouse_commands for select to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 3);

create or replace function public.set_partner_warehouse_permissions(p_partner uuid, p_capabilities text[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or public.is_partner_user() or coalesce(public.my_role_rank(), -1) < 3
    or not exists(select 1 from profiles where id=auth.uid() and active) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_partner and is_partner) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_capabilities is null or not p_capabilities <@ array['receive','tag','move','checkout','arrival','damage','supplies','finalize','undo','containers','deliveries']::text[] then
    raise exception 'Choose valid warehouse permissions.';
  end if;
  insert into partner_warehouse_permissions(partner_profile_id, capabilities, updated_by)
  values(p_partner, p_capabilities, auth.uid())
  on conflict(partner_profile_id) do update set capabilities = excluded.capabilities, updated_by = auth.uid(), updated_at = now();
end;
$$;
revoke all on function public.set_partner_warehouse_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_partner_warehouse_permissions(uuid, text[]) to authenticated;

-- Hold the grant through a command transaction, so revocation cannot race a write.
create or replace function stg_private.require_job(p_project uuid, p_capability text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_partner_user()
    or not exists(select 1 from profiles where id=auth.uid() and active) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  perform 1 from partner_job_grants g join projects j on j.id = g.project_id
    where g.partner_profile_id = auth.uid() and g.project_id = p_project and j.deleted_at is null
    for share of g;
  if not found then raise exception 'permission denied' using errcode = '42501'; end if;
  if p_capability is not null then
    perform 1 from partner_warehouse_permissions where partner_profile_id = auth.uid()
      and p_capability = any(capabilities) for share;
    if not found then raise exception 'permission denied' using errcode = '42501'; end if;
  end if;
end;
$$;
revoke all on function stg_private.require_job(uuid, text) from public, anon, authenticated;

create or replace function public.stg_warehouse(p_project uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  perform stg_private.require_job(p_project);
  select jsonb_build_object(
    'capabilities', coalesce((select to_jsonb(capabilities) from partner_warehouse_permissions where partner_profile_id = auth.uid()), '[]'::jsonb),
    'finalized_at', (select materials_finalized_at from projects where id = p_project),
    'packages', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'serial', p.serial, 'short_code', p.short_code, 'status', p.status,
      'project_id', p.project_id, 'container_id', p.container_id, 'location_id', p.location_id,
      'mark', coalesce(p.mfr_mark,(select pm.mark_code from package_marks x join project_marks pm on pm.id = x.mark_id where x.package_id = p.id and pm.project_id = p_project order by pm.mark_code limit 1)), 'part_type', p.part_type, 'part_index', p.part_index, 'part_total', p.part_total,
      'area', p.area, 'delivery_id', p.delivery_id,
      'version', (select m.id from movements m where m.package_id = p.id order by m.created_at desc, m.id desc limit 1)
    ) order by p.serial) from packages p where p.project_id = p_project and p.status <> 'blank'), '[]'::jsonb),
    'containers', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'serial', c.serial, 'kind', c.kind,
      'name', case when c.project_id is not null and c.project_id <> p_project then 'Shared container' else c.name end,
      'active', c.active, 'parent_container_id',c.parent_container_id
    ) order by c.serial) from storage_containers c where c.project_id = p_project or exists
      (select 1 from packages p where p.project_id = p_project and p.container_id = c.id)), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'expected_at', d.expected_at,
      'label', case when exists (select 1 from packages x where x.delivery_id = d.id and x.project_id is distinct from p_project)
        then 'Shared delivery' else d.label end,
      'shared', exists (select 1 from packages x where x.delivery_id = d.id and x.project_id is distinct from p_project)
    )) from package_deliveries d where exists (select 1 from packages p where p.delivery_id = d.id and p.project_id = p_project)), '[]'::jsonb),
    'supplies', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'unit', s.unit))
      from supplies s where exists(select 1 from supply_orders o where o.supply_id = s.id and o.project_id = p_project)), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(h.line order by h.created_at desc) from (
      select m.created_at, jsonb_build_object('id', m.id, 'package_id', m.package_id, 'event', m.event, 'created_at', m.created_at) line
      from movements m where (m.project_id = p_project and m.package_id is null)
        or (exists(select 1 from packages p where p.id = m.package_id and p.project_id = p_project)
          and (m.project_id is null or m.project_id = p_project))
      order by m.created_at desc limit 200
    ) h), '[]'::jsonb),
    'undoable', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'action', action, 'created_at', created_at))
      from partner_warehouse_commands where partner_profile_id = auth.uid() and project_id = p_project
      and action in ('receive','move','checkout','stage') and undone_at is null and created_at > now() - interval '24 hours'), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.stg_warehouse(uuid) from public, anon;
grant execute on function public.stg_warehouse(uuid) to authenticated;

create or replace function public.stg_warehouse_command(p_command uuid, p_project uuid, p_action text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cap text; v_ids uuid[]; v_id uuid; v_p packages; v_expected jsonb;
  v_before jsonb := '[]'; v_after jsonb := '[]'; v_result jsonb; v_count int := 0;
  v_container uuid; v_parent uuid; v_delivery uuid; v_previous partner_warehouse_commands; v_undo partner_warehouse_commands;
  v_state jsonb; v_version uuid; v_new uuid;
begin
  v_cap := case p_action when 'bind' then 'tag' when 'stage' then 'move' when 'reopen' then 'finalize' when 'container_create' then 'containers' when 'container_move' then 'containers' when 'delivery_create' then 'deliveries' when 'delivery_update' then 'deliveries' else p_action end;
  if p_action is null or p_action not in ('receive','tag','bind','move','stage','checkout','arrival','damage','supplies','finalize','reopen','undo','container_create','container_move','delivery_create','delivery_update') then
    raise exception 'Choose a warehouse action.';
  end if;
  perform stg_private.require_job(p_project, v_cap);
  if p_input->>'actor' is distinct from auth.uid()::text then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_command is null or p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'This action is missing its retry details.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_command::text, 0));
  select * into v_previous from partner_warehouse_commands where id = p_command;
  if found then
    if v_previous.partner_profile_id <> auth.uid() or v_previous.project_id <> p_project
      or v_previous.action <> p_action or v_previous.input <> p_input then
      raise exception 'permission denied' using errcode = '42501';
    end if;
    return v_previous.result;
  end if;
  -- Serialize partner writes for this job, including finalization and undo.
  perform 1 from projects where id = p_project for update;
  if p_action <> 'reopen' and exists(select 1 from projects where id = p_project and materials_finalized_at is not null) then
    raise exception 'Reopen this job''s warehouse history before changing its material.';
  end if;

  if p_action in ('receive','move','stage','checkout','arrival','damage','delivery_create') then
    select array_agg(x::uuid order by x) into v_ids from jsonb_array_elements_text(p_input->'packages') x;
    if coalesce(cardinality(v_ids), 0) < 1 or cardinality(v_ids) > 500
      or cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
      raise exception 'Choose between 1 and 500 different packages.';
    end if;
    foreach v_id in array v_ids loop
      select * into v_p from packages where id = v_id and project_id = p_project for update;
      if not found then raise exception 'permission denied' using errcode = '42501'; end if;
      v_expected := p_input->'expected'->v_id::text;
      select id into v_version from movements where package_id = v_id order by created_at desc, id desc limit 1;
      if v_expected is null or not (v_expected ?& array['status','container_id','location_id','version'])
        or v_p.status is distinct from v_expected->>'status'
        or v_p.container_id is distinct from (v_expected->>'container_id')::uuid
        or v_p.location_id is distinct from (v_expected->>'location_id')::uuid
        or v_version is distinct from (v_expected->>'version')::uuid then
        raise exception 'This material changed. Refresh the warehouse and try again.';
      end if;
      if (p_action = 'receive' and v_p.status <> 'minted')
        or (p_action in ('stage','checkout') and v_p.status not in ('received','stored'))
        or (p_action = 'move' and v_p.status not in ('received','stored','checked_out'))
        or (p_action = 'delivery_create' and v_p.status not in ('minted','received','stored'))
        or (p_action = 'arrival' and v_p.status <> 'checked_out')
        or (p_action = 'damage' and v_p.status not in ('received','stored','checked_out')) then
        raise exception 'This package is not ready for that action. Refresh the warehouse.';
      end if;
      v_before := v_before || jsonb_build_array(jsonb_build_object('id',v_id,'status',v_p.status,
        'container_id',v_p.container_id,'location_id',v_p.location_id,'area',v_p.area,'version',v_version));
    end loop;
  end if;

  case p_action
    when 'container_create' then
      if coalesce(length(btrim(p_input->>'name')),0) not between 1 and 100
        or coalesce(p_input->>'kind','') not in ('crate','conex','truck') then raise exception 'Name the container and choose its kind.'; end if;
      insert into storage_containers(name,kind,project_id) values(btrim(p_input->>'name'),p_input->>'kind',p_project) returning id into v_container;
      v_count := 1;
    when 'container_move' then
      v_container := (p_input->>'container')::uuid; v_parent := (p_input->>'parent')::uuid;
      perform 1 from storage_containers c where c.id=v_container and c.project_id=p_project and c.active and c.kind not in ('building','bay') for update;
      if not found then raise exception 'permission denied' using errcode='42501'; end if;
      if not p_input ? 'expected_parent' or (select parent_container_id from storage_containers where id=v_container) is distinct from (p_input->>'expected_parent')::uuid then
        raise exception 'This container moved. Refresh and try again.';
      end if;
      -- Lock every rider before testing scope. A shared box must be split by crew.
      perform 1 from storage_containers where parent_container_id=v_container for share;
      perform 1 from packages where container_id=v_container or container_id in(select id from storage_containers where parent_container_id=v_container) for update;
      if exists(select 1 from packages where (container_id=v_container or container_id in(select id from storage_containers where parent_container_id=v_container)) and project_id is distinct from p_project)
        or exists(select 1 from storage_containers where parent_container_id=v_container and project_id is distinct from p_project) then
        raise exception 'This container is shared. Ask the office to arrange its move.';
      end if;
      if v_parent is not null then
        perform 1 from storage_containers where id=v_parent and project_id=p_project and active for share;
        if not found then raise exception 'permission denied' using errcode='42501'; end if;
      end if;
      perform stg_private.move_container(v_container,v_parent,null); v_count:=1;
    when 'delivery_create' then
      if coalesce(length(btrim(p_input->>'label')),0) not between 1 and 100 then raise exception 'Name the delivery in 1–100 characters.'; end if;
      insert into package_deliveries(label,expected_at,created_by) values(btrim(p_input->>'label'),nullif(p_input->>'expected_at','')::timestamptz,auth.uid()::text) returning id into v_delivery;
      update packages set delivery_id=v_delivery where id=any(v_ids);
      insert into movements(package_id,event,project_id,actor,reason) select unnest(v_ids),'override',p_project,auth.uid()::text,'Added to delivery';
      v_count:=cardinality(v_ids);
    when 'delivery_update' then
      v_delivery:=(p_input->>'delivery')::uuid;
      perform 1 from package_deliveries where id=v_delivery for update;
      perform 1 from packages where delivery_id=v_delivery for update;
      if not exists(select 1 from packages where delivery_id=v_delivery and project_id=p_project)
        or exists(select 1 from packages where delivery_id=v_delivery and project_id is distinct from p_project) then
        raise exception 'This delivery is shared or unavailable. Ask the office to arrange changes.' using errcode='42501';
      end if;
      if coalesce(length(btrim(p_input->>'label')),0) not between 1 and 100 then raise exception 'Name the delivery in 1–100 characters.'; end if;
      if not p_input ? 'expected_before' or (select expected_at from package_deliveries where id=v_delivery) is distinct from nullif(p_input->>'expected_before','')::timestamptz then
        raise exception 'This delivery changed. Refresh and try again.';
      end if;
      if nullif(p_input->>'expected_at','') is null and exists(select 1 from schedule_assignments where delivery_id=v_delivery) then
        raise exception 'Ask the office to cancel the scheduled delivery before clearing its date.';
      end if;
      update package_deliveries set label=btrim(p_input->>'label'),expected_at=nullif(p_input->>'expected_at','')::timestamptz where id=v_delivery;
      update schedule_assignments set start_date=(nullif(p_input->>'expected_at','')::timestamptz at time zone 'America/Denver')::date,
        end_date=(nullif(p_input->>'expected_at','')::timestamptz at time zone 'America/Denver')::date
        where delivery_id=v_delivery and nullif(p_input->>'expected_at','') is not null;
      v_count:=1;
    when 'receive' then v_count := stg_private.receive_minted_packages(v_ids);
    when 'move' then
      v_container := (p_input->>'container')::uuid;
      perform 1 from storage_containers c where c.id = v_container and c.active
        and (c.project_id = p_project or exists(select 1 from packages p where p.project_id = p_project and p.container_id = c.id)) for share;
      if not found then raise exception 'permission denied' using errcode = '42501'; end if;
      v_count := stg_private.store_packages(v_ids, v_container);
    when 'stage' then
      select jsonb_object_agg(key,jsonb_build_object('status',value->'status','container',value->'container_id','location',value->'location_id'))
        into v_expected from jsonb_each(p_input->'expected');
      v_result := stg_private.stage_packages(v_ids,p_project,v_expected);
      if jsonb_array_length(v_result->'refused') > 0 then raise exception 'This material changed. Refresh the warehouse.'; end if;
      v_count := (v_result->>'staged')::int;
    when 'checkout' then
      v_count := stg_private.checkout_packages(v_ids, coalesce(nullif(btrim(p_input->>'reason'),''),'Sent to job site'),p_project);
    when 'arrival' then
      v_count := stg_private.arrive_packages(v_ids,'{}',p_project,null,'{}');
    when 'damage' then
      if coalesce(length(btrim(p_input->>'note')),0) < 1 or length(p_input->>'note') > 1000 then raise exception 'Describe the damage in 1–1000 characters.'; end if;
      foreach v_id in array v_ids loop
        insert into movements(package_id,event,project_id,actor,reason)
          values(v_id,'damaged',p_project,auth.uid()::text,p_input->>'note');
        if not exists(select 1 from issues where package_id = v_id and kind = 'damage' and status = 'open') then
          insert into issues(project_id,package_id,kind,urgency,note,created_by)
            values(p_project,v_id,'damage','urgent',p_input->>'note',auth.uid());
        end if;
        v_count := v_count + 1;
      end loop;
    when 'bind' then
      select id into v_id from packages where status='blank' and (serial=upper(btrim(p_input->>'serial')) or short_code=upper(btrim(p_input->>'serial'))) for update;
      if v_id is null then raise exception 'That sticker is unavailable. Check the code or ask the office.'; end if;
      if not exists(select 1 from project_marks where project_id=p_project and mark_code=upper(btrim(p_input->>'mark'))) then
        raise exception 'Choose a window number on this job.';
      end if;
      if coalesce((p_input->>'part_index')::int,0) not between 1 and 20 or coalesce((p_input->>'part_total')::int,0) not between 1 and 20
        or (p_input->>'part_index')::int > (p_input->>'part_total')::int then raise exception 'Check the piece number and total.'; end if;
      perform stg_private.bind_package(v_id,p_project,'windows',null,array[upper(btrim(p_input->>'mark'))],null,
        (p_input->>'part_index')::int,(p_input->>'part_total')::int,p_input->>'part_type',upper(btrim(p_input->>'mark')),false);
      v_ids:=array[v_id];v_count:=1;
    when 'tag' then
      if (p_input->>'total')::int not between 1 and 100 then raise exception 'Choose 1–100 pieces.'; end if;
      select count(*) into v_count from stg_private.mint_mark_packages(p_project,p_input->>'mark',(p_input->>'total')::int,'windows');
    when 'supplies' then
      if not exists(select 1 from supply_orders where project_id = p_project and supply_id = (p_input->>'supply')::uuid) then
        raise exception 'permission denied' using errcode = '42501';
      end if;
      perform stg_private.take_supply((p_input->>'supply')::uuid,p_project,(p_input->>'qty')::numeric,p_command);
      v_count := 1;
    when 'finalize' then
      if exists(select 1 from packages where project_id = p_project and status in ('received','stored')) then
        raise exception 'Material is still in the warehouse. Send it to site before finalizing.';
      end if;
      update projects set materials_finalized_at = now(),materials_finalized_by = auth.uid() where id = p_project;
      update storage_containers set active = false where project_id = p_project and kind = 'bay' and active;
      insert into movements(project_id,event,actor,reason) values(p_project,'finalized',auth.uid()::text,'Material finalized');
      v_count := 1;
    when 'reopen' then
      update projects set materials_finalized_at = null,materials_finalized_by = null where id = p_project;
      insert into movements(project_id,event,actor,reason) values(p_project,'reopened',auth.uid()::text,'Material reopened');
      v_count := 1;
    when 'undo' then
      select * into v_undo from partner_warehouse_commands where id = (p_input->>'command')::uuid
        and partner_profile_id = auth.uid() and project_id = p_project and undone_at is null
        and created_at > now() - interval '24 hours' and action in ('receive','move','checkout','stage') for update;
      if not found then raise exception 'permission denied' using errcode = '42501'; end if;
      for v_state in select value from jsonb_array_elements(v_undo.after_state) loop
        select * into v_p from packages where id = (v_state->>'id')::uuid and project_id = p_project for update;
        if not found then raise exception 'permission denied' using errcode = '42501'; end if;
        select id into v_version from movements where package_id = v_p.id order by created_at desc,id desc limit 1;
        if v_p.status is distinct from v_state->>'status'
          or v_p.container_id is distinct from (v_state->>'container_id')::uuid
          or v_p.location_id is distinct from (v_state->>'location_id')::uuid
          or v_p.area is distinct from v_state->>'area'
          or v_version is distinct from (v_state->>'version')::uuid then
          raise exception 'This material changed after your action. It cannot be undone now.';
        end if;
      end loop;
      for v_state in select value from jsonb_array_elements(v_undo.before_state) loop
        v_id := (v_state->>'id')::uuid;
        select id into v_version from movements where package_id = v_id order by created_at desc,id desc limit 1;
        update packages set status = v_state->>'status',container_id = (v_state->>'container_id')::uuid,
          location_id = (v_state->>'location_id')::uuid where id = v_id;
        update packages set area = v_state->>'area' where id = v_id;
        insert into movements(package_id,event,project_id,actor,reason,undoes)
          values(v_id,'override',p_project,auth.uid()::text,'Partner undid warehouse action',v_version) returning id into v_new;
        v_count := v_count + 1;
      end loop;
      update partner_warehouse_commands set undone_at = now() where id = v_undo.id;
  end case;

  if v_ids is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'status',p.status,'container_id',p.container_id,
      'location_id',p.location_id,'area',p.area,'version',(select id from movements where package_id = p.id order by created_at desc,id desc limit 1))), '[]')
      into v_after from packages p where p.id = any(v_ids);
  end if;
  v_result := jsonb_build_object('command',p_command,'count',v_count);
  insert into partner_warehouse_commands(id,partner_profile_id,project_id,action,input,result,before_state,after_state)
    values(p_command,auth.uid(),p_project,p_action,p_input,v_result,v_before,v_after);
  return v_result;
end;
$$;
revoke all on function public.stg_warehouse_command(uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.stg_warehouse_command(uuid,uuid,text,jsonb) to authenticated;

select public.attach_sandbox_guards();

-- Legacy entry points must not bypass the scoped partner command. Preserve
-- their implementations and signatures, adding only an early partner refusal.
-- SECURITY DEFINER bodies bypass table RLS, so signed-in alone is insufficient.
do $guard$
declare r record; v_body text; v_definition text;
begin
  for r in select p.oid, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and l.lanname = 'plpgsql' and p.proname = any(array['add_crate_supplies','add_delivery_set','add_job_crate','add_part_type_option','arrive_packages','assign_package_to_job','bind_package','boneyard_job_leftovers','burn_packages','checkout_packages','copy_unit','create_manual_delivery','create_placeholder_job','custom_checkin','delete_delivery','delete_packages','ensure_package_delivery','file_pending_packages','finalize_job_materials','label_packages','mint_mark_packages','mint_packages','move_container','reassign_package','receive_minted_packages','rename_package','reopen_job_materials','report_maker_count','rewrite_set','save_storage_container','schedule_delivery','set_container_model','set_mark_kind','set_mark_part_total','set_package_area','set_package_note','set_package_part','set_package_window','set_piece_count','stage_packages','store_packages','undo_movement','unreceive_packages','unstore_packages','update_delivery','take_supply','count_supply','set_supply_home']::text[])
  loop
    v_body := regexp_replace(r.prosrc, '(^|\n)([ \t]*)begin[ \t]*\n',
      E'\\1\\2begin\n  if public.is_partner_user() then raise exception ''permission denied'' using errcode = ''42501''; end if;\n', 'i');
    if v_body = r.prosrc then raise exception 'Unable to protect warehouse function %', r.oid::regprocedure; end if;
    v_definition := pg_get_functiondef(r.oid);
    -- Replacing the exact body leaves arguments, grants and return type intact.
    execute replace(v_definition, r.prosrc, v_body);
  end loop;
end;
$guard$;

-- Package photos expose only images attached solely to this granted package.
-- Restrictive storage policies close the older bucket-wide authenticated door.
create or replace function public.stg_warehouse_file_read(p_bucket text,p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_partner_user() and exists(select 1 from profiles where id=auth.uid() and active) and p_bucket = 'install-media' and exists (
    select 1 from attachments a join packages p on p.id = a.package_id
    join partner_job_grants g on g.project_id = p.project_id and g.partner_profile_id = auth.uid()
    join projects j on j.id = p.project_id and j.deleted_at is null
    where a.storage_path = p_bucket || '/' || p_name and a.kind = 'photo' and a.deleted_at is null
      and a.window_id is null and a.install_event_id is null
      and (a.project_id is null or a.project_id = p.project_id)
      and p_name like 'packages/' || p.id::text || '/%'
  );
$$;
revoke all on function public.stg_warehouse_file_read(text,text) from public,anon;
grant execute on function public.stg_warehouse_file_read(text,text) to authenticated;
create or replace function public.stg_warehouse_file_upload(p_bucket text,p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_partner_user() and exists(select 1 from profiles where id=auth.uid() and active) and p_bucket = 'install-media' and exists (
    select 1 from packages p join partner_job_grants g on g.project_id = p.project_id and g.partner_profile_id = auth.uid()
    join partner_warehouse_permissions w on w.partner_profile_id = auth.uid()
    join projects j on j.id = p.project_id and j.deleted_at is null and j.materials_finalized_at is null
    where ('receive' = any(w.capabilities) or 'damage' = any(w.capabilities))
      and split_part(p_name,'/',1) = 'packages' and split_part(p_name,'/',2) = p.id::text
      and split_part(p_name,'/',3) = 'stg' and split_part(p_name,'/',4) = auth.uid()::text
      and split_part(p_name,'/',5) ~ '^[0-9a-f-]{36}\.jpg$' and array_length(string_to_array(p_name,'/'),1) = 5
  );
$$;
revoke all on function public.stg_warehouse_file_upload(text,text) from public,anon;
grant execute on function public.stg_warehouse_file_upload(text,text) to authenticated;
-- Workflow can land independently. Resolve its narrow authorization helper at
-- call time so either deployment order works without granting bucket access.
create or replace function public.stg_partner_file_read(p_bucket text,p_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_allowed boolean;
begin
  if not public.is_partner_user() or not exists(select 1 from profiles where id=auth.uid() and active) then
    return false;
  end if;
  if p_bucket = 'install-media' then
    return public.stg_warehouse_file_read(p_bucket,p_name);
  end if;
  if p_bucket = 'proposal-files' and to_regprocedure('public.proposal_partner_file(text)') is not null then
    execute 'select public.proposal_partner_file($1)' into v_allowed using p_name;
    return coalesce(v_allowed,false);
  end if;
  return false;
end;
$$;
revoke all on function public.stg_partner_file_read(text,text) from public,anon;
grant execute on function public.stg_partner_file_read(text,text) to authenticated;
create policy "partner scoped storage read" on storage.objects as restrictive for select to authenticated
  using (not public.is_partner_user() or public.stg_partner_file_read(bucket_id,name));
create policy "partner scoped storage insert" on storage.objects as restrictive for insert to authenticated
  with check (not public.is_partner_user() or public.stg_warehouse_file_upload(bucket_id,name));
create policy "partner no storage overwrite" on storage.objects as restrictive for update to authenticated
  using (not public.is_partner_user()) with check (not public.is_partner_user());
create policy "partner no storage delete" on storage.objects as restrictive for delete to authenticated
  using (not public.is_partner_user());

create or replace function public.stg_warehouse_photos(p_project uuid,p_package uuid)
returns table(id uuid,storage_path text,created_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform stg_private.require_job(p_project);
  if not exists(select 1 from packages p where p.id = p_package and p.project_id = p_project) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query select a.id,a.storage_path,a.created_at from attachments a
    where a.package_id = p_package and public.stg_warehouse_file_read('install-media',substr(a.storage_path,15))
    order by a.created_at;
end;
$$;
revoke all on function public.stg_warehouse_photos(uuid,uuid) from public,anon;
grant execute on function public.stg_warehouse_photos(uuid,uuid) to authenticated;

create or replace function public.stg_attach_warehouse_photo(p_project uuid,p_package uuid,p_path text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform stg_private.require_job(p_project);
  -- Serialize the existence check and insert when two tabs retry one photo.
  perform pg_advisory_xact_lock(hashtextextended('stg-photo:' || coalesce(p_path,''),0));
  perform 1 from projects where id=p_project for share;
  perform 1 from packages where id=p_package and project_id=p_project for share;
  if not found or not public.stg_warehouse_file_upload('install-media',p_path)
    or split_part(p_path,'/',2) <> p_package::text then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='install-media' and name=p_path) then
    raise exception 'Upload the photo before attaching it.';
  end if;
  if not exists(select 1 from attachments where package_id=p_package and storage_path='install-media/'||p_path) then
    insert into attachments(package_id,project_id,kind,storage_path,created_by)
      values(p_package,p_project,'photo','install-media/'||p_path,auth.uid()::text);
  end if;
end;
$$;
revoke all on function public.stg_attach_warehouse_photo(uuid,uuid,text) from public,anon;
grant execute on function public.stg_attach_warehouse_photo(uuid,uuid,text) to authenticated;

-- Preserve job purge behavior while removing scoped partner command history.
create or replace function public.purge_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project projects;
  v_job_name text;
  v_install_media_paths text[];
  v_issue_photo_paths text[];
begin
  if auth.uid() is not null and not _is_supervisor(auth.uid()) then
    raise exception 'Only a supervisor or above can permanently delete a job.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(639024,1);

  select * into v_project from projects where id = p_project_id for update;
  if v_project.id is null then
    raise exception 'That job does not exist.';
  end if;
  if v_project.deleted_at is null then
    raise exception 'That job is not in the trash.';
  end if;
  v_job_name := v_project.name;

  -- ---------------------------------------------------------------------
  -- STEP 0 — every detach runs first, inside this one transaction, so no
  -- FK can block a delete below (movements' FK carries NO on-delete rule
  -- at all — it would abort the whole purge if it still pointed at this
  -- job when the projects row goes).
  -- ---------------------------------------------------------------------
  -- Retain plan/revision history with the surviving travel instructions, but
  -- release live links before Schedule rows are purged. No queued notice for
  -- a purged job is claimable (workflow_claim_notices requires project_id).
  delete from workflow_plan_assignments where plan_id in (select id from workflow_plans where project_id=p_project_id);
  delete from workflow_plan_trips where plan_id in (select id from workflow_plans where project_id=p_project_id);
  update workflow_plans set project_id=null,state='canceled',updated_at=now() where project_id=p_project_id;

  update movements set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update windows set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update packages set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update time_shifts set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update task_sessions set project_id = null
   where project_id = p_project_id;
  update incidents set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update service_cases set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update trips set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update receipts set project_id = null, pending_job_name = coalesce(pending_job_name, v_job_name)
   where project_id = p_project_id;
  update studio_projects set project_id = null
   where project_id = p_project_id;
  update monday_jobs set project_id = null
   where project_id = p_project_id;
  update job_costs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update change_orders set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;
  update daily_logs set project_id = null, job_name = coalesce(job_name, v_job_name)
   where project_id = p_project_id;

  -- OPEN Q4: a damage report on a package that survives detaches WITH the
  -- package (project_id nulled, row and photo kept); every other issue on
  -- this job purges below.
  update issues
     set project_id = null
   where project_id = p_project_id
     and kind = 'damage' and package_id is not null;

  -- AUDIT HOLES 3+4: attachments dual-anchored to a surviving physical thing
  -- (window, package, or service case) detach — unlink install_event_id and
  -- project_id, keep the row and its storage file untouched. Two passes:
  -- rows already carrying this project's id, and (defense in depth, in case
  -- a row was ever written without project_id set) rows reached only via
  -- install_event_id whose event belongs to one of this job's openings.
  update attachments
     set install_event_id = null, project_id = null
   where project_id = p_project_id
     and (window_id is not null or package_id is not null or service_case_id is not null);

  update attachments a
     set install_event_id = null, project_id = null
    from install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id
     and (a.window_id is not null or a.package_id is not null or a.service_case_id is not null);

  -- OPEN Q3 / ADR-0004: snapshot the mark's text onto every package_marks
  -- row still pointing at one of this job's marks, THEN unlink — must
  -- happen before project_marks purges below, or the RESTRICT FK aborts.
  update package_marks pm
     set mark_code = coalesce(pm.mark_code, pmk.mark_code)
    from project_marks pmk
   where pm.mark_id = pmk.id and pmk.project_id = p_project_id;

  update package_marks
     set mark_id = null
   where mark_id in (select id from project_marks where project_id = p_project_id);

  -- ---------------------------------------------------------------------
  -- The purge order. summon_helpers/summon_declines cascade from summons;
  -- install_events/qc_checks/opening_phases/opening_notes/unit_redos/
  -- unit_sessions/project_opening_pin_moves/install_event_time_repairs all
  -- cascade from project_openings (verified against each table's own
  -- migration) — one delete of the parent takes the whole branch.
  -- project_planset_pages cascades from project_plansets the same way.
  -- ---------------------------------------------------------------------
  delete from summons where project_id = p_project_id;

  -- Gather storage paths BEFORE deleting the rows that name them: install
  -- photos anchored only to this job's install_events (no surviving window/
  -- package/service_case — the survivors above already lost that link), and
  -- opening_phases' finished-work photos, which carry no attachments row of
  -- their own and are about to cascade away with project_openings below.
  select coalesce(array_agg(path), '{}') into v_install_media_paths
    from (
      select a.storage_path as path
        from attachments a
        join install_events ie on ie.id = a.install_event_id
        join project_openings po on po.id = ie.project_opening_id
       where po.project_id = p_project_id
      union all
      select op.photo_path
        from opening_phases op
        join project_openings po on po.id = op.opening_id
       where po.project_id = p_project_id and op.photo_path is not null
    ) paths;

  delete from attachments a
   using install_events ie, project_openings po
   where a.install_event_id = ie.id
     and ie.project_opening_id = po.id
     and po.project_id = p_project_id;

  -- Issues: gather photo paths of what purges (the surviving package-damage
  -- carve-out above already left this project, so it is excluded here).
  select coalesce(array_agg(photo_path), '{}') into v_issue_photo_paths
    from issues where project_id = p_project_id and photo_path is not null;

  delete from issues where project_id = p_project_id;

  -- Takes install_events, qc_checks, opening_phases, opening_notes,
  -- unit_redos, unit_sessions, project_opening_pin_moves and
  -- install_event_time_repairs with it.
  delete from project_openings where project_id = p_project_id;

  -- Takes project_planset_pages with it.
  delete from project_mark_elevation_views where project_id = p_project_id;
  delete from project_plan_outlines where project_id = p_project_id;
  delete from project_plansets where project_id = p_project_id;
  delete from project_spec_discrepancies where project_id = p_project_id;
  delete from project_mark_specs where project_id = p_project_id;
  -- package_marks already unlinked above, so this can never hit RESTRICT.
  delete from project_marks where project_id = p_project_id;
  delete from project_windows where project_id = p_project_id;
  delete from job_notes where project_id = p_project_id;
  delete from supply_orders where project_id = p_project_id;
  delete from flash_run_assignments where project_id = p_project_id;
  delete from schedule_assignments where project_id = p_project_id;
  delete from vehicle_project_assignments where project_id = p_project_id;
  delete from takeoffs where project_id = p_project_id;
  delete from project_message_reads where project_id = p_project_id;
  delete from project_messages where project_id = p_project_id;
  delete from project_cost_codes where project_id = p_project_id;
  delete from sandbox_projects where project_id = p_project_id;
  delete from partner_job_grants where project_id = p_project_id;

  -- Storage cleanup: SQL DELETE against storage.objects — the bytes become
  -- unreachable in the bucket, there is no separate "delete the file" step
  -- this migration can call from SQL. Files go second-to-last, right before
  -- the projects row, so a crash mid-purge leaves harmless orphan files in
  -- the bucket, never a row pointing at a file that is already gone.
  delete from storage.objects
   where bucket_id = 'plansets' and name like p_project_id::text || '/%';

  delete from storage.objects
   where bucket_id = 'install-media' and name = any (v_install_media_paths);

  delete from storage.objects
   where bucket_id = 'issue-photos' and name = any (v_issue_photo_paths);

  delete from partner_warehouse_commands where project_id = p_project_id;
  delete from projects where id = p_project_id;
end;
$$;

-- Retire a login with warehouse work instead of deleting its audit history.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'partner_warehouse_commands.partner_profile_id',
      (select count(*) from partner_warehouse_commands where partner_profile_id = p_id),
    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;
