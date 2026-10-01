-- Role-scoped, one-time announcement. The client allowlist keeps this hidden
-- until the matching QC command is in the installed app build.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-09-30-qc-review-record', '2026-09-30', array[1,2,3], 'fix',
  'QC sign-offs now keep a review record',
  'Las aprobaciones de calidad ahora guardan un historial',
  'Pass and Callback now record the reviewer and keep each new decision. Only foremen and above can sign off; pending install points update with the decision.',
  'Aprobar y solicitar corrección ahora registran quién revisó y conservan cada decisión nueva. Solo capataces y superiores pueden aprobar; los puntos pendientes se actualizan con la decisión.',
  '/qc'
)
on conflict (id) do nothing;
