-- Sequential bounded photo ZIP saving; default manual and receipt modes remain.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values ('2026-10-07-photo-zip-batch', date '2026-10-07', array[0, 1, 2, 3], 'improvement',
  'Save large photo exports as smaller ZIPs', 'Guardar exportaciones grandes en ZIP más pequeños',
  'In supported browsers, choose a folder once and save all selected job photos as smaller ZIP files, one after another. Each ZIP keeps photos organized by job. You can still download one ZIP at a time, and receipt exports remain separate.', 'En navegadores compatibles, elige una carpeta una vez y guarda las fotos seleccionadas en archivos ZIP más pequeños, uno tras otro. Cada ZIP mantiene las fotos organizadas por trabajo. También puedes descargar un ZIP a la vez; los recibos conservan su exportación separada.', '/photos')
on conflict (id) do nothing;
