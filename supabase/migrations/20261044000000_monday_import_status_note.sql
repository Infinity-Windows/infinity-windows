-- This client includes the new note ID; older phones keep it hidden.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-09-30-monday-file-status', '2026-09-30', array[1,2,3], 'improvement',
  'See which Monday files were added',
  'Ve cuáles archivos de Monday se añadieron',
  'The Plans page shows a result beside each Monday file you try to bring in. If a file fails, use Retry. Added plans and specs still need Read this file to extract their information.',
  'La página de planos muestra el resultado junto a cada archivo que intentas traer de Monday. Si falla, usa Reintentar. Los planos y las especificaciones añadidos aún necesitan Leer este archivo para extraer su información.',
  '/projects'
)
on conflict (id) do nothing;
