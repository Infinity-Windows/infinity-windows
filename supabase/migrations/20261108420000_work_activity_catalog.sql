begin;

-- Selected-job material only. This is not a command observation, a company
-- administration snapshot, or a second source of payroll totals.
create function public.work_activity_catalog(p_project_id uuid,p_unit_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
  actor uuid; at_time timestamptz; selected public.work_job_menu_selections;
  menu public.work_capture_menu_versions; unit_basis jsonb;
  menu_ready boolean; activities jsonb; result jsonb;
begin
  perform public._work_activity_read_committed();
  perform public._work_activity_gate(); actor:=public._work_activity_actor();
  if p_project_id is null then
    raise exception using errcode='23514',message='A job identity is required.';
  end if;
  perform pg_advisory_xact_lock(7710,0);
  actor:=public._work_activity_actor(); at_time:=clock_timestamp();

  -- Absent, hidden and removed sources have the same projection. In particular
  -- a unit's original binding must be visible before returning any unit IDs.
  if public._ai_job_visible(p_project_id,actor) is not true then
    return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(at_time),
      'availability','unavailable','projectId',null,'unit',null,'selection',null,
      'totals',jsonb_build_object('availability','unavailable','reasonCode','not_ready'));
  end if;
  if p_unit_id is not null then
    unit_basis:=public._work_activity_unit_basis(p_unit_id,actor);
    if unit_basis is null or unit_basis->>'projectId' is distinct from p_project_id::text then
      return jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(at_time),
        'availability','unavailable','projectId',null,'unit',null,'selection',null,
        'totals',jsonb_build_object('availability','unavailable','reasonCode','not_ready'));
    end if;
  end if;
  select * into selected from public.work_job_menu_selections
    where project_id=p_project_id order by revision desc limit 1;
  if selected.id is not null then
    select mv.* into menu from public.work_capture_menu_versions mv where mv.id=selected.menu_version_id;
    menu_ready:=menu.id is not null and exists(select 1 from public.work_capture_menus m
      where m.id=menu.menu_id and m.retired_at is null)
      and coalesce(menu.effective_from,menu.published_at)<=at_time
      and not exists(select 1 from jsonb_array_elements(menu.items) it
        left join public.work_activity_definition_versions dv on dv.id=(it->>'versionId')::uuid
        left join public.work_activity_definitions d on d.id=dv.definition_id
        where (it->>'enabled')::boolean and (dv.id is null or d.id is null
          or d.retired_at is not null or coalesce(dv.effective_from,dv.published_at)>at_time));
    if menu.id is null or jsonb_array_length(menu.items)>200 then
      raise exception using errcode='54000',message='Activity catalog is unavailable.';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'definitionId',dv.definition_id,'definitionVersionId',dv.id,
        'position',(it->>'position')::integer,'enabled',(it->>'enabled')::boolean,
        'scope',dv.scope,'labelEn',dv.label_en,'labelEs',dv.label_es,
        'machineSelection',dv.machine_selection,'typedFields',dv.typed_fields,
        'eligibleNow',reason.code is null,'ineligibleReason',reason.code)
      order by (it->>'position')::integer),'[]'::jsonb) into activities
      from jsonb_array_elements(menu.items) it
      join public.work_activity_definition_versions dv on dv.id=(it->>'versionId')::uuid
        and dv.definition_id=(it->>'definitionId')::uuid
      join public.work_activity_definitions d on d.id=dv.definition_id
      cross join lateral (select case
        when not (it->>'enabled')::boolean then 'disabled'
        when menu_ready is not true then 'menu_unavailable'
        when d.retired_at is not null or coalesce(dv.effective_from,dv.published_at)>at_time then 'definition_unavailable'
        when dv.scope='specific' and unit_basis is null then 'unit_required'
        when dv.scope='specific' and (unit_basis->>'eligibleForCapture')::boolean is not true then 'unit_dimensions'
        else null end as code) reason;
    if jsonb_array_length(activities)<>jsonb_array_length(menu.items) then
      raise exception using errcode='23514',message='Activity catalog is unavailable.';
    end if;
  end if;
  result:=jsonb_build_object('protocolVersion',1,'asOf',public._work_activity_iso(at_time),
    'availability','available','projectId',p_project_id,'unit',unit_basis,
    'selection',case when selected.id is null then null else jsonb_build_object(
      'selectionId',selected.id,'selectionRevision',selected.revision,'menuVersionId',selected.menu_version_id,
      'eligibleNow',menu_ready,'activities',activities) end,
    'totals',jsonb_build_object('availability','unavailable','reasonCode','not_ready'));
  if octet_length(result::text)>100000 then
    raise exception using errcode='54000',message='Activity catalog exceeds the response limit.';
  end if;
  return result;
end; $$;
revoke all on function public.work_activity_catalog(uuid,uuid) from public,anon;
grant execute on function public.work_activity_catalog(uuid,uuid) to authenticated;

commit;
