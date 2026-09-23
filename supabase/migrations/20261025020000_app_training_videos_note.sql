-- Crew announcement for Learn's "Using Forge" tab (docs/app-updates.md). It
-- names the tab and what it is NOT — a design preview is not a shipped
-- workflow, not learning time and not a clearance — and promises no video by
-- name, because the videos are published separately and may arrive later.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-using-forge-previews','2026-09-23',array[0,1,2,3],'improvement',
 'New Using Forge tab in Learn','Nueva pestaña Usar Forge en Aprender',
 'Learn has a Using Forge tab for narrated walkthroughs of proposed app designs, shown for your role. Each is marked Design preview: some steps are not in the app yet, so keep working the way the app works today. Watching adds no learning time, points or clearances. Videos play while online and appear once published.',
 'Aprender tiene una pestaña Usar Forge con recorridos narrados de diseños propuestos para la app, según tu función. Cada uno dice Vista previa de diseño: algunos pasos todavía no están en la app, así que sigue trabajando como funciona hoy. Verlos no suma tiempo de aprendizaje, puntos ni autorizaciones. Los videos se reproducen con conexión y aparecen cuando se publican.','/learn') on conflict(id) do nothing;
