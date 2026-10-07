-- Project-grouped photo exports and bounded numbered ZIP parts.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-07-job-grouped-photo-exports',
  date '2026-10-07',
  array[0, 1, 2, 3],
  'improvement',
  'Export photos organized by job',
  'Exportar fotos organizadas por trabajo',
  'Choose jobs and dates, then export regular job photos in a separate folder for each job. Larger selections are prepared in numbered ZIP parts: save or share each part, then continue. Receipts stay in their separate export choice.',
  'Elige trabajos y fechas y exporta las fotos normales en una carpeta por trabajo. Las selecciones grandes se preparan en partes ZIP numeradas: guarda o comparte cada parte y luego continúa. Los recibos conservan su opción de exportación separada.',
  '/photos'
)
on conflict (id) do nothing;
