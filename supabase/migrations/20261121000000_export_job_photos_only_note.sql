-- Release note: export content choice, job photos only or receipts only.
--
-- One new app_release_notes row only. No existing row, policy or grant is
-- touched; ON CONFLICT DO NOTHING keeps a reapply from rewriting the row.
-- The client shows it only in builds that list the id in
-- app/src/lib/appUpdates.ts INCLUDED_UPDATE_IDS.

insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-06-export-job-photos-only',
  date '2026-10-06',
  array[0, 1, 2, 3],
  'improvement',
  'Export job photos without receipts',
  'Exportar fotos del trabajo sin recibos',
  'When you export, choose Job photos only to get regular job photos with receipt captures left out, or Receipts only to export just receipts. PDF receipts still include the original document.',
  'Al exportar, elige Solo fotos del trabajo para obtener las fotos normales del trabajo sin los recibos, o Solo recibos para exportar solo recibos. Los recibos PDF siguen incluyendo el documento original.',
  '/photos'
)
on conflict (id) do nothing;
