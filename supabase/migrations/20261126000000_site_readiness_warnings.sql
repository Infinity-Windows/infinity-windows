-- Owner direction 2026-10-08: Ready records site readiness. Setup reminders
-- remain visible but must not prevent a lead from marking the site ready.
-- Preserve the existing identity, role/state/existence checks, grants and upsert.
create or replace function public.set_project_readiness(
  p_project_id uuid,
  p_ready_state text
)
returns project_pipeline
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row project_pipeline;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'Only a foreman or above can say whether a job is ready.';
  end if;
  if p_ready_state is null or p_ready_state not in ('not_ready', 'ready') then
    raise exception 'A job is either ready or not ready — nothing else.';
  end if;
  if not exists (select 1 from projects where id = p_project_id) then
    raise exception 'That job does not exist.';
  end if;

  insert into project_pipeline (project_id, ready_state, updated_at, updated_by)
  values (p_project_id, p_ready_state, now(), auth.uid())
  on conflict (project_id) do update
    set ready_state = excluded.ready_state,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_project_readiness(uuid, text) is
  'Foreman+: record site readiness independently of the green-light setup checklist (owner direction 2026-10-08). Unfinished setup items remain warnings; no clock or toolbox admission rule is changed.';

revoke all on function public.set_project_readiness(uuid, text) from public, anon;
grant execute on function public.set_project_readiness(uuid, text) to authenticated;

insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values ('2026-10-08-site-readiness', date '2026-10-08', array[1, 2, 3], 'fix',
  'Mark a site ready without waiting for office setup', 'Marcar un sitio listo sin esperar la preparación de oficina',
  'Mark ready now records whether the job site is ready. Unfinished setup items appear as reminders for the foreman and supervisor instead of blocking the button. Toolbox talk and time clock requirements still apply.',
  'Marcar listo ahora registra si el sitio de trabajo está listo. Los elementos de preparación pendientes aparecen como recordatorios para el capataz y el supervisor, sin bloquear el botón. Los requisitos de charla de seguridad y reloj siguen vigentes.', '/projects')
on conflict (id) do nothing;
