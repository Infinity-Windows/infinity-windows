-- Crew note for the update reload repair. An older phone could navigate twice
-- while installing a new build; the app now avoids those repeated reloads.
-- All four internal roles use the same installed app.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-28-update-reload','2026-09-28',array[0,1,2,3],'fix',
 'Fewer reloads during updates','Menos recargas durante las actualizaciones',
 'Forge now avoids repeated reloads while installing an update. If an update gets stuck, close and reopen Forge.',
 'Forge ahora evita que la aplicación se vuelva a cargar varias veces al instalar una actualización. Si una actualización se queda atascada, cierra Forge y vuelve a abrirlo.',
 null) on conflict(id) do nothing;
