begin;

-- A selector receives only currently selectable published labels and this
-- job's CAS pointer. Company drafts and other jobs never enter this read.
create function public.work_job_menu_choices(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_as_of timestamptz := statement_timestamp();
  v_current record;
  v_choices jsonb;
  v_count bigint;
  v_result jsonb;
begin
  if v_actor is null or p_project_id is null
      or public._work_config_can_manage_menu(p_project_id, v_actor) is not true then
    raise exception using errcode = '42501', message = 'Job menu choices are unavailable.';
  end if;

  select s.revision, s.menu_version_id into v_current
    from public.work_job_menu_selections s
    where s.project_id = p_project_id order by s.revision desc limit 1;

  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'menuVersionId', eligible.id, 'version', eligible.version,
      'labelEn', eligible.label_en, 'labelEs', eligible.label_es,
      'publishedAt', eligible.published_at,
      'effectiveFrom', eligible.effective_from)
      order by eligible.published_at desc, eligible.id), '[]'::jsonb)
    into v_count, v_choices
    from (
      select mv.id, mv.version, mv.label_en, mv.label_es, mv.published_at,
        coalesce(mv.effective_from, mv.published_at) as effective_from
      from public.work_capture_menu_versions mv
      join public.work_capture_menus m on m.id = mv.menu_id
      where m.retired_at is null
        and coalesce(mv.effective_from, mv.published_at) <= v_as_of
        and not exists (
          select 1 from jsonb_array_elements(mv.items) item
          join public.work_activity_definition_versions av on av.id = (item->>'versionId')::uuid
          join public.work_activity_definitions ad on ad.id = av.definition_id
          where (item->>'enabled')::boolean
            and (ad.retired_at is not null
              or coalesce(av.effective_from, av.published_at) > v_as_of))
      -- Fetch one extra to refuse overflow rather than returning partial data.
      order by mv.published_at desc, mv.id limit 501
    ) eligible;
  if v_count > 500 then
    raise exception using errcode = '54000', message = 'Job menu choices exceed the response limit.';
  end if;

  v_result := jsonb_build_object('protocolVersion', 1, 'projectId', p_project_id,
    'asOf', v_as_of, 'currentRevision', coalesce(v_current.revision, 0),
    'currentSelection', case when v_current.revision is null then null else
      jsonb_build_object('revision', v_current.revision, 'menuVersionId', v_current.menu_version_id) end,
    'choices', v_choices);
  if octet_length(v_result::text) > 1000000 then
    raise exception using errcode = '54000', message = 'Job menu choices exceed the response limit.';
  end if;
  return v_result;
end;
$$;
revoke all on function public.work_job_menu_choices(uuid) from public, anon;
grant execute on function public.work_job_menu_choices(uuid) to authenticated;

commit;
