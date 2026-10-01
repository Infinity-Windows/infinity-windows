-- Shown only after a client containing the Daily Logs page is installed.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-daily-logs-page', '2026-10-01', array[0,1,2,3], 'improvement',
  'Daily Logs has its own page', 'Registros diarios tiene su propia página',
  'Open Daily Logs from the menu to see logs across every job you work, add photos, and report which window stages you worked, how many units finished today, and how many are left. Safety reports still go through Safety, not the log.',
  'Abre Registros diarios desde el menú para ver los registros de todos tus trabajos, agregar fotos y reportar qué etapas de ventanas trabajaste, cuántas unidades terminaste hoy y cuántas faltan. Los reportes de seguridad siguen yendo por Seguridad, no por el registro.',
  '/daily-logs'
)
on conflict (id) do nothing;
