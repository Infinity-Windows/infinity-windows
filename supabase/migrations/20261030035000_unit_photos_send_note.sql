-- Crew announcement for #639 (docs/app-updates.md): a finished unit's photos,
-- videos and memos now go through the one offline queue, send from any screen,
-- can't arrive twice, and the sync status only says All synced when every
-- queue is empty; Stuck writes lists what is still waiting, with Send now.
-- Everyone who takes unit photos or reads the sync status sees it, so all four
-- audiences. Button and status names are quoted as the phone prints them:
-- stuck.sendNow / stuck.title in lib/i18n/catalog.ts. "All synced" is still
-- English-only (lib/offline/outbox-core.ts), which is why the Spanish quotes it
-- in English.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-unit-photos-send','2026-09-25',array[0,1,2,3],'fix',
 'Unit photos send from any screen, and All synced means all sent','Las fotos de unidades se envían desde cualquier pantalla, y All synced significa todo enviado',
 'Photos, videos and voice memos from a finished unit are saved on your phone first, then send on their own from any screen once you have signal. Before, they only sent while that unit was open. A photo can''t arrive twice. The sync status at the top says All synced only when everything has really been sent. Tap it to open Stuck writes, which now also lists what is still waiting and for how long, with a Send now button. Photos stuck on your phone from before are sent the next time you open Forge.',
 'Las fotos, los videos y las notas de voz de una unidad terminada se guardan primero en tu teléfono y luego se envían solos desde cualquier pantalla cuando tienes señal. Antes solo se enviaban mientras esa unidad estaba abierta. Una foto no puede llegar dos veces. El estado de sincronización de arriba dice All synced solo cuando todo se envió de verdad. Tócalo para abrir Escrituras atascadas, que ahora también muestra lo que sigue esperando y desde hace cuánto, con un botón Enviar ahora. Las fotos atascadas en tu teléfono desde antes se envían la próxima vez que abras Forge.',
 '/stuck') on conflict(id) do nothing;
