-- Included only by clients containing the scheduling warning improvement.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values (
  '2026-09-30-schedule-conflict-details', '2026-09-30', array[1,2,3], 'fix',
  'See which scheduling hours overlap',
  'Ve qué horas del horario se traslapan',
  'Scheduling separates overlapping crew hours from hours that need review. Overlaps show both jobs and the shared hours. Missing or invalid times ask you to check the hours. Supervisors and owners can use Fix to edit the assignment.',
  'La programación separa las horas de la cuadrilla que se traslapan de las horas que necesitan revisión. Los traslapes muestran ambos trabajos y las horas compartidas. Si faltan horas o no son válidas, te pide revisarlas. Los supervisores y propietarios pueden usar Resolver para editar la asignación.',
  '/scheduling'
)
on conflict (id) do nothing;
