-- Older builds ignore this immutable ID until their frontend includes the flow.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-10-01-qc-review-flow', '2026-10-01', array[1,2,3], 'improvement',
  'Review Quality checks one job at a time',
  'Revisa los controles de Calidad por trabajo',
  'Choose a job in Quality, find a unit, and move between units without losing your place. Review the unit’s saved photos and voice memos beside Pass and Callback. A failed save keeps the unit open; a changed review asks you to refresh before deciding again.',
  'Elige un trabajo en Calidad, busca una unidad y cambia entre unidades sin perder tu lugar. Revisa las fotos y notas de voz guardadas junto a Aprobar y Devolución. Si falla el guardado, la unidad sigue abierta; si la revisión cambió, se te pide actualizar antes de volver a decidir.',
  '/qc'
) on conflict (id) do nothing;
