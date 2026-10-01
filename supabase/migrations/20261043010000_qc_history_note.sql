-- Shown only when the installed frontend includes this history view.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  (
    '2026-09-30-qc-review-history', '2026-09-30', array[1,2,3], 'improvement',
    'See past QC decisions',
    'Consulta las revisiones de calidad anteriores',
    'Quality now shows earlier passes and callbacks, including who reviewed each unit when that name is on file. Open Review history on the Quality page.',
    'La página Calidad ahora muestra aprobaciones y devoluciones anteriores, incluido quién revisó cada unidad cuando ese nombre está registrado. Abre el historial de revisiones en la página Calidad.',
    '/qc'
  )
on conflict (id) do nothing;
