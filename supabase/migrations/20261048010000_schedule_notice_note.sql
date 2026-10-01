-- Included only by clients containing the schedule-change-notice fix.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-09-30-schedule-change-notices', '2026-09-30', array[0,1,2,3], 'fix',
  'Schedule changes show up in Notifications again',
  'Los cambios de horario vuelven a aparecer en Notificaciones',
  'If you cleared a schedule notice and then a job you are on changed date or hours, Notifications now shows it again with your current job, date, and hours. Clearing a notice still works the same for anything that has not changed.',
  'Si borraste un aviso de horario y luego cambiaron la fecha o el horario de un trabajo en el que estás, Notificaciones ahora lo muestra de nuevo con tu trabajo, fecha y horario actuales. Borrar un aviso sigue funcionando igual para lo que no ha cambiado.',
  '/notifications'
)
on conflict (id) do nothing;
