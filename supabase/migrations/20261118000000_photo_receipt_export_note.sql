-- Release note: photo and receipt export (PR 757, standalone release).
--
-- One new app_release_notes row only. No existing row, policy or grant is
-- touched; ON CONFLICT DO NOTHING keeps a reapply from rewriting the row.
-- The client shows it only in builds that list the id in
-- app/src/lib/appUpdates.ts INCLUDED_UPDATE_IDS.

insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-06-photo-receipt-export',
  date '2026-10-06',
  array[0, 1, 2, 3],
  'improvement',
  'Export photos and receipts',
  'Exportar fotos y recibos',
  'Choose a job and custom dates, select saved files, then download a ZIP or single files, or share them from your phone to email or another app. PDF receipts include the original document.',
  'Elige un trabajo y fechas personalizadas, selecciona archivos guardados y descarga un ZIP o archivos sueltos, o compártelos desde tu teléfono por correo u otra app. Los recibos PDF incluyen el documento original.',
  '/photos'
)
on conflict (id) do nothing;
