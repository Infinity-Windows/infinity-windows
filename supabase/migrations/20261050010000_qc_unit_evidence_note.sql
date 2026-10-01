-- Visible only in frontend builds that include the QC unit-evidence panel.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-qc-unit-evidence', '2026-10-01', array[1,2,3], 'improvement',
  'Review unit photos and voice memos in Quality',
  'Revisa fotos y notas de voz de la unidad en Calidad',
  'Open View unit details on a Quality check or past review to see the unit’s information, saved photos, original voice recordings and installation notes. Refresh the record to check for newly uploaded files.',
  'Abre Ver detalles de la unidad en una revisión de Calidad o en el historial para ver la información de la unidad, las fotos guardadas, las grabaciones originales y las notas de instalación. Actualiza el registro para buscar archivos recién subidos.',
  '/qc'
) on conflict (id) do nothing;
