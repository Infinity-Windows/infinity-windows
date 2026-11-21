-- A placeholder no longer needs a floor (Matt, 2026-11-20).
--
-- A unit added in the field is often added before anyone knows which floor it
-- is on. 20261130090000 made the floor optional and 20261130100000 required it
-- again; this settles it as optional. A floor that IS given must still be a
-- whole number, and a placeholder still needs its type.
--
-- save_unit_details is restated in full from 20261130100000 with that one rule
-- changed. Nothing else in it differs.
create or replace function public.save_unit_details(
  p_project uuid, p_opening uuid, p_create boolean, p_code text,
  p_details jsonb, p_previous_code text, p_previous_details jsonb,
  p_edit_id uuid, p_reason text default null
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  current_unit public.project_openings%rowtype;
  created boolean := false;
  builder boolean := coalesce(public.is_foreman_plus(auth.uid()), false);
  previous_field_add text := coalesce(current_setting('app.field_unit_add', true), '');
begin
  if not coalesce(public.custom_work_internal(), false)
     or not exists (select 1 from public.projects where id = p_project) then
    raise exception 'This job is unavailable.' using errcode = '42501';
  end if;

  if p_edit_id is null or length(btrim(p_reason)) > 500 then
    raise exception 'The edit reason must be 500 characters or fewer.' using errcode = '22023';
  end if;

  if p_create is null or nullif(btrim(p_code), '') is null
     or jsonb_typeof(p_details) is distinct from 'object'
     or (p_details->>'floor' is not null and p_details->>'floor' !~ '^-?[0-9]{1,3}$')
     -- Curtain walls are units too (2026-11-20); app/src/lib/install/unitDetails.ts
     -- holds the same list.
     or (p_details->>'kind' is not null and p_details->>'kind' not in ('window', 'door', 'curtain_wall'))
     or (p_details->>'inset' is not null and p_details->>'inset' not in ('inset', 'outset', 'unknown'))
     or (p_details->>'basis' is not null and p_details->>'basis' not in ('unit', 'rough', 'drawing'))
     or (p_create and p_details->'placeholder' is distinct from 'true'::jsonb
         and (not builder or p_details->'placeholder' is distinct from 'false'::jsonb))
     or ((p_create or p_previous_details->'placeholder' = 'true'::jsonb)
         and p_details->'placeholder' = 'false'::jsonb and p_details->>'kind' is null)
     or (p_details ? 'builderDeferred' and (
         jsonb_typeof(p_details->'builderDeferred') <> 'boolean'
         or p_details->'placeholder' is distinct from 'true'::jsonb))
     or (p_create and p_details ? 'builderDeferred' and not builder)
     or (p_details->>'placeholder' = 'true' and p_details->>'kind' is null) then
    raise exception 'Enter a unit number and type. Floor, if provided, must be a whole number.' using errcode = '22023';
  end if;

  perform set_config('forge.unit_detail_edit_id', p_edit_id::text, true);
  perform set_config('forge.unit_detail_edit_reason', coalesce(btrim(p_reason), ''), true);

  if p_create then
    -- Preserve field-created openings on re-extraction. A new placeholder
    -- carries no pin, planset, type catalog row, or manufactured dimensions.
    -- Use the existing one-opening guard escape hatch only after checking
    -- internal access, job visibility, and the placeholder's required fields.
    -- Restore it immediately so this RPC cannot authorize later inserts.
    perform set_config('app.field_unit_add', 'on', true);
    insert into public.project_openings (id, project_id, opening_code, unit_details, field_added)
    values (p_opening, p_project, btrim(p_code), p_details, true)
    on conflict (id) do nothing;
    created := found;
    perform set_config('app.field_unit_add', previous_field_add, true);
  end if;

  select * into current_unit from public.project_openings
  where id = p_opening and project_id = p_project and removed_at is null for update;
  if not found then
    raise exception 'This unit is unavailable.' using errcode = '42501';
  end if;
  -- Check receipts while holding the opening lock. A retry may arrive after
  -- somebody else has already edited the unit again.
  if created or exists (
    select 1 from public.unit_detail_edit_history
    where edit_id = p_edit_id and opening_id = p_opening and actor_id = auth.uid()
  ) or (current_unit.opening_code = btrim(p_code) and current_unit.unit_details = p_details) then
    perform set_config('forge.unit_detail_edit_id', '', true);
    return created;
  end if;
  if p_create or current_unit.opening_code is distinct from p_previous_code
      or current_unit.unit_details is distinct from p_previous_details then
    raise exception 'This unit changed elsewhere. Reload before editing again.' using errcode = '22023';
  end if;

  if current_unit.unit_details->'placeholder' is distinct from p_details->'placeholder'
     and not (builder and current_unit.unit_details->'placeholder' is not distinct from 'true'::jsonb
       and p_details->'placeholder' is not distinct from 'false'::jsonb) then
    raise exception 'Only a foreman or above can confirm a placeholder.' using errcode = '42501';
  end if;
  if current_unit.unit_details->'builderDeferred' is distinct from p_details->'builderDeferred'
     and not builder then
    raise exception 'Only a foreman or above can review a placeholder.' using errcode = '42501';
  end if;

  update public.project_openings
  set opening_code = btrim(p_code), unit_details = p_details
  where id = current_unit.id and project_id = p_project;
  perform set_config('forge.unit_detail_edit_id', '', true);
  return true;
end;
$$;
