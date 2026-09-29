-- Work now counts photos waiting inside an install before they reach the
-- ordinary upload queue. This is visibility, not a claim that uploads are fixed.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-09-29-install-photo-queue-visibility','2026-09-29',array[0,1,2,3],'fix',
   'See photos waiting to send','Ver fotos pendientes de envío',
   'When a photo has waited over an hour, Work now includes photos still inside installation records as well as the upload queue. Each photo is counted once.',
   'Cuando una foto lleva más de una hora pendiente, Trabajo ahora incluye fotos que siguen en registros de instalación y en la cola de carga. Cada foto se cuenta una sola vez.',
   null)
on conflict (id) do nothing;
