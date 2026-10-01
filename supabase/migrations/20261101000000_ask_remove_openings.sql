-- One reviewed Ask tap removes an exact set of unused mapped openings together.
-- Existing remove_opening remains the sole writer and keeps the soft-delete audit.
create or replace function public.ai_remove_openings(
  p_project_id uuid,
  p_opening_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_row public.project_openings;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.is_foreman_plus(auth.uid()) or public.is_partner_user() then
    raise exception 'Only a foreman or above can remove units.' using errcode = '42501';
  end if;
  if p_project_id is null or coalesce(array_length(p_opening_ids,1),0) not between 1 and 20
     or array_position(p_opening_ids,null) is not null
     or (select count(distinct x) from unnest(p_opening_ids) x) <> array_length(p_opening_ids,1) then
    raise exception 'Choose 1–20 different units on one job.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id=p_project_id and deleted_at is null) then
    raise exception 'That job is unavailable.' using errcode = 'P0002';
  end if;

  -- Lock in stable order, then check the full set before changing any row.
  perform 1 from public.project_openings
   where id=any(p_opening_ids) order by id for update;
  foreach v_id in array p_opening_ids loop
    select * into v_row from public.project_openings where id=v_id;
    if not found or v_row.project_id <> p_project_id then
      raise exception 'A selected unit changed or is not on this job. Nothing was removed.' using errcode = 'P0002';
    end if;
    -- Existing remove_opening deliberately treats a repeat as a no-op. Keep
    -- the reviewed batch equally safe when a request is retried after commit.
    if v_row.removed_at is not null then continue; end if;
    if v_row.status='installed' or v_row.assigned_window_id is not null then
      raise exception 'A selected unit is installed or assigned warehouse material. Nothing was removed.' using errcode = 'P0001';
    end if;
    if exists(select 1 from public.unit_sessions where opening_id=v_id)
       or exists(select 1 from public.task_sessions where opening_id=v_id)
       or exists(select 1 from public.install_events where project_opening_id=v_id)
       or exists(select 1 from public.qc_checks where project_opening_id=v_id)
       or exists(select 1 from public.custom_work_units where opening_id=v_id)
       or v_row.work_started_at is not null then
      raise exception 'A selected unit has work or QC history. Nothing was removed.' using errcode = 'P0001';
    end if;
  end loop;

  foreach v_id in array p_opening_ids loop
    select * into v_row from public.remove_opening(v_id, 'Removed through Forge AI after on-screen review');
    v_result := v_result || jsonb_build_array(jsonb_build_object('id',v_row.id,'code',v_row.opening_code,'removed_at',v_row.removed_at));
  end loop;
  return jsonb_build_object('project_id',p_project_id,'removed',v_result);
end $$;

revoke all on function public.ai_remove_openings(uuid,uuid[]) from public, anon;
grant execute on function public.ai_remove_openings(uuid,uuid[]) to authenticated;
