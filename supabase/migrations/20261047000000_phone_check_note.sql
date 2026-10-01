-- The client ID gate keeps this note hidden until the Phone Check build loads.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-phone-check', current_date, array[0,1,2,3], 'improvement',
  'Check your phone from Forge',
  'Revisa tu teléfono desde Forge',
  'In Settings > Diagnostics, test your microphone, camera, offline storage, and app connection. Each result tells you what to try next. Copy a report for support; the test recording and camera preview stay on this phone.',
  'En Ajustes > Diagnóstico, prueba el micrófono, la cámara, el almacenamiento sin conexión y la conexión de la app. Cada resultado te dice qué intentar. Copia un informe para soporte; el audio de prueba y la vista de cámara se quedan en este teléfono.',
  '/diagnostics'
)
on conflict (id) do nothing;
