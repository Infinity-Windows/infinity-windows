-- Release notes are curated deployment content, never editable by crew logins.
create table public.app_release_notes (
 id text primary key check(length(id) between 1 and 100),
 published_on date not null,
 audience integer[] not null check(cardinality(audience)>0 and audience <@ array[0,1,2,3]),
 kind text not null check(kind in ('fix','improvement')),
 title_en text not null check(length(btrim(title_en)) between 1 and 180),
 title_es text not null check(length(btrim(title_es)) between 1 and 180),
 body_en text not null check(length(btrim(body_en)) between 1 and 2000),
 body_es text not null check(length(btrim(body_es)) between 1 and 2000),
 href text check(href ~ '^/[a-z0-9][a-z0-9/-]*$'),
 withdrawn_at timestamptz
);
alter table public.app_release_notes enable row level security;
revoke all on public.app_release_notes from public,anon,authenticated;
grant select on public.app_release_notes to authenticated;
grant all on public.app_release_notes to service_role;

create function public.can_read_app_update(p_audience integer[]) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null
 and coalesce(public.my_role_rank()=any(p_audience),false)
 and exists(select 1 from profiles where id=auth.uid() and role in ('installer','foreman','lead','supervisor','admin','owner','big_boss') and not is_partner and retired_at is null and access_revoked_at is null);
$$;
revoke all on function public.can_read_app_update(integer[]) from public,anon;
grant execute on function public.can_read_app_update(integer[]) to authenticated;
create policy app_updates_read on public.app_release_notes for select to authenticated
using(withdrawn_at is null and published_on<=current_date and public.can_read_app_update(audience));

-- Initial catch-up includes merged, shipped improvements only. Draft AI job and
-- scheduling actions are intentionally absent. IDs are also allowlisted by the
-- frontend build, preventing announcements of code an older phone lacks.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-21-photos','2026-09-21',array[0,1,2,3],'fix',
 'Clearer photo upload status','Estado más claro al subir fotos',
 'Photo capture now distinguishes pictures waiting to sync from pictures saved to the job. Upload recovery helps pictures that were stuck in the queue.',
 'La captura distingue las fotos pendientes de sincronizar de las guardadas en la obra. La recuperación de subidas ayuda con las fotos atascadas en la cola.','/photos'),
('2026-09-21-voice','2026-09-21',array[0,1,2,3],'fix',
 'Voice memos can record and become text','Las notas de voz se graban y se convierten en texto',
 'Voice memo recording, saving and transcription have been improved. Leaving the job site no longer blocks an authorized crew member from transcribing a memo.',
 'Se mejoraron la grabación, el guardado y la transcripción. Salir de la obra ya no impide que un miembro autorizado transcriba una nota.',null),
('2026-09-21-time-off','2026-09-21',array[0,1,2,3],'improvement',
 'Report sick days and request time off','Reporta enfermedad y solicita días libres',
 'Choose sick leave, vacation or days off with a date range from My Schedule. Sick leave takes effect immediately; vacation and other days off go to a supervisor for approval. These track days away without adding payroll hours.',
 'Elige enfermedad, vacaciones o días libres con fechas en Mi horario. La enfermedad se aplica de inmediato; las vacaciones y otros días libres requieren aprobación. Se cuentan los días de ausencia sin agregar horas a la nómina.','/my-schedule'),
('2026-09-21-team-reports','2026-09-21',array[1,2,3],'improvement',
 'Ask Forge for crew hours and job summaries','Pide horas del equipo y resúmenes de obras',
 'Ask for a date range, employees or jobs, then download the hours report as CSV or PDF. Job summaries include recorded labor, hour targets, stages and recent logs. Existing AI access and budget settings still apply.',
 'Pide un rango de fechas, empleados u obras y descarga las horas en CSV o PDF. Los resúmenes incluyen horas registradas, metas, etapas e informes recientes. Se mantienen los permisos y límites de IA.','/ask'),
('2026-09-21-leave-review','2026-09-21',array[2,3],'improvement',
 'Review vacation and days-off requests','Revisa solicitudes de vacaciones y días libres',
 'Supervisors and owners can review time-off requests and track absence counts. Approved vacation and days off affect availability; payroll hours remain unchanged.',
 'Los supervisores y dueños pueden revisar solicitudes y contar ausencias. Las vacaciones y días libres aprobados afectan la disponibilidad sin cambiar las horas de nómina.','/scheduling');
